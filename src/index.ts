import { ChatMistralAI } from "@langchain/mistralai";
import { InMemoryChatMessageHistory } from "@langchain/core/chat_history";
import { HumanMessage, AIMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import { tools } from "./tools";
import { logger } from "./logger";
import { appConfig } from "./config";

// Initialize LLM with Mistral
const llm = new ChatMistralAI({
  apiKey: appConfig.mistralApiKey,
  temperature: 0.7,
});
const llmWithTools = llm.bindTools(tools);

// Initialize chat message history
const chatHistory = new InMemoryChatMessageHistory();

// Create a simple chain executor (since AgentExecutor is no longer available)
async function executeWithTools(input: string) {
  // Add user message to history
  await chatHistory.addMessage(new HumanMessage(input));

  // Get all messages from history
  const messages = await chatHistory.getMessages();
  const conversation = [new SystemMessage("You are a helpful AI assistant."), ...messages];

  // First pass: the model may answer directly or request tool calls.
  const response = await llmWithTools.invoke(conversation);
  const toolCalls = (response as AIMessage).tool_calls ?? [];

  logger.info(
    {
      input,
      requestedToolCount: toolCalls.length,
      requestedTools: toolCalls.map((call) => call.name),
    },
    "Model response processed"
  );

  if (toolCalls.length === 0) {
    const content =
      response && response.content !== undefined
        ? typeof response.content === "string"
          ? response.content
          : JSON.stringify(response.content)
        : "No response";

    await chatHistory.addMessage(new AIMessage(content));
    return { output: content };
  }

  await chatHistory.addMessage(response as AIMessage);

  for (const call of toolCalls) {
    const selectedTool = tools.find((t) => t.name === call.name);
    logger.info(
      {
        toolName: call.name,
        toolCallId: call.id ?? call.name,
        arguments: call.args,
      },
      "Invoking tool"
    );

    const rawOutput = selectedTool
      ? await selectedTool.invoke(call.args)
      : `Tool not found: ${call.name}`;
    const content = typeof rawOutput === "string" ? rawOutput : JSON.stringify(rawOutput);

    logger.info(
      {
        toolName: call.name,
        toolCallId: call.id ?? call.name,
        response: content,
      },
      "Tool invocation completed"
    );

    await chatHistory.addMessage(
      new ToolMessage({
        content,
        tool_call_id: call.id ?? call.name,
      })
    );
  }

  const updatedMessages = await chatHistory.getMessages();
  const finalResponse = await llmWithTools.invoke([
    new SystemMessage("You are a helpful AI assistant."),
    ...updatedMessages,
  ]);

  const finalContent =
    finalResponse && finalResponse.content !== undefined
      ? typeof finalResponse.content === "string"
        ? finalResponse.content
        : JSON.stringify(finalResponse.content)
      : "No response";

  await chatHistory.addMessage(new AIMessage(finalContent));
  return { output: finalContent };
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