import { ChatMistralAI } from "@langchain/mistralai";
import { InMemoryChatMessageHistory } from "@langchain/core/chat_history";
import { ChatPromptTemplate, MessagesPlaceholder } from "@langchain/core/prompts";
import { HumanMessage, AIMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import * as dotenv from "dotenv";

dotenv.config();

// Define tools using the modern tool() function
const searchTool = tool(
  async (query: string) => {
    // Mock implementation
    return `Search results for: ${query}`;
  },
  {
    name: "search",
    description: "Search the web for information",
  }
);

const calculateTool = tool(
  async (expression: string) => {
    // Mock implementation - note: eval is dangerous in production!
    try {
      return `Result of ${expression}: ${eval(expression)}`;
    } catch (error) {
      return `Error calculating ${expression}: ${error}`;
    }
  },
  {
    name: "calculate",
    description: "Perform calculations",
  }
);

const tools = [searchTool, calculateTool];

// Initialize LLM with Mistral
const llm = new ChatMistralAI({
  apiKey: process.env.MISTRAL_API_KEY,
  temperature: 0.7,
});

// Initialize chat message history
const chatHistory = new InMemoryChatMessageHistory();

// Create a simple chain executor (since AgentExecutor is no longer available)
async function executeWithTools(input: string) {
  // Add user message to history
  await chatHistory.addMessage(new HumanMessage(input));

  // Get all messages from history
  const messages = await chatHistory.getMessages();

  // Create prompt messages array
  const promptMessages: any[] = [["system", "You are a helpful AI assistant."]];

  // Add history messages
  for (const msg of messages) {
    if (msg._getType() === "human") {
      promptMessages.push(["human", msg.content as string]);
    } else if (msg._getType() === "ai") {
      promptMessages.push(["assistant", msg.content as string]);
    }
  }

  // Create prompt with history
  const prompt = ChatPromptTemplate.fromMessages(promptMessages);

  // Invoke LLM
  const chain = prompt.pipe(llm);
  const response = await chain.invoke({});

  // Extract content from response - handle undefined case
  let content = "No response";
  if (response && response.content !== undefined) {
    content = typeof response.content === "string"
      ? response.content
      : JSON.stringify(response.content);
  }

  // Add assistant response to history
  await chatHistory.addMessage(new AIMessage(content));

  return { output: content };
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