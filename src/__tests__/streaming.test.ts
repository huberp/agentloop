/**
 * Tests for Task 4.2: Streaming Response Support
 *
 * Covers:
 *  - Basic streaming: text chunks are yielded as they arrive
 *  - Tool call buffering: tool_call_chunks are accumulated, executed, and streaming resumes
 *  - MAX_ITERATIONS guard terminates the streaming loop
 *  - agentExecutor.stream surface is exposed alongside invoke
 */

// Top-level mock variable (must start with "mock" for Jest hoisting to work)
const mockLlmInvokeCompat = jest.fn().mockResolvedValue({
  content: "Hello from non-streaming!",
  tool_calls: [],
});

// Hoisted by Jest before any imports
jest.mock("@langchain/mistralai", () => ({
  ChatMistralAI: jest.fn().mockImplementation(() => ({
    bindTools: jest.fn().mockReturnValue({ invoke: mockLlmInvokeCompat }),
    invoke: mockLlmInvokeCompat,
  })),
}));

import { InMemoryChatMessageHistory } from "@langchain/core/chat_history";
import { SystemMessage } from "@langchain/core/messages";
import { streamWithTools, type StreamingDeps } from "../streaming";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Collect all yielded values from an AsyncGenerator into an array. */
async function collectChunks(gen: AsyncGenerator<string>): Promise<string[]> {
  const chunks: string[] = [];
  for await (const chunk of gen) {
    chunks.push(chunk);
  }
  return chunks;
}

/** Build a minimal StreamingDeps object with sensible defaults for testing. */
function makeDeps(overrides: Partial<StreamingDeps> = {}): StreamingDeps {
  const noopTracer = {
    startInvocation: jest.fn(),
    endInvocation: jest.fn().mockResolvedValue(undefined),
    recordLlmCall: jest.fn(),
    recordToolExecution: jest.fn(),
  };

  const stubToolRegistry = {
    get: jest.fn().mockReturnValue(undefined),
    getDefinition: jest.fn().mockReturnValue(undefined),
    list: jest.fn().mockReturnValue([]),
  } as unknown as StreamingDeps["toolRegistry"];

  const stubPermissionManager = {
    checkPermission: jest.fn().mockResolvedValue(undefined),
  } as unknown as StreamingDeps["permissionManager"];

  return {
    llmWithTools: { stream: jest.fn() } as unknown as StreamingDeps["llmWithTools"],
    toolRegistry: stubToolRegistry,
    permissionManager: stubPermissionManager,
    chatHistory: new InMemoryChatMessageHistory(),
    systemMessage: new SystemMessage("You are a helpful assistant."),
    tracer: noopTracer as unknown as StreamingDeps["tracer"],
    maxIterations: 10,
    maxContextTokens: 28000,
    toolTimeoutMs: 5000,
    ...overrides,
  };
}

/** Create an async generator that yields the given items. */
async function* makeChunkStream<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) {
    yield item;
  }
}

// ---------------------------------------------------------------------------
// Tests: basic streaming
// ---------------------------------------------------------------------------

describe("streamWithTools – basic text streaming", () => {
  it("yields text chunks from the LLM stream in order", async () => {
    const chunks = [
      { content: "Hello", tool_call_chunks: [] },
      { content: ", ", tool_call_chunks: [] },
      { content: "world!", tool_call_chunks: [] },
    ];

    const deps = makeDeps({
      llmWithTools: {
        stream: jest.fn().mockResolvedValue(makeChunkStream(chunks)),
      } as unknown as StreamingDeps["llmWithTools"],
    });

    const result = await collectChunks(streamWithTools("hi", deps));

    expect(result).toEqual(["Hello", ", ", "world!"]);
  });

  it("yields nothing when LLM returns only empty content chunks", async () => {
    const deps = makeDeps({
      llmWithTools: {
        stream: jest.fn().mockResolvedValue(
          makeChunkStream([
            { content: "", tool_call_chunks: [] },
            { content: "", tool_call_chunks: [] },
          ])
        ),
      } as unknown as StreamingDeps["llmWithTools"],
    });

    const result = await collectChunks(streamWithTools("hi", deps));
    expect(result).toEqual([]);
  });

  it("adds the user message and final AI message to chat history", async () => {
    const chatHistory = new InMemoryChatMessageHistory();
    const deps = makeDeps({
      chatHistory,
      llmWithTools: {
        stream: jest.fn().mockResolvedValue(
          makeChunkStream([{ content: "Done", tool_call_chunks: [] }])
        ),
      } as unknown as StreamingDeps["llmWithTools"],
    });

    await collectChunks(streamWithTools("Ping", deps));

    const messages = await chatHistory.getMessages();
    expect(messages).toHaveLength(2);
    expect(messages[0].content).toBe("Ping");  // HumanMessage
    expect(messages[1].content).toBe("Done");  // AIMessage
  });
});

// ---------------------------------------------------------------------------
// Tests: tool call buffering
// ---------------------------------------------------------------------------

describe("streamWithTools – tool call buffering", () => {
  it("buffers tool_call_chunks and executes the assembled tool call", async () => {
    const mockToolResult = "42";
    const mockTool = {
      invoke: jest.fn().mockResolvedValue(mockToolResult),
    };

    // First LLM call: streams a tool call in two chunks, no text content
    const firstStream = makeChunkStream([
      {
        content: "",
        tool_call_chunks: [{ index: 0, id: "call_1", name: "calc", args: '{"expr' }],
      },
      {
        content: "",
        tool_call_chunks: [{ index: 0, id: "", name: "", args: '":"6*7"}' }],
      },
    ]);

    // Second LLM call: returns final text response
    const secondStream = makeChunkStream([
      { content: "The answer is 42", tool_call_chunks: [] },
    ]);

    const streamMock = jest
      .fn()
      .mockResolvedValueOnce(firstStream)
      .mockResolvedValueOnce(secondStream);

    const stubToolRegistry = {
      get: jest.fn().mockReturnValue(mockTool),
      getDefinition: jest.fn().mockReturnValue({ permissionLevel: "safe" }),
      list: jest.fn().mockReturnValue([]),
    } as unknown as StreamingDeps["toolRegistry"];

    const deps = makeDeps({
      llmWithTools: { stream: streamMock } as unknown as StreamingDeps["llmWithTools"],
      toolRegistry: stubToolRegistry,
    });

    const result = await collectChunks(streamWithTools("What is 6*7?", deps));

    // Only the second-turn text should be yielded
    expect(result).toEqual(["The answer is 42"]);
    // Tool was executed with the assembled args
    expect(mockTool.invoke).toHaveBeenCalledWith({ expr: "6*7" });
    // LLM was called twice: once for tool call, once for final response
    expect(streamMock).toHaveBeenCalledTimes(2);
  });

  it("handles multiple concurrent tool calls in the same turn", async () => {
    const mockTool = { invoke: jest.fn().mockResolvedValue("result") };

    const toolStream = makeChunkStream([
      {
        content: "",
        tool_call_chunks: [{ index: 0, id: "c1", name: "toolA", args: "{}" }],
      },
      {
        content: "",
        tool_call_chunks: [{ index: 1, id: "c2", name: "toolB", args: "{}" }],
      },
    ]);
    const finalStream = makeChunkStream([{ content: "Done", tool_call_chunks: [] }]);

    const streamMock = jest
      .fn()
      .mockResolvedValueOnce(toolStream)
      .mockResolvedValueOnce(finalStream);

    const stubToolRegistry = {
      get: jest.fn().mockReturnValue(mockTool),
      getDefinition: jest.fn().mockReturnValue(null),
      list: jest.fn().mockReturnValue([]),
    } as unknown as StreamingDeps["toolRegistry"];

    const deps = makeDeps({
      llmWithTools: { stream: streamMock } as unknown as StreamingDeps["llmWithTools"],
      toolRegistry: stubToolRegistry,
    });

    await collectChunks(streamWithTools("Run two tools", deps));

    // Both tools must have been invoked
    expect(mockTool.invoke).toHaveBeenCalledTimes(2);
  });

  it("injects a ToolMessage with an error when the tool is not found", async () => {
    const chatHistory = new InMemoryChatMessageHistory();

    const toolStream = makeChunkStream([
      {
        content: "",
        tool_call_chunks: [{ index: 0, id: "c1", name: "missing_tool", args: "{}" }],
      },
    ]);
    const finalStream = makeChunkStream([{ content: "OK", tool_call_chunks: [] }]);

    const streamMock = jest
      .fn()
      .mockResolvedValueOnce(toolStream)
      .mockResolvedValueOnce(finalStream);

    const deps = makeDeps({
      chatHistory,
      llmWithTools: { stream: streamMock } as unknown as StreamingDeps["llmWithTools"],
      // toolRegistry.get returns undefined by default (tool not found)
    });

    await collectChunks(streamWithTools("Use missing tool", deps));

    const messages = await chatHistory.getMessages();
    const toolMsg = messages.find(
      (m) => m._getType() === "tool" && (m as any).content?.includes("not found")
    );
    expect(toolMsg).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Tests: iteration guard
// ---------------------------------------------------------------------------

describe("streamWithTools – MAX_ITERATIONS guard", () => {
  it("stops streaming when maxIterations is reached", async () => {
    // Every LLM call returns a tool call — would loop forever without the guard
    const infiniteToolStream = () =>
      makeChunkStream([
        {
          content: "",
          tool_call_chunks: [{ index: 0, id: "cx", name: "loop_tool", args: "{}" }],
        },
      ]);

    const streamMock = jest.fn().mockImplementation(() =>
      Promise.resolve(infiniteToolStream())
    );

    const mockTool = { invoke: jest.fn().mockResolvedValue("keep going") };
    const stubToolRegistry = {
      get: jest.fn().mockReturnValue(mockTool),
      getDefinition: jest.fn().mockReturnValue(null),
      list: jest.fn().mockReturnValue([]),
    } as unknown as StreamingDeps["toolRegistry"];

    const deps = makeDeps({
      llmWithTools: { stream: streamMock } as unknown as StreamingDeps["llmWithTools"],
      toolRegistry: stubToolRegistry,
      maxIterations: 3,
    });

    // Must terminate rather than loop forever
    await expect(collectChunks(streamWithTools("loop", deps))).resolves.toBeDefined();

    // LLM was called at most maxIterations times
    expect(streamMock.mock.calls.length).toBeLessThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// Tests: agentExecutor surface – confirms stream is exposed
// (full backward-compat of agentExecutor.invoke is covered by index.test.ts)
// ---------------------------------------------------------------------------

describe("agentExecutor – streaming surface", () => {
  it("exposes a stream method alongside invoke", async () => {
    process.env.MISTRAL_API_KEY = "test-key";
    const { agentExecutor } = await import("../index");
    expect(typeof agentExecutor.invoke).toBe("function");
    expect(typeof agentExecutor.stream).toBe("function");
  });
});
