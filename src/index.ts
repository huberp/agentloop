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
import { countTokens, trimMessages } from "./context";
import { withRetry, invokeWithTimeout } from "./retry";
import { ToolExecutionError, ToolBlockedError } from "./errors";
import { ToolRegistry } from "./tools/registry";
import { ToolPermissionManager } from "./security";

// Instantiate the LLM and tool registry at module level
const llm = createLLM(appConfig);
export const toolRegistry = new ToolRegistry();

// Permission manager: enforces blocklist/allowlist and dangerous-tool confirmation
const permissionManager = new ToolPermissionManager({
  autoApproveAll: appConfig.autoApproveAll,
  toolAllowlist: appConfig.toolAllowlist,
  toolBlocklist: appConfig.toolBlocklist,
});

// LLM bound with tools — set during ensureInitialized() before first use
let _llmWithTools: Runnable<BaseLanguageModelInput, AIMessageChunk> | null = null;

// Lazy-init promise: loadFromDirectory + bindTools run exactly once
let _initPromise: Promise<void> | null = null;

/**
 * Load tools from the tools/ directory and bind them to the LLM.
 * Called automatically on the first invocation of executeWithTools().
 */
async function ensureInitialized(): Promise<void> {
  if (!_initPromise) {
    _initPromise = toolRegistry
      .loadFromDirectory(path.join(__dirname, "tools"))
      .then(() => {
        _llmWithTools = llm.bindTools!(toolRegistry.toLangChainTools());
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
async function executeWithTools(input: string) {
  // Ensure tools are loaded and LLM is bound on first call
  await ensureInitialized();
  await chatHistory.addMessage(new HumanMessage(input));

  const systemMessage = new SystemMessage(
    await getSystemPrompt({ tools: toolRegistry.list().map((t) => t.name) })
  );
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

    // Wrap the LLM call with retry + exponential back-off (rate-limit aware)
    const response = (await withRetry(
      () => _llmWithTools!.invoke(trimmed),
      { maxRetries: appConfig.llmRetryMax, baseDelayMs: appConfig.llmRetryBaseDelayMs }
    )) as AIMessage;
    const toolCalls = response.tool_calls ?? [];

    // Structured per-iteration log entry
    logger.info(
      {
        iteration,
        toolCallCount: toolCalls.length,
        toolCalls: toolCalls.map((call) => call.name),
      },
      "Agent loop iteration"
    );

    if (toolCalls.length === 0) {
      // LLM is done — no more tool calls requested
      const content = extractContent(response);
      await chatHistory.addMessage(new AIMessage(content));
      return { output: content };
    }

    if (iteration >= appConfig.maxIterations) {
      // Guard against infinite loops: return last response with a warning
      const content = extractContent(response);
      logger.warn({ iteration }, "MAX_ITERATIONS reached; terminating agent loop");
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

      let content: string;
      if (!selectedTool) {
        content = `Tool not found: ${call.name}`;
      } else {
        try {
          // Enforce permission policy (blocklist / allowlist / dangerous-tool confirmation)
          const definition = toolRegistry.getDefinition(call.name);
          if (definition) {
            await permissionManager.checkPermission(definition, call.args);
          }

          // Enforce per-tool timeout; on expiry ToolExecutionError is thrown
          const rawOutput = await invokeWithTimeout(
            selectedTool.invoke(call.args),
            call.name,
            appConfig.toolTimeoutMs
          );
          content = typeof rawOutput === "string" ? rawOutput : JSON.stringify(rawOutput);
          logger.info(
            { toolName: call.name, toolCallId: call.id ?? call.name, response: content },
            "Tool invocation completed"
          );
        } catch (error) {
          // Blocked tool: descriptive message injected as ToolMessage so LLM can reason about it
          if (error instanceof ToolBlockedError) {
            content = `Tool blocked: ${error.message}`;
            logger.warn(
              { toolName: call.name, toolCallId: call.id ?? call.name, reason: error.message },
              "Tool execution blocked by permission manager"
            );
          } else {
            // Tool failure: inject the error as a ToolMessage so the LLM can reason about it
            const msg = error instanceof Error ? error.message : String(error);
            content = `Tool error: ${msg}`;
            logger.error(
              { toolName: call.name, toolCallId: call.id ?? call.name, error: msg },
              "Tool invocation failed; injecting error as ToolMessage"
            );
          }
        }
      }

      await chatHistory.addMessage(
        new ToolMessage({ content, tool_call_id: call.id ?? call.name })
      );
    }
  }
}

// Export the executor for testing
export const agentExecutor = {
  invoke: executeWithTools,
};

// Main loop
async function main() {
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
      const result = await agentExecutor.invoke(input);
      console.log("Agent:", result.output);
    } catch (error) {
      console.error("Error:", error);
    }
  }

  readline.close();
}

// Only run main if this file is executed directly
if (require.main === module) {
  main().catch(console.error);
}