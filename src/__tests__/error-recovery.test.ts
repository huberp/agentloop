/**
 * Integration tests for Task 1.5 error handling in the agent loop:
 *   (c) tool throws  → error injected as ToolMessage, loop continues
 *   (d) tool timeout → timeout error injected as ToolMessage, loop continues
 */

// Must start with "mock" for jest hoisting
const mockLlmInvoke = jest.fn();
const mockToolInvoke = jest.fn();

// Mock the LLM provider
jest.mock("@langchain/mistralai", () => ({
  ChatMistralAI: jest.fn().mockImplementation(() => ({
    bindTools: jest.fn().mockReturnValue({ invoke: mockLlmInvoke }),
    invoke: mockLlmInvoke,
  })),
}));

// Mock ToolRegistry so tests control which tools are available and how they behave
jest.mock("../tools/registry", () => ({
  ToolRegistry: jest.fn().mockImplementation(() => ({
    register: jest.fn(),
    unregister: jest.fn(),
    get: jest.fn().mockImplementation((name: string) =>
      name === "search" ? { name: "search", invoke: mockToolInvoke } : undefined
    ),
    list: jest.fn().mockReturnValue([{ name: "search", description: "Search the web" }]),
    toLangChainTools: jest.fn().mockReturnValue([{ name: "search", invoke: mockToolInvoke }]),
    loadFromDirectory: jest.fn().mockResolvedValue(undefined),
  })),
}));

process.env.MISTRAL_API_KEY = "test-api-key";

import { agentExecutor } from "../index";
import { appConfig } from "../config";

/** Standard first LLM response: requests the "search" tool. */
const toolCallResponse = {
  content: "",
  tool_calls: [{ id: "call_1", name: "search", args: { query: "test" } }],
};

/** Standard second LLM response: final answer with no more tool calls. */
const finalResponse = { content: "Final answer", tool_calls: [] };

describe("Agent Loop — Error Handling & Recovery (Task 1.5)", () => {
  beforeEach(() => {
    mockLlmInvoke.mockReset();
    mockToolInvoke.mockReset();
  });

  // -------------------------------------------------------------------------
  // (c) Tool throws → error injected as ToolMessage, loop continues
  // -------------------------------------------------------------------------

  it("(c) tool throws: injects error as ToolMessage and continues to final answer", async () => {
    // LLM: first ask for a tool, then return final answer
    mockLlmInvoke
      .mockResolvedValueOnce(toolCallResponse)
      .mockResolvedValueOnce(finalResponse);

    // Tool throws on invocation
    mockToolInvoke.mockRejectedValueOnce(new Error("search API unavailable"));

    const result = await agentExecutor.invoke("Find something");

    // The loop must not crash and must return the LLM's final answer
    expect(result.output).toBe("Final answer");
    // Two LLM calls: one to request the tool, one after the error ToolMessage
    expect(mockLlmInvoke).toHaveBeenCalledTimes(2);
  });

  it("(c) tool not found: non-fatal — injects 'Tool not found' message and continues", async () => {
    mockLlmInvoke
      .mockResolvedValueOnce({
        content: "",
        tool_calls: [{ id: "call_1", name: "nonexistent", args: {} }],
      })
      .mockResolvedValueOnce(finalResponse);

    const result = await agentExecutor.invoke("Use a missing tool");

    expect(result.output).toBe("Final answer");
    expect(mockLlmInvoke).toHaveBeenCalledTimes(2);
  });

  it("(c) tool throws synchronously: loop survives and returns final answer", async () => {
    mockLlmInvoke
      .mockResolvedValueOnce(toolCallResponse)
      .mockResolvedValueOnce(finalResponse);

    // Synchronous throw via mockImplementation
    mockToolInvoke.mockImplementationOnce(() => {
      throw new Error("sync crash");
    });

    const result = await agentExecutor.invoke("Trigger sync crash");

    expect(result.output).toBe("Final answer");
    expect(mockLlmInvoke).toHaveBeenCalledTimes(2);
  });

  // -------------------------------------------------------------------------
  // (d) Tool timeout → timeout error injected as ToolMessage, loop continues
  // -------------------------------------------------------------------------

  it("(d) tool timeout: injects timeout error as ToolMessage and continues to final answer", async () => {
    jest.useFakeTimers();

    try {
      const originalTimeout = appConfig.toolTimeoutMs;
      appConfig.toolTimeoutMs = 200; // short timeout for the test

      mockLlmInvoke
        .mockResolvedValueOnce(toolCallResponse)
        .mockResolvedValueOnce(finalResponse);

      // Tool never resolves — simulates a hung external call
      mockToolInvoke.mockReturnValueOnce(new Promise(() => { /* intentionally never resolves to simulate hung tool */ }));

      const resultPromise = agentExecutor.invoke("Trigger timeout");

      // Advance all fake timers (fires the tool timeout) and flush micro-tasks
      await jest.runAllTimersAsync();

      const result = await resultPromise;

      expect(result.output).toBe("Final answer");
      // Two LLM calls: one to request the tool, one after the timeout ToolMessage
      expect(mockLlmInvoke).toHaveBeenCalledTimes(2);

      appConfig.toolTimeoutMs = originalTimeout;
    } finally {
      jest.useRealTimers();
    }
  });
});
