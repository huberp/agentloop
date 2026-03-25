import { HumanMessage, AIMessage, ToolMessage } from "@langchain/core/messages";
import type { AIMessageChunk } from "@langchain/core/messages";
import type { Runnable } from "@langchain/core/runnables";
import type { BaseChatMessageHistory } from "@langchain/core/chat_history";
import type { BaseLanguageModelInput } from "@langchain/core/language_models/base";
import type { SystemMessage } from "@langchain/core/messages";
import { ToolRegistry } from "./tools/registry";
import { ToolPermissionManager } from "./security";
import { invokeWithTimeout } from "./retry";
import { ToolBlockedError } from "./errors";
import { logger } from "./logger";
import type { Tracer } from "./observability";
import { newInvocationId } from "./observability";
import { trimMessages } from "./context";

/** A partially-accumulated tool call built from streaming ToolCallChunks. */
interface AccumulatedToolCall {
  id: string;
  name: string;
  /** Raw JSON string fragments joined across chunks. */
  args: string;
}

/** All dependencies needed by the streaming loop (injected for testability). */
export interface StreamingDeps {
  llmWithTools: Runnable<BaseLanguageModelInput, AIMessageChunk>;
  toolRegistry: ToolRegistry;
  permissionManager: ToolPermissionManager;
  chatHistory: BaseChatMessageHistory;
  systemMessage: SystemMessage;
  tracer: Tracer;
  maxIterations: number;
  maxContextTokens: number;
  toolTimeoutMs: number;
}

/**
 * Streaming agentic loop.
 *
 * Calls the LLM via `.stream()`, yields plain-text chunks as they arrive, and
 * buffers ToolCallChunks until each tool call is fully assembled before
 * executing it.  After tool execution the loop continues, streaming the next
 * LLM turn, until the model returns no tool calls or MAX_ITERATIONS is reached.
 *
 * @param input  The user message to process.
 * @param deps   Injected dependencies (LLM, tools, history, config).
 */
export async function* streamWithTools(
  input: string,
  deps: StreamingDeps
): AsyncGenerator<string> {
  const {
    llmWithTools,
    toolRegistry,
    permissionManager,
    chatHistory,
    systemMessage,
    tracer,
    maxIterations,
    maxContextTokens,
    toolTimeoutMs,
  } = deps;

  await chatHistory.addMessage(new HumanMessage(input));

  const invocationId = newInvocationId();
  tracer.startInvocation(invocationId, input);

  let iteration = 0;

  try {
    while (true) {
      iteration++;

      const messages = await chatHistory.getMessages();
      const trimmed = trimMessages([systemMessage, ...messages], maxContextTokens);

      const llmCallStart = Date.now();

      // Stream the LLM response — chunks carry content strings and/or tool_call_chunks
      const responseStream = await llmWithTools.stream(trimmed);

      let accumulatedContent = "";
      // Map from tool-call chunk index → accumulated partial call
      const pendingToolCalls = new Map<number, AccumulatedToolCall>();

      for await (const chunk of responseStream) {
        // Yield text tokens immediately so the caller can print them
        if (typeof chunk.content === "string" && chunk.content) {
          accumulatedContent += chunk.content;
          yield chunk.content;
        }

        // Accumulate tool call fragments by index; each index is one tool call
        for (const tc of chunk.tool_call_chunks ?? []) {
          const idx = tc.index ?? 0;
          if (!pendingToolCalls.has(idx)) {
            pendingToolCalls.set(idx, { id: "", name: "", args: "" });
          }
          const acc = pendingToolCalls.get(idx)!;
          if (tc.id) acc.id = tc.id;
          // Tool names arrive in a single chunk; assign rather than append
          if (tc.name) acc.name = tc.name;
          if (tc.args) acc.args += tc.args;
        }
      }

      const llmCallEnd = Date.now();

      // Assemble fully-streamed tool calls; ignore empty/incomplete entries
      const toolCalls = Array.from(pendingToolCalls.values())
        .filter((tc) => tc.name)
        .map((tc) => ({
          id: tc.id || tc.name,
          name: tc.name,
          args: (() => {
            try {
              return JSON.parse(tc.args || "{}");
            } catch {
              return {};
            }
          })(),
        }));

      tracer.recordLlmCall(invocationId, {
        startedAt: llmCallStart,
        endedAt: llmCallEnd,
        durationMs: llmCallEnd - llmCallStart,
        // Token counts are not available from streaming chunks in all providers
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        toolCallCount: toolCalls.length,
      });

      logger.info(
        { iteration, toolCallCount: toolCalls.length, toolCalls: toolCalls.map((c) => c.name) },
        "Streaming agent loop iteration"
      );

      if (toolCalls.length === 0) {
        // Final response — no more tool calls; persist and stop
        await chatHistory.addMessage(new AIMessage(accumulatedContent));
        break;
      }

      if (iteration >= maxIterations) {
        logger.warn({ iteration }, "MAX_ITERATIONS reached; terminating streaming agent loop");
        break;
      }

      // Persist the tool-calling AI turn, then execute each requested tool
      await chatHistory.addMessage(
        new AIMessage({ content: accumulatedContent, tool_calls: toolCalls })
      );

      for (const call of toolCalls) {
        const selectedTool = toolRegistry.get(call.name);

        logger.info(
          { toolName: call.name, toolCallId: call.id, arguments: call.args },
          "Invoking tool (streaming)"
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
            const definition = toolRegistry.getDefinition(call.name);
            if (definition) {
              await permissionManager.checkPermission(definition, call.args);
            }
            const rawOutput = await invokeWithTimeout(
              selectedTool.invoke(call.args),
              call.name,
              toolTimeoutMs
            );
            content = typeof rawOutput === "string" ? rawOutput : JSON.stringify(rawOutput);
            logger.info(
              { toolName: call.name, toolCallId: call.id, response: content },
              "Tool invocation completed (streaming)"
            );
          } catch (error) {
            toolSuccess = false;
            if (error instanceof ToolBlockedError) {
              toolError = error.message;
              content = `Tool blocked: ${error.message}`;
              logger.warn(
                { toolName: call.name, reason: error.message },
                "Tool blocked (streaming)"
              );
            } else {
              const msg = error instanceof Error ? error.message : String(error);
              toolError = msg;
              content = `Tool error: ${msg}`;
              logger.error(
                { toolName: call.name, error: msg },
                "Tool invocation failed (streaming)"
              );
            }
          }
        }

        tracer.recordToolExecution(invocationId, {
          startedAt: toolStart,
          endedAt: Date.now(),
          durationMs: Date.now() - toolStart,
          toolName: call.name,
          callId: call.id,
          success: toolSuccess,
          error: toolError,
        });

        await chatHistory.addMessage(
          new ToolMessage({ content, tool_call_id: call.id })
        );
      }
    }
  } finally {
    await tracer.endInvocation(invocationId);
  }
}
