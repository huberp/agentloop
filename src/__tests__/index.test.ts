// Mock the ChatMistralAI class before importing
jest.mock("@langchain/mistralai", () => {
  return {
    ChatMistralAI: jest.fn().mockImplementation(() => {
      return {
        invoke: jest.fn().mockResolvedValue({
          content: "Hello! I'm doing well, thank you for asking.",
        }),
        pipe: jest.fn(function(this: any) {
          return {
            invoke: jest.fn().mockResolvedValue({
              content: "Hello! I'm doing well, thank you for asking.",
            }),
          };
        }),
      };
    }),
  };
});

// Set environment variable before importing
process.env.MISTRAL_API_KEY = "test-api-key";

import { agentExecutor } from "../index";

describe("Agent Loop", () => {
  it("should initialize and respond to a simple query", async () => {
    const result = await agentExecutor.invoke("Hello, how are you?");
    expect(result.output).toBeDefined();
    expect(typeof result.output).toBe("string");
  });
});