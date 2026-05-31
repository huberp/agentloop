import { InMemoryChatMessageHistory } from "@langchain/core/chat_history";
import { HumanMessage, AIMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

import { logger } from "../logger";
import { appConfig } from "../config";
import { createLLM } from "../llm";
import { ToolRegistry } from "../tools/registry";
import { prepareToolArgs, validatePreparedToolArgs } from "../tools/arg-repair";
import type { SubagentDefinition, SubagentResult } from "./types";

/**
 * Render shared context as a read-only JSON block for inclusion in system prompts.
 * Returns an empty string when the context is absent or empty.
 */
function formatSharedContext(sharedContext?: Record<string, unknown>): string {
  if (!sharedContext || Object.keys(sharedContext).length === 0) return "";
  return (
    `\n\n--- Shared Context (read-only) ---\n` +
    `${JSON.stringify(sharedContext, null, 2)}\n` +
    `--- End Shared Context ---`
  );
}

/**
 * Build a minimal default system prompt for a subagent when no custom prompt
 * is provided via `SubagentDefinition.systemPrompt`.
 * Appends any shared context as a read-only JSON block.
 */
function buildDefaultSystemPrompt(
  name: string,
  tools: string[],
  sharedContext?: Record<string, unknown>
): string {
  const toolList =
    tools.length > 0 ? `Available tools: ${tools.join(", ")}.` : "No tools available.";
  return (
    `You are a specialized AI subagent named "${name}".\n` +
    `${toolList}\n` +
    `Be concise and focused on your assigned task.` +
    formatSharedContext(sharedContext)
  );
}

/**
 * Detect whether a tool output indicates execution failure.
 *
 * Recognizes:
 * - internal tool execution errors (prefixed "Tool error:")
 * - structured `{ success: false }` payloads
 * - structured non-zero `{ exitCode }` / `{ exit_code }` payloads
 */
function detectToolFailure(output: string): string | undefined {
  const trimmed = output.trim();

  if (trimmed.startsWith("Tool error:")) {
    return trimmed;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }

  const record = parsed as Record<string, unknown>;

  if (record.success === false) {
    const reason = typeof record.error === "string" ? record.error : "Tool returned success:false";
    return reason;
  }

  let exitCodeRaw: number | undefined;
  if (typeof record.exitCode === "number") {
    exitCodeRaw = record.exitCode;
  } else if (typeof record.exit_code === "number") {
    exitCodeRaw = record.exit_code;
  }
  if (typeof exitCodeRaw === "number" && exitCodeRaw !== 0) {
    return `Tool returned non-zero exit code ${exitCodeRaw}`;
  }

  return undefined;
}

/**
 * Run a subagent: an isolated agent loop with its own message history,
 * filtered tool set, and iteration budget.
 *
 * Subagents are fully isolated from the parent agent — they do not share
 * message history and only have access to the tools listed in `definition.tools`.
 *
 * @param definition  Subagent configuration (name, allowed tools, maxIterations, …).
 * @param task        The task string sent to the subagent as its first user message.
 * @param registry    The parent ToolRegistry; only tools listed in `definition.tools` are exposed.
 * @param llm         Optional LLM instance — created via `createLLM(appConfig)` when omitted.
 *                    Inject a mock in tests to avoid real API calls.
 */
export async function runSubagent(
  definition: SubagentDefinition,
  task: string,
  registry: ToolRegistry,
  llm?: BaseChatModel
): Promise<SubagentResult> {
  const agentLlm = llm ?? createLLM(appConfig);

  // Build a filtered registry containing only the tools the subagent is allowed to use
  const filteredRegistry = new ToolRegistry();
  for (const toolName of definition.tools) {
    const def = registry.getDefinition(toolName);
    if (def) {
      filteredRegistry.register(def);
    }
  }

  // Validate tool-binding support; subagents require an LLM that can call tools
  if (!agentLlm.bindTools) {
    throw new Error(
      `LLM provider does not support tool binding — subagent "${definition.name}" cannot run`
    );
  }
  const llmWithTools = agentLlm.bindTools(filteredRegistry.toLangChainTools());
  const chatHistory = new InMemoryChatMessageHistory();
  await chatHistory.addMessage(new HumanMessage(task));

  const systemMessage = new SystemMessage(
    definition.systemPrompt ??
      buildDefaultSystemPrompt(
        definition.name,
        filteredRegistry.list().map((t) => t.name),
        definition.sharedContext
      )
  );

  let iteration = 0;
  // Accumulates file paths mutated by tool calls in this run
  const filesModified: string[] = [];

  while (true) {
    iteration++;

    const messages = await chatHistory.getMessages();
    const llmCallStart = Date.now();
    const response = (await llmWithTools.invoke([
      systemMessage,
      ...messages,
    ])) as AIMessage;
    const llmDurationMs = Date.now() - llmCallStart;

    const toolCalls = response.tool_calls ?? [];

    logger.info(
      {
        subagent: definition.name,
        iteration,
        llmDurationMs,
        toolCallCount: toolCalls.length,
        toolCalls: toolCalls.map((c) => ({ name: c.name, args: c.args })),
      },
      "Subagent loop iteration"
    );

    if (toolCalls.length === 0) {
      // Subagent finished — extract and return the final text response
      const output =
        typeof response.content === "string" ? response.content : JSON.stringify(response.content);
      logger.info({ subagent: definition.name, iteration, output }, "Subagent final response");
      return { name: definition.name, output, iterations: iteration, filesModified };
    }

    if (iteration >= definition.maxIterations) {
      // Guard: stop and return with a warning instead of looping forever
      const output =
        typeof response.content === "string" ? response.content : JSON.stringify(response.content);
      logger.warn(
        { subagent: definition.name, iteration },
        "Subagent MAX_ITERATIONS reached; terminating"
      );
      return {
        name: definition.name,
        output: `[Warning: Maximum iterations reached] ${output}`,
        iterations: iteration,
        filesModified,
      };
    }

    // Record the tool-calling AI message then execute each requested tool
    await chatHistory.addMessage(response);
    for (const call of toolCalls) {
      const selectedTool = filteredRegistry.get(call.name);
      let content: string;

      if (!selectedTool) {
        content = `Tool not found: ${call.name}`;
        logger.warn({ subagent: definition.name, tool: call.name }, "Tool not found");
      } else {
        const toolStart = Date.now();
        try {
          const toolDef = filteredRegistry.getDefinition(call.name);
          const preparedArgs = prepareToolArgs(call.name, call.args);
          validatePreparedToolArgs(toolDef, preparedArgs, call.args);

          const rawOutput = await selectedTool.invoke(preparedArgs);
          content = typeof rawOutput === "string" ? rawOutput : JSON.stringify(rawOutput);
          logger.info(
            {
              subagent: definition.name,
              tool: call.name,
              args: preparedArgs,
              durationMs: Date.now() - toolStart,
              result: content.length > 500 ? content.slice(0, 500) + "…" : content,
            },
            "Tool executed"
          );

          // Track file mutations for conflict detection in runParallel
          const mutatedFile = toolDef?.mutatesFile?.(preparedArgs as Record<string, unknown>);
          if (mutatedFile) filesModified.push(mutatedFile);
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          content = `Tool error: ${msg}`;
          logger.warn(
            { subagent: definition.name, tool: call.name, args: call.args, error: msg },
            "Tool execution error"
          );
        }
      }

      const toolFailure = detectToolFailure(content);
      if (toolFailure) {
        const failureMessage = `Tool ${call.name} failed: ${toolFailure}`;
        logger.warn(
          { subagent: definition.name, tool: call.name, reason: toolFailure },
          "Tool failure detected; failing subagent step"
        );
        return {
          name: definition.name,
          output: content,
          iterations: iteration,
          filesModified,
          failed: true,
          error: failureMessage,
        };
      }

      await chatHistory.addMessage(
        new ToolMessage({ content, tool_call_id: call.id ?? call.name })
      );
    }
  }
}
