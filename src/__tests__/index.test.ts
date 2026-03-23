// Top-level mock function shared across all tests (must start with 'mock' for jest hoisting)
const mockLlmInvoke = jest.fn().mockResolvedValue({
  content: "Hello! I'm doing well, thank you for asking.",
  tool_calls: [],
});

// Mock the ChatMistralAI class before importing
jest.mock("@langchain/mistralai", () => {
  return {
    ChatMistralAI: jest.fn().mockImplementation(() => {
      return {
        bindTools: jest.fn().mockReturnValue({
          invoke: mockLlmInvoke,
        }),
        invoke: mockLlmInvoke,
        pipe: jest.fn(function (this: any) {
          return { invoke: mockLlmInvoke };
        }),
      };
    }),
  };
});

// Set environment variable before importing
process.env.MISTRAL_API_KEY = "test-api-key";

import { agentExecutor } from "../index";
import { appConfig } from "../config";

describe("Agent Loop", () => {
  beforeEach(() => {
    // Restore default (no-tool-call) behaviour before every test
    mockLlmInvoke.mockReset();
    mockLlmInvoke.mockResolvedValue({
      content: "Hello! I'm doing well, thank you for asking.",
      tool_calls: [],
    });
  });

  it("should initialize and respond to a simple query", async () => {
    const result = await agentExecutor.invoke("Hello, how are you?");
    expect(result.output).toBeDefined();
    expect(typeof result.output).toBe("string");
  });

  // --- Iterative loop tests (Task 1.1) ---

  it("should return a direct response when the LLM makes 0 tool calls", async () => {
    mockLlmInvoke.mockResolvedValueOnce({ content: "Direct answer", tool_calls: [] });

    const result = await agentExecutor.invoke("Simple question");

    expect(result.output).toBe("Direct answer");
    expect(mockLlmInvoke).toHaveBeenCalledTimes(1);
  });

  it("should iterate through 1 round of tool calls before returning the final response", async () => {
    // First LLM call requests a tool; second call returns the final answer
    mockLlmInvoke
      .mockResolvedValueOnce({
        content: "",
        tool_calls: [{ id: "call_1", name: "search", args: { query: "test" } }],
      })
      .mockResolvedValueOnce({ content: "Answer after search", tool_calls: [] });

    const result = await agentExecutor.invoke("Search for something");

    expect(result.output).toBe("Answer after search");
    expect(mockLlmInvoke).toHaveBeenCalledTimes(2);
  });

  it("should iterate through 3 consecutive rounds of tool calls", async () => {
    const toolCallResponse = {
      content: "",
      tool_calls: [{ id: "call_1", name: "search", args: { query: "step" } }],
    };

    // Three rounds of tool calls, then the final answer
    mockLlmInvoke
      .mockResolvedValueOnce(toolCallResponse)
      .mockResolvedValueOnce(toolCallResponse)
      .mockResolvedValueOnce(toolCallResponse)
      .mockResolvedValueOnce({ content: "Final answer after 3 rounds", tool_calls: [] });

    const result = await agentExecutor.invoke("Multi-step query");

    expect(result.output).toBe("Final answer after 3 rounds");
    expect(mockLlmInvoke).toHaveBeenCalledTimes(4); // 3 tool rounds + 1 final
  });

  it("should return a warning message when MAX_ITERATIONS is reached", async () => {
    const originalMax = appConfig.maxIterations;
    appConfig.maxIterations = 3; // Use a small limit so the test runs quickly

    // Always return tool calls — the loop must terminate via the guard
    mockLlmInvoke.mockResolvedValue({
      content: "Still thinking...",
      tool_calls: [{ id: "call_1", name: "search", args: { query: "loop" } }],
    });

    try {
      const result = await agentExecutor.invoke("Infinite query");

      expect(result.output).toMatch(/\[Warning: Maximum iterations reached\]/);
      expect(mockLlmInvoke).toHaveBeenCalledTimes(3); // exactly MAX_ITERATIONS calls
    } finally {
      appConfig.maxIterations = originalMax;
    }
  });
});