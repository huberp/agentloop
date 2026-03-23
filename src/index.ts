import { InMemoryChatMessageHistory } from "@langchain/core/chat_history";
import { HumanMessage, AIMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import { tools } from "./tools";
import { logger } from "./logger";
import { appConfig } from "./config";
import { createLLM } from "./llm";
import { getSystemPrompt } from "./prompts/system";
import { countTokens, trimMessages } from "./context";
import { withRetry, invokeWithTimeout } from "./retry";
import { ToolExecutionError } from "./errors";

// Instantiate the LLM via the provider factory (provider/model/temperature from appConfig)
const llm = createLLM(appConfig);
const llmWithTools = llm.bindTools!(tools);

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
  await chatHistory.addMessage(new HumanMessage(input));

  const systemMessage = new SystemMessage(
    await getSystemPrompt({ tools: tools.map((t) => t.name) })
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
      () => llmWithTools.invoke(trimmed),
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
      const selectedTool = tools.find((t) => t.name === call.name);

      logger.info(
        { toolName: call.name, toolCallId: call.id ?? call.name, arguments: call.args },
        "Invoking tool"
      );

      let content: string;
      if (!selectedTool) {
        content = `Tool not found: ${call.name}`;
      } else {
        try {
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
          // Tool failure: inject the error as a ToolMessage so the LLM can reason about it
          const msg = error instanceof Error ? error.message : String(error);
          content = `Tool error: ${msg}`;
          logger.error(
            { toolName: call.name, toolCallId: call.id ?? call.name, error: msg },
            "Tool invocation failed; injecting error as ToolMessage"
          );
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