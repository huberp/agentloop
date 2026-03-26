import { InMemoryChatMessageHistory } from "@langchain/core/chat_history";
import { HumanMessage, AIMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

import { logger } from "../logger";
import { appConfig } from "../config";
import { createLLM } from "../llm";
import { ToolRegistry } from "../tools/registry";
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
      { subagent: definition.name, iteration, llmDurationMs, toolCallCount: toolCalls.length },
      "Subagent loop iteration"
    );

    if (toolCalls.length === 0) {
      // Subagent finished — extract and return the final text response
      const output =
        typeof response.content === "string" ? response.content : JSON.stringify(response.content);
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
      } else {
        try {
          const rawOutput = await selectedTool.invoke(call.args);
          content = typeof rawOutput === "string" ? rawOutput : JSON.stringify(rawOutput);

          // Track file mutations for conflict detection in runParallel
          const toolDef = filteredRegistry.getDefinition(call.name);
          const mutatedFile = toolDef?.mutatesFile?.(call.args as Record<string, unknown>);
          if (mutatedFile) filesModified.push(mutatedFile);
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          content = `Tool error: ${msg}`;
        }
      }

      await chatHistory.addMessage(
        new ToolMessage({ content, tool_call_id: call.id ?? call.name })
      );
    }
  }
}
