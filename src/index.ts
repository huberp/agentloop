import * as path from "path";
import { InMemoryChatMessageHistory } from "@langchain/core/chat_history";
import { HumanMessage, AIMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import type { Runnable } from "@langchain/core/runnables";
import type { BaseLanguageModelInput } from "@langchain/core/language_models/base";
import type { AIMessageChunk } from "@langchain/core/messages";
import { logger } from "./logger";
import { appConfig } from "./config";
import { createLLM } from "./llm";
import { getSystemPrompt } from "./prompts/system";
import { promptRegistry } from "./prompts/registry";
import { skillRegistry } from "./skills/registry";
import { countTokens, trimMessages } from "./context";
import { withRetry, invokeWithTimeout } from "./retry";
import { ToolExecutionError, ToolBlockedError } from "./errors";
import { ToolRegistry, toolRegistry } from "./tools/registry";
import { ToolPermissionManager, ConcurrencyLimiter } from "./security";
import { getCachedPromptContext } from "./prompts/context";
import { registerMcpTools } from "./mcp/bridge";
import { agentProfileRegistry } from "./agents/registry";
import { activateProfile } from "./agents/activator";
import { routeRequest } from "./agents/coordinator";
import type { AgentRuntimeConfig } from "./agents/types";
import {
  type Tracer,
  NoopTracer,
  createTracer,
  newInvocationId,
} from "./observability";
import { streamWithTools } from "./streaming";
import { spinner } from "./spinner";
import { runInkTui } from "./ui/tui";

// Re-export the singleton tool registry (created in tools/registry.ts)
export { toolRegistry };

// Re-export the agent profile registry for use by external entry points (e.g. start-oneshot.ts)
export { agentProfileRegistry };

/** Options accepted by the public agent executor API. */
export interface AgentRunOptions {
  /** When set, replaces the auto-generated system prompt for this invocation. */
  systemPromptOverride?: string;
}

// Instantiate the LLM at module level
const llm = createLLM(appConfig);

// Permission manager: enforces blocklist/allowlist and dangerous-tool confirmation
const permissionManager = new ToolPermissionManager({
  autoApproveAll: appConfig.autoApproveAll,
  toolAllowlist: appConfig.toolAllowlist,
  toolBlocklist: appConfig.toolBlocklist,
});

// Concurrency limiter: caps simultaneous tool executions (0 = unlimited)
const concurrencyLimiter = new ConcurrencyLimiter(appConfig.maxConcurrentTools);

// LLM bound with tools — set during ensureInitialized() before first use
let _llmWithTools: Runnable<BaseLanguageModelInput, AIMessageChunk> | null = null;

// Lazy-init promise: loadFromDirectory + bindTools run exactly once
let _initPromise: Promise<void> | null = null;

// Active tracer — defaults to no-op; created lazily from config on first invocation
let _tracer: Tracer | null = null;

/**
 * Override the active tracer. Useful in tests to inject a FileTracer
 * pointing at a temp directory without reloading the module.
 */
export function setTracer(t: Tracer): void {
  _tracer = t;
}

/** Return the active tracer, creating it from config on first access. */
function getTracer(): Tracer {
  if (!_tracer) {
    _tracer = createTracer({
      enabled: appConfig.tracingEnabled,
      outputDir: appConfig.traceOutputDir,
      costPerInputTokenUsd: appConfig.tracingCostPerInputTokenUsd,
      costPerOutputTokenUsd: appConfig.tracingCostPerOutputTokenUsd,
    });
  }
  return _tracer;
}

/**
 * Load tools from the tools/ directory and bind them to the LLM.
 * Called automatically on the first invocation of executeWithTools().
 * Also exported so that external entry points (e.g. start-oneshot.ts) can
 * eagerly initialise the tool registry before invoking tools directly.
 */
export async function ensureInitialized(): Promise<void> {
  if (!_initPromise) {
    _initPromise = toolRegistry
      .loadFromDirectory(path.join(__dirname, "tools"))
      .then(async () => {
        // Connect to configured MCP servers and register their tools
        if (appConfig.mcpServers.length > 0) {
          await registerMcpTools(appConfig.mcpServers, toolRegistry);
        }
        _llmWithTools = llm.bindTools!(toolRegistry.toLangChainTools());

        // Load user-supplied prompt templates from configured directory
        if (appConfig.promptTemplatesDir) {
          await promptRegistry.loadFromDirectory(appConfig.promptTemplatesDir);
        }
        await promptRegistry.loadHistory();
        if (appConfig.skillsDir) {
          await skillRegistry.loadFromDirectory(appConfig.skillsDir);
        }
        const builtinSkillsDir = path.join(__dirname, "skills", "builtin");
        await skillRegistry.loadFromDirectory(builtinSkillsDir);
        if (appConfig.agentProfilesDir) {
          await agentProfileRegistry.loadFromDirectory(appConfig.agentProfilesDir);
        }
        // Auto-load builtin agent profiles (Task 7.3)
        const builtinAgentProfilesDir = path.join(__dirname, "agents", "builtin");
        await agentProfileRegistry.loadFromDirectory(builtinAgentProfilesDir);
      });
  }
  return _initPromise;
}

// Initialize chat message history
const chatHistory = new InMemoryChatMessageHistory();

/** Extract a plain string from an AIMessage content (string or complex objects). */
function extractContent(msg: AIMessage): string {
  if (msg.content === undefined) return "No response";
  if (typeof msg.content === "string") return msg.content;
  return JSON.stringify(msg.content);
}

/**
 * Agentic loop: invoke the LLM repeatedly until it returns a response with no
 * tool calls, or until MAX_ITERATIONS is reached.
 */
async function executeWithTools(input: string, profileName?: string, runOptions?: AgentRunOptions) {
  // Ensure tools are loaded and LLM is bound on first call
  await ensureInitialized();
  await chatHistory.addMessage(new HumanMessage(input));

  // Resolve agent profile and apply runtime overrides
  let runtimeConfig: AgentRuntimeConfig | undefined;
  if (profileName) {
    const profile = agentProfileRegistry.get(profileName);
    if (!profile) {
      logger.warn({ profileName }, "Requested agent profile not found, using defaults");
    } else {
      runtimeConfig = activateProfile(profile);
    }
  } else if (appConfig.coordinatorEnabled) {
    // Auto-route: use the coordinator to select the best profile for this request
    const routedProfile = await routeRequest(input, agentProfileRegistry, toolRegistry, llm);
    if (routedProfile) {
      logger.info({ profileName: routedProfile.name }, "Coordinator auto-selected agent profile");
      runtimeConfig = activateProfile(routedProfile);
    }
  }

  // Determine per-run LLM and tool binding
  let llmForRun = _llmWithTools!;
  if (runtimeConfig) {
    const needsNewLlm =
      runtimeConfig.model !== undefined || runtimeConfig.temperature !== undefined;
    const baseLlm = needsNewLlm
      ? createLLM({
          ...appConfig,
          ...(runtimeConfig.model !== undefined && { llmModel: runtimeConfig.model }),
          ...(runtimeConfig.temperature !== undefined && {
            llmTemperature: runtimeConfig.temperature,
          }),
        })
      : llm;
    const allLangChainTools = toolRegistry.toLangChainTools();
    const toolsForRun =
      runtimeConfig.activeTools.length > 0
        ? allLangChainTools.filter((t) => runtimeConfig!.activeTools.includes(t.name))
        : allLangChainTools;
    llmForRun = baseLlm.bindTools!(toolsForRun);
  }

  const effectiveMaxIterations = runtimeConfig?.maxIterations ?? appConfig.maxIterations;

  // Start an invocation trace (no-op when tracing is disabled)
  const invocationId = newInvocationId();
  getTracer().startInvocation(invocationId, input);

  // Aggregate runtime context: workspace, tools, active instructions (TTL-cached)
  const promptCtx = await getCachedPromptContext();
  const systemMessageText = runOptions?.systemPromptOverride
    ? runOptions.systemPromptOverride
    : await getSystemPrompt({
        tools: promptCtx.tools.map((t) => t.name),
        workspace: promptCtx.workspace,
        instructions: promptCtx.instructions,
        skills: promptCtx.skills,
      });
  const systemMessage = new SystemMessage(systemMessageText);
  let iteration = 0;

  while (true) {
    iteration++;

    const messages = await chatHistory.getMessages();
    const fullContext = [systemMessage, ...messages];

    // Trim context to stay within MAX_CONTEXT_TOKENS before calling the LLM
    const tokensBefore = countTokens(fullContext);
    const trimmed = trimMessages(fullContext, appConfig.maxContextTokens);
    const dropped = fullContext.length - trimmed.length;
    if (dropped > 0) {
      logger.info(
        { dropped, tokensBefore, tokensAfter: countTokens(trimmed) },
        "Context trimmed to fit within MAX_CONTEXT_TOKENS"
      );
    }

    // Time the LLM call for the trace span
    const llmCallStart = Date.now();

    // Wrap the LLM call with retry + exponential back-off (rate-limit aware)
    const response = (await withRetry(
      () => llmForRun.invoke(trimmed),
      { maxRetries: appConfig.llmRetryMax, baseDelayMs: appConfig.llmRetryBaseDelayMs }
    )) as AIMessage;

    const llmCallEnd = Date.now();
    const toolCalls = response.tool_calls ?? [];

    // Extract token usage from the response metadata when available
    const usageMetadata = (response as any).usage_metadata;
    const promptTokens: number = usageMetadata?.input_tokens ?? 0;
    const completionTokens: number = usageMetadata?.output_tokens ?? 0;

    getTracer().recordLlmCall(invocationId, {
      startedAt: llmCallStart,
      endedAt: llmCallEnd,
      durationMs: llmCallEnd - llmCallStart,
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      toolCallCount: toolCalls.length,
    });

    // Structured per-iteration log entry — includes LLM timing and token usage
    logger.info(
      {
        iteration,
        llmDurationMs: llmCallEnd - llmCallStart,
        promptTokens,
        completionTokens,
        toolCallCount: toolCalls.length,
        toolCalls: toolCalls.map((call) => call.name),
      },
      "Agent loop iteration"
    );

    if (toolCalls.length === 0) {
      // LLM is done — no more tool calls requested
      const content = extractContent(response);
      await chatHistory.addMessage(new AIMessage(content));
      await getTracer().endInvocation(invocationId);
      return { output: content };
    }

    if (iteration >= effectiveMaxIterations) {
      // Guard against infinite loops: return last response with a warning
      const content = extractContent(response);
      logger.warn({ iteration }, "MAX_ITERATIONS reached; terminating agent loop");
      await getTracer().endInvocation(invocationId);
      return { output: `[Warning: Maximum iterations reached] ${content}` };
    }

    // Record the tool-calling AI message and execute each requested tool
    await chatHistory.addMessage(response);
    for (const call of toolCalls) {
      const selectedTool = toolRegistry.get(call.name);

      logger.info(
        { toolName: call.name, toolCallId: call.id ?? call.name, arguments: call.args },
        "Invoking tool"
      );

      const toolStart = Date.now();
      let toolSuccess = true;
      let toolError: string | undefined;
      let content: string;

      if (!selectedTool) {
        content = `Tool not found: ${call.name}`;
        toolSuccess = false;
        toolError = content;
      } else {
        try {
          // Enforce permission policy (blocklist / allowlist / dangerous-tool confirmation)
          const definition = toolRegistry.getDefinition(call.name);
          if (definition) {
            await permissionManager.checkPermission(definition, call.args);
          }

          // Enforce per-tool timeout and concurrency limit; on expiry ToolExecutionError is thrown
          // Prefer the per-tool timeout override; fall back to the global TOOL_TIMEOUT_MS.
          const effectiveTimeout = definition?.timeout ?? appConfig.toolTimeoutMs;
          const rawOutput = await concurrencyLimiter.run(() =>
            invokeWithTimeout(
              selectedTool.invoke(call.args),
              call.name,
              effectiveTimeout
            )
          );
          content = typeof rawOutput === "string" ? rawOutput : JSON.stringify(rawOutput);
          logger.info(
            { toolName: call.name, toolCallId: call.id ?? call.name, response: content },
            "Tool invocation completed"
          );
        } catch (error) {
          toolSuccess = false;
          // Blocked tool: descriptive message injected as ToolMessage so LLM can reason about it
          if (error instanceof ToolBlockedError) {
            toolError = error.message;
            content = `Tool blocked: ${error.message}`;
            logger.warn(
              { toolName: call.name, toolCallId: call.id ?? call.name, reason: error.message },
              "Tool execution blocked by permission manager"
            );
          } else {
            // Tool failure: inject the error as a ToolMessage so the LLM can reason about it
            const msg = error instanceof Error ? error.message : String(error);
            toolError = msg;
            content = `Tool error: ${msg}`;
            logger.error(
              { toolName: call.name, toolCallId: call.id ?? call.name, error: msg },
              "Tool invocation failed; injecting error as ToolMessage"
            );
          }
        }
      }

      const toolEnd = Date.now();
      getTracer().recordToolExecution(invocationId, {
        startedAt: toolStart,
        endedAt: toolEnd,
        durationMs: toolEnd - toolStart,
        toolName: call.name,
        callId: call.id ?? call.name,
        success: toolSuccess,
        error: toolError,
      });

      await chatHistory.addMessage(
        new ToolMessage({ content, tool_call_id: call.id ?? call.name })
      );
    }
  }
}

/**
 * Streaming variant of executeWithTools.
 * Builds the dependency object from module-level state and delegates to streamWithTools.
 */
async function* executeWithToolsStream(input: string, profileName?: string, runOptions?: AgentRunOptions): AsyncGenerator<string> {
  await ensureInitialized();

  // Resolve agent profile and apply runtime overrides
  let runtimeConfig: AgentRuntimeConfig | undefined;
  if (profileName) {
    const profile = agentProfileRegistry.get(profileName);
    if (!profile) {
      logger.warn({ profileName }, "Requested agent profile not found, using defaults");
    } else {
      runtimeConfig = activateProfile(profile);
    }
  }

  // Determine per-run LLM and tool binding
  let llmWithToolsForRun = _llmWithTools!;
  if (runtimeConfig) {
    const needsNewLlm =
      runtimeConfig.model !== undefined || runtimeConfig.temperature !== undefined;
    const baseLlm = needsNewLlm
      ? createLLM({
          ...appConfig,
          ...(runtimeConfig.model !== undefined && { llmModel: runtimeConfig.model }),
          ...(runtimeConfig.temperature !== undefined && {
            llmTemperature: runtimeConfig.temperature,
          }),
        })
      : llm;
    const allLangChainTools = toolRegistry.toLangChainTools();
    const toolsForRun =
      runtimeConfig.activeTools.length > 0
        ? allLangChainTools.filter((t) => runtimeConfig!.activeTools.includes(t.name))
        : allLangChainTools;
    llmWithToolsForRun = baseLlm.bindTools!(toolsForRun);
  }

  const promptCtx = await getCachedPromptContext();
  const systemMessageText = runOptions?.systemPromptOverride
    ? runOptions.systemPromptOverride
    : await getSystemPrompt({
        tools: promptCtx.tools.map((t) => t.name),
        workspace: promptCtx.workspace,
        instructions: promptCtx.instructions,
        skills: promptCtx.skills,
      });
  const systemMessage = new SystemMessage(systemMessageText);

  yield* streamWithTools(input, {
    llmWithTools: llmWithToolsForRun,
    toolRegistry,
    permissionManager,
    chatHistory,
    systemMessage,
    tracer: getTracer(),
    maxIterations: runtimeConfig?.maxIterations ?? appConfig.maxIterations,
    maxContextTokens: appConfig.maxContextTokens,
    toolTimeoutMs: appConfig.toolTimeoutMs,
    concurrencyLimiter,
  });
}

// Export the executor for testing
export const agentExecutor = {
  invoke: executeWithTools,
  /**
   * Streaming variant: yields text chunks as they arrive from the LLM.
   * Tool calls are buffered until complete, executed, and then streaming resumes.
   */
  stream: executeWithToolsStream,
};

// Main loop
export async function main() {
  if (appConfig.uiMode === "tui") {
    await runInkTui(agentExecutor);
    return;
  }

  const readline = require("readline").createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log("Agent: Hello! I'm ready to help. Type 'exit' to quit.");

  while (true) {
    const input = await new Promise<string>((resolve) => {
      readline.question("User: ", resolve);
    });

    if (input.toLowerCase() === "exit") {
      console.log("Agent: Goodbye!");
      break;
    }

    try {
      if (appConfig.streamingEnabled) {
        // Streaming provides its own token-by-token feedback — no spinner needed.
        process.stdout.write("Agent: ");
        for await (const chunk of agentExecutor.stream(input)) {
          process.stdout.write(chunk);
        }
        process.stdout.write("\n");
      } else {
        spinner.start("Thinking…");
        const result = await agentExecutor.invoke(input);
        spinner.stop();
        console.log("Agent:", result.output);
      }
    } catch (error) {
      spinner.stop();
      console.error("Error:", error);
    }
  }

  readline.close();
}

// Only run main if this file is executed directly
if (require.main === module) {
  main().catch(console.error);
}