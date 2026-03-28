/**
 * Tests for src/start-oneshot.ts argument parsing and CLI behaviour.
 *
 * These tests exercise the parsing helpers and runtime logic using mocked
 * agentExecutor, toolRegistry, and process I/O rather than performing real LLM
 * or network calls.
 */

// ---------------------------------------------------------------------------
// Shared mocks (hoisted by Jest before any imports)
// ---------------------------------------------------------------------------

const mockLlmInvoke = jest.fn().mockResolvedValue({
  content: "mocked response",
  tool_calls: [],
});

jest.mock("@langchain/mistralai", () => ({
  ChatMistralAI: jest.fn().mockImplementation(() => ({
    bindTools: jest.fn().mockReturnValue({ invoke: mockLlmInvoke }),
    invoke: mockLlmInvoke,
    pipe: jest.fn(function (this: unknown) {
      return { invoke: mockLlmInvoke };
    }),
  })),
}));

process.env.MISTRAL_API_KEY = "test-api-key";

import { parseArgs } from "util";

// ---------------------------------------------------------------------------
// Helpers re-implemented from start-oneshot.ts for unit testing parseArgs
// (we test the argument shapes, not the full I/O pipeline)
// ---------------------------------------------------------------------------

function parseAgentArgs(args: string[]) {
  return parseArgs({
    args,
    options: {
      system: { type: "string", short: "s" },
      user: { type: "string", short: "u" },
      profile: { type: "string", short: "p" },
      stream: { type: "boolean" },
      json: { type: "boolean" },
    },
    strict: true,
    allowPositionals: false,
  });
}

function parseWebSearchArgs(args: string[]) {
  return parseArgs({
    args,
    options: {
      query: { type: "string", short: "q" },
      "max-results": { type: "string", short: "n" },
      json: { type: "boolean" },
    },
    strict: true,
    allowPositionals: false,
  });
}

function parseWebFetchArgs(args: string[]) {
  return parseArgs({
    args,
    options: {
      url: { type: "string", short: "u" },
      json: { type: "boolean" },
    },
    strict: true,
    allowPositionals: false,
  });
}

// ---------------------------------------------------------------------------
// Tests: argument parsing for each subcommand
// ---------------------------------------------------------------------------

describe("start-oneshot: agent argument parsing", () => {
  it("parses --user / -u long form", () => {
    const { values } = parseAgentArgs(["--user", "What is 2+2?"]);
    expect(values.user).toBe("What is 2+2?");
  });

  it("parses -u short form", () => {
    const { values } = parseAgentArgs(["-u", "Hello"]);
    expect(values.user).toBe("Hello");
  });

  it("parses --system / -s", () => {
    const { values } = parseAgentArgs(["-s", "You are terse.", "-u", "Hi"]);
    expect(values.system).toBe("You are terse.");
    expect(values.user).toBe("Hi");
  });

  it("parses --profile / -p", () => {
    const { values } = parseAgentArgs(["-p", "coder", "-u", "Refactor"]);
    expect(values.profile).toBe("coder");
  });

  it("parses --stream flag", () => {
    const { values } = parseAgentArgs(["--stream", "-u", "Stream me"]);
    expect(values.stream).toBe(true);
  });

  it("parses --json flag", () => {
    const { values } = parseAgentArgs(["--json", "-u", "JSON please"]);
    expect(values.json).toBe(true);
  });

  it("defaults stream and json to undefined when not provided", () => {
    const { values } = parseAgentArgs(["-u", "Hello"]);
    expect(values.stream).toBeUndefined();
    expect(values.json).toBeUndefined();
  });

  it("throws on unknown flags (strict mode)", () => {
    expect(() => parseAgentArgs(["--unknown", "-u", "x"])).toThrow();
  });
});

describe("start-oneshot: websearch argument parsing", () => {
  it("parses --query / -q long form", () => {
    const { values } = parseWebSearchArgs(["--query", "LangChain tips"]);
    expect(values.query).toBe("LangChain tips");
  });

  it("parses -q short form", () => {
    const { values } = parseWebSearchArgs(["-q", "Bun binary"]);
    expect(values.query).toBe("Bun binary");
  });

  it("parses --max-results / -n", () => {
    const { values } = parseWebSearchArgs(["-q", "test", "-n", "3"]);
    expect(values["max-results"]).toBe("3");
    expect(parseInt(values["max-results"]!, 10)).toBe(3);
  });

  it("parses --json flag", () => {
    const { values } = parseWebSearchArgs(["-q", "test", "--json"]);
    expect(values.json).toBe(true);
  });

  it("throws on unknown flags (strict mode)", () => {
    expect(() => parseWebSearchArgs(["--foo", "bar"])).toThrow();
  });
});

describe("start-oneshot: web-fetch argument parsing", () => {
  it("parses --url / -u long form", () => {
    const { values } = parseWebFetchArgs(["--url", "https://example.com"]);
    expect(values.url).toBe("https://example.com");
  });

  it("parses -u short form", () => {
    const { values } = parseWebFetchArgs(["-u", "https://example.com"]);
    expect(values.url).toBe("https://example.com");
  });

  it("parses --json flag", () => {
    const { values } = parseWebFetchArgs(["-u", "https://example.com", "--json"]);
    expect(values.json).toBe(true);
  });

  it("throws on unknown flags (strict mode)", () => {
    expect(() => parseWebFetchArgs(["--bar"])).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Tests: AgentRunOptions propagation through agentExecutor
// ---------------------------------------------------------------------------

describe("start-oneshot: AgentRunOptions – systemPromptOverride", () => {
  it("agentExecutor.invoke accepts a systemPromptOverride option", async () => {
    const { agentExecutor } = await import("../index");
    const result = await agentExecutor.invoke("hello", undefined, {
      systemPromptOverride: "You are a test assistant.",
    });
    expect(result.output).toBeDefined();
    expect(typeof result.output).toBe("string");
  });

  it("agentExecutor.invoke accepts a profile and systemPromptOverride together", async () => {
    const { agentExecutor } = await import("../index");
    // Profile "nonexistent-profile" will warn but not throw
    const result = await agentExecutor.invoke("hello", "nonexistent-profile", {
      systemPromptOverride: "Override.",
    });
    expect(result.output).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Tests: ensureInitialized is exported
// ---------------------------------------------------------------------------

describe("start-oneshot: ensureInitialized export", () => {
  it("ensureInitialized is a function exported from index", async () => {
    const { ensureInitialized } = await import("../index");
    expect(typeof ensureInitialized).toBe("function");
  });

  it("agentProfileRegistry is exported from index", async () => {
    const { agentProfileRegistry } = await import("../index");
    expect(agentProfileRegistry).toBeDefined();
    expect(typeof agentProfileRegistry.list).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// Tests: toolRegistry is accessible after ensureInitialized
// ---------------------------------------------------------------------------

describe("start-oneshot: toolRegistry after ensureInitialized", () => {
  it("toolRegistry.list() returns an array after initialization", async () => {
    const { ensureInitialized, toolRegistry } = await import("../index");
    await ensureInitialized();
    const tools = toolRegistry.list();
    expect(Array.isArray(tools)).toBe(true);
    // The search and web_fetch tools should be registered
    const names = tools.map((t) => t.name);
    expect(names).toContain("search");
    expect(names).toContain("web_fetch");
  });
});
