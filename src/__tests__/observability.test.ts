/**
 * Tests for Task 4.1: Observability & Tracing.
 *
 * Part 1 (unit): FileTracer and NoopTracer directly.
 * Part 2 (integration): agent invocation writes a trace file via setTracer.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

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

// Mock ToolRegistry for integration tests
jest.mock("../tools/registry", () => ({
  ToolRegistry: jest.fn().mockImplementation(() => ({
    register: jest.fn(),
    get: jest.fn().mockImplementation((name: string) =>
      name === "search" ? { name: "search", invoke: mockToolInvoke } : undefined
    ),
    getDefinition: jest.fn().mockReturnValue(undefined),
    list: jest.fn().mockReturnValue([{ name: "search", description: "Search the web" }]),
    toLangChainTools: jest.fn().mockReturnValue([]),
    loadFromDirectory: jest.fn().mockResolvedValue(undefined),
  })),
}));

process.env.MISTRAL_API_KEY = "test-api-key";

import {
  FileTracer,
  NoopTracer,
  createTracer,
  newInvocationId,
  type InvocationTrace,
  type LlmCallSpan,
  type ToolExecutionSpan,
} from "../observability";
import { agentExecutor, setTracer } from "../index";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a temporary directory and return its path. */
function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agentloop-traces-"));
}

/** Read and parse the first (and only expected) JSON file in dir. */
function readTraceFile(dir: string): InvocationTrace {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  expect(files).toHaveLength(1);
  const raw = fs.readFileSync(path.join(dir, files[0]), "utf-8");
  return JSON.parse(raw) as InvocationTrace;
}

// ---------------------------------------------------------------------------
// Part 1 — Unit tests for FileTracer and NoopTracer
// ---------------------------------------------------------------------------

describe("NoopTracer", () => {
  it("accepts all calls without errors", async () => {
    const tracer = new NoopTracer();
    const id = "noop-id";
    tracer.startInvocation(id, "hello");
    tracer.recordLlmCall(id, {
      startedAt: 1,
      endedAt: 2,
      durationMs: 1,
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      toolCallCount: 0,
    });
    tracer.recordToolExecution(id, {
      startedAt: 1,
      endedAt: 2,
      durationMs: 1,
      toolName: "search",
      callId: "c1",
      success: true,
    });
    await expect(tracer.endInvocation(id)).resolves.toBeUndefined();
  });
});

describe("FileTracer", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates outputDir when it does not exist and writes a JSON file", async () => {
    const nestedDir = path.join(tmpDir, "nested", "traces");
    const tracer = new FileTracer({ outputDir: nestedDir, costPerInputTokenUsd: 0, costPerOutputTokenUsd: 0 });
    const id = newInvocationId();

    tracer.startInvocation(id, "test input");
    await tracer.endInvocation(id);

    const files = fs.readdirSync(nestedDir).filter((f) => f.endsWith(".json"));
    expect(files).toHaveLength(1);
    expect(files[0]).toBe(`${id}.json`);
  });

  it("trace file contains expected top-level fields", async () => {
    const tracer = new FileTracer({ outputDir: tmpDir, costPerInputTokenUsd: 0, costPerOutputTokenUsd: 0 });
    const id = newInvocationId();

    tracer.startInvocation(id, "hello world");
    await tracer.endInvocation(id);

    const trace = readTraceFile(tmpDir);
    expect(trace.invocationId).toBe(id);
    expect(trace.input).toBe("hello world");
    expect(typeof trace.startedAt).toBe("number");
    expect(typeof trace.endedAt).toBe("number");
    expect(trace.durationMs).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(trace.llmCalls)).toBe(true);
    expect(Array.isArray(trace.toolExecutions)).toBe(true);
    expect(typeof trace.totalTokens).toBe("number");
    expect(typeof trace.estimatedCostUsd).toBe("number");
  });

  it("records LLM call spans correctly", async () => {
    const tracer = new FileTracer({ outputDir: tmpDir, costPerInputTokenUsd: 0, costPerOutputTokenUsd: 0 });
    const id = newInvocationId();

    tracer.startInvocation(id, "query");

    const span: LlmCallSpan = {
      startedAt: 1000,
      endedAt: 1200,
      durationMs: 200,
      promptTokens: 50,
      completionTokens: 30,
      totalTokens: 80,
      toolCallCount: 1,
    };
    tracer.recordLlmCall(id, span);
    await tracer.endInvocation(id);

    const trace = readTraceFile(tmpDir);
    expect(trace.llmCalls).toHaveLength(1);
    expect(trace.llmCalls[0]).toMatchObject(span);
    expect(trace.totalPromptTokens).toBe(50);
    expect(trace.totalCompletionTokens).toBe(30);
    expect(trace.totalTokens).toBe(80);
  });

  it("records tool execution spans correctly", async () => {
    const tracer = new FileTracer({ outputDir: tmpDir, costPerInputTokenUsd: 0, costPerOutputTokenUsd: 0 });
    const id = newInvocationId();

    tracer.startInvocation(id, "run tool");

    const span: ToolExecutionSpan = {
      startedAt: 500,
      endedAt: 600,
      durationMs: 100,
      toolName: "search",
      callId: "call_abc",
      success: true,
    };
    tracer.recordToolExecution(id, span);
    await tracer.endInvocation(id);

    const trace = readTraceFile(tmpDir);
    expect(trace.toolExecutions).toHaveLength(1);
    expect(trace.toolExecutions[0]).toMatchObject(span);
  });

  it("records failed tool execution spans with error field", async () => {
    const tracer = new FileTracer({ outputDir: tmpDir, costPerInputTokenUsd: 0, costPerOutputTokenUsd: 0 });
    const id = newInvocationId();

    tracer.startInvocation(id, "failing tool");

    const span: ToolExecutionSpan = {
      startedAt: 100,
      endedAt: 200,
      durationMs: 100,
      toolName: "shell",
      callId: "call_err",
      success: false,
      error: "permission denied",
    };
    tracer.recordToolExecution(id, span);
    await tracer.endInvocation(id);

    const trace = readTraceFile(tmpDir);
    expect(trace.toolExecutions[0].success).toBe(false);
    expect(trace.toolExecutions[0].error).toBe("permission denied");
  });

  it("computes cumulative token totals and cost estimate across multiple LLM calls", async () => {
    const tracer = new FileTracer({
      outputDir: tmpDir,
      costPerInputTokenUsd: 0.000001,  // $1 per million input tokens
      costPerOutputTokenUsd: 0.000002, // $2 per million output tokens
    });
    const id = newInvocationId();

    tracer.startInvocation(id, "multi-call");
    tracer.recordLlmCall(id, { startedAt: 0, endedAt: 1, durationMs: 1, promptTokens: 100, completionTokens: 40, totalTokens: 140, toolCallCount: 1 });
    tracer.recordLlmCall(id, { startedAt: 2, endedAt: 3, durationMs: 1, promptTokens: 200, completionTokens: 60, totalTokens: 260, toolCallCount: 0 });
    await tracer.endInvocation(id);

    const trace = readTraceFile(tmpDir);
    expect(trace.totalPromptTokens).toBe(300);
    expect(trace.totalCompletionTokens).toBe(100);
    expect(trace.totalTokens).toBe(400);
    // 300 * 0.000001 + 100 * 0.000002 = 0.0003 + 0.0002 = 0.0005
    expect(trace.estimatedCostUsd).toBeCloseTo(0.0005, 6);
  });

  it("endInvocation on unknown id is a no-op", async () => {
    const tracer = new FileTracer({ outputDir: tmpDir, costPerInputTokenUsd: 0, costPerOutputTokenUsd: 0 });
    await expect(tracer.endInvocation("does-not-exist")).resolves.toBeUndefined();
    expect(fs.readdirSync(tmpDir)).toHaveLength(0);
  });
});

describe("createTracer factory", () => {
  it("returns NoopTracer when disabled", () => {
    const tracer = createTracer({ enabled: false, outputDir: "/tmp", costPerInputTokenUsd: 0, costPerOutputTokenUsd: 0 });
    expect(tracer).toBeInstanceOf(NoopTracer);
  });

  it("returns FileTracer when enabled", () => {
    const tracer = createTracer({ enabled: true, outputDir: "/tmp", costPerInputTokenUsd: 0, costPerOutputTokenUsd: 0 });
    expect(tracer).toBeInstanceOf(FileTracer);
  });
});

describe("newInvocationId", () => {
  it("returns a non-empty string", () => {
    const id = newInvocationId();
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
  });

  it("returns unique values on successive calls", () => {
    const ids = new Set(Array.from({ length: 10 }, newInvocationId));
    expect(ids.size).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// Part 2 — Integration: agent invocation writes a trace file
// ---------------------------------------------------------------------------

describe("Agent tracing integration (Task 4.1)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
    mockLlmInvoke.mockReset();
    mockToolInvoke.mockReset();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    // Reset to NoopTracer so other test suites are unaffected
    setTracer(new NoopTracer());
  });

  it("produces a trace file containing LLM calls and token metadata on a simple invocation", async () => {
    // Inject a FileTracer pointing at our temp directory
    setTracer(new FileTracer({ outputDir: tmpDir, costPerInputTokenUsd: 0.000001, costPerOutputTokenUsd: 0.000002 }));

    // LLM returns a direct answer (no tool calls)
    mockLlmInvoke.mockResolvedValueOnce({
      content: "Traced answer",
      tool_calls: [],
      usage_metadata: { input_tokens: 20, output_tokens: 10 },
    });

    const result = await agentExecutor.invoke("Trace this");
    expect(result.output).toBe("Traced answer");

    const trace = readTraceFile(tmpDir);
    expect(trace.input).toBe("Trace this");
    expect(trace.llmCalls).toHaveLength(1);
    expect(trace.llmCalls[0].promptTokens).toBe(20);
    expect(trace.llmCalls[0].completionTokens).toBe(10);
    expect(trace.totalPromptTokens).toBe(20);
    expect(trace.totalCompletionTokens).toBe(10);
    expect(trace.totalTokens).toBe(30);
    // 20 * 0.000001 + 10 * 0.000002 = 0.00002 + 0.00002 = 0.00004
    expect(trace.estimatedCostUsd).toBeCloseTo(0.00004, 7);
  });

  it("trace file includes tool execution span when tool is called", async () => {
    setTracer(new FileTracer({ outputDir: tmpDir, costPerInputTokenUsd: 0, costPerOutputTokenUsd: 0 }));

    mockLlmInvoke
      .mockResolvedValueOnce({
        content: "",
        tool_calls: [{ id: "call_1", name: "search", args: { query: "test" } }],
        tool_calls_count: 1,
      })
      .mockResolvedValueOnce({ content: "Done", tool_calls: [] });

    mockToolInvoke.mockResolvedValueOnce("search result");

    await agentExecutor.invoke("Search for something");

    const trace = readTraceFile(tmpDir);
    expect(trace.llmCalls).toHaveLength(2);
    expect(trace.toolExecutions).toHaveLength(1);
    expect(trace.toolExecutions[0].toolName).toBe("search");
    expect(trace.toolExecutions[0].success).toBe(true);
  });

  it("records failed tool execution in trace when tool throws", async () => {
    setTracer(new FileTracer({ outputDir: tmpDir, costPerInputTokenUsd: 0, costPerOutputTokenUsd: 0 }));

    mockLlmInvoke
      .mockResolvedValueOnce({
        content: "",
        tool_calls: [{ id: "call_1", name: "search", args: { query: "x" } }],
      })
      .mockResolvedValueOnce({ content: "Recovered", tool_calls: [] });

    mockToolInvoke.mockRejectedValueOnce(new Error("upstream failure"));

    await agentExecutor.invoke("Trigger tool error");

    const trace = readTraceFile(tmpDir);
    expect(trace.toolExecutions).toHaveLength(1);
    expect(trace.toolExecutions[0].success).toBe(false);
    expect(trace.toolExecutions[0].error).toMatch(/upstream failure/);
  });

  it("trace summary includes totalTokens and estimatedCostUsd fields", async () => {
    setTracer(new FileTracer({ outputDir: tmpDir, costPerInputTokenUsd: 0, costPerOutputTokenUsd: 0 }));

    mockLlmInvoke.mockResolvedValueOnce({ content: "ok", tool_calls: [] });

    await agentExecutor.invoke("Simple check");

    const trace = readTraceFile(tmpDir);
    expect("totalTokens" in trace).toBe(true);
    expect("estimatedCostUsd" in trace).toBe(true);
    expect(typeof trace.totalTokens).toBe("number");
    expect(typeof trace.estimatedCostUsd).toBe("number");
  });
});
