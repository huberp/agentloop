import { ChatMistralAI } from "@langchain/mistralai";
import { BufferMemory } from "@langchain/community/stores/memory/buffer";
import { ChatPromptTemplate, MessagesPlaceholder } from "@langchain/core/prompts";
import { HumanMessage, AIMessage } from "@langchain/core/messages";
import { Tool } from "@langchain/core/tools";
import { AgentExecutor, createOpenAIFunctionsAgent } from "@langchain/community/agents";
import * as dotenv from "dotenv";

dotenv.config();

// Define tools
const tools: Tool[] = [
  {
    name: "search",
    description: "Search the web for information",
    func: async (query: string) => {
      // Mock implementation
      return `Search results for: ${query}`;
    },
  },
  {
    name: "calculate",
    description: "Perform calculations",
    func: async (expression: string) => {
      // Mock implementation
      return `Result of ${expression}: ${eval(expression)}`;
    },
  },
];

// Initialize LLM with Mistral
const llm = new ChatMistralAI({
  apiKey: process.env.MISTRAL_API_KEY,
  model: "mistral-tiny",
  temperature: 0.7,
});

// Initialize memory
const memory = new BufferMemory({
  returnMessages: true,
  memoryKey: "chat_history",
});

// Create prompt
const prompt = ChatPromptTemplate.fromMessages([
  ["system", "You are a helpful AI assistant."],
  new MessagesPlaceholder("chat_history"),
  ["human", "{input}"],
  new MessagesPlaceholder("agent_scratchpad"),
]);

// Create agent
const agent = await createOpenAIFunctionsAgent({
  llm,
  tools,
  prompt,
});

// Create agent executor
export const agentExecutor = new AgentExecutor({
  agent,
  tools,
  memory,
});

// Main loop
async function main() {
  const readline = require("readline").createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  while (true) {
    const input = await new Promise<string>((resolve) => {
      readline.question("User: ", resolve);
    });

    if (input.toLowerCase() === "exit") {
      console.log("Agent: Goodbye!");
      break;
    }

    const result = await agentExecutor.invoke({
      input,
    });

    console.log("Agent:", result.output);
  }

  readline.close();
}

main().catch(console.error);