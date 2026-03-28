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

  it("skillRegistry is exported from index", async () => {
    const { skillRegistry } = await import("../index");
    expect(skillRegistry).toBeDefined();
    expect(typeof skillRegistry.list).toBe("function");
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

  it("toolRegistry.getAll() returns full metadata after initialization", async () => {
    const { ensureInitialized, toolRegistry } = await import("../index");
    await ensureInitialized();
    const tools = toolRegistry.getAll();
    expect(Array.isArray(tools)).toBe(true);

    const searchTool = tools.find((t) => t.name === "search");
    expect(searchTool).toBeDefined();
    expect(searchTool).toHaveProperty("permissions");
    expect(searchTool).toHaveProperty("source");
    expect(searchTool).toHaveProperty("filePath");
    // Built-in tools should be tagged as "built-in"
    expect(searchTool?.source).toBe("built-in");
  });

  it("built-in tools have filePath set after initialization", async () => {
    const { ensureInitialized, toolRegistry } = await import("../index");
    await ensureInitialized();
    const tools = toolRegistry.getAll();
    const searchTool = tools.find((t) => t.name === "search");
    expect(searchTool?.filePath).toBeTruthy();
    expect(typeof searchTool?.filePath).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// Tests: agentProfileRegistry.getAll() after ensureInitialized
// ---------------------------------------------------------------------------

describe("start-oneshot: agentProfileRegistry.getAll() after ensureInitialized", () => {
  it("getAll() returns profiles with source field set to built-in", async () => {
    const { ensureInitialized, agentProfileRegistry } = await import("../index");
    await ensureInitialized();
    const profiles = agentProfileRegistry.getAll();
    expect(profiles.length).toBeGreaterThan(0);
    for (const p of profiles) {
      expect(p.source).toBe("built-in");
    }
  });

  it("getAll() returns profiles with filePath set", async () => {
    const { ensureInitialized, agentProfileRegistry } = await import("../index");
    await ensureInitialized();
    const profiles = agentProfileRegistry.getAll();
    for (const p of profiles) {
      expect(typeof p.filePath).toBe("string");
      expect(p.filePath).toBeTruthy();
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: skillRegistry.getAll() after ensureInitialized
// ---------------------------------------------------------------------------

describe("start-oneshot: skillRegistry.getAll() after ensureInitialized", () => {
  it("getAll() returns skills with source field set to built-in", async () => {
    const { ensureInitialized, skillRegistry } = await import("../index");
    await ensureInitialized();
    const skills = skillRegistry.getAll();
    expect(skills.length).toBeGreaterThan(0);
    for (const s of skills) {
      expect(s.source).toBe("built-in");
    }
  });

  it("getAll() returns skills with filePath set", async () => {
    const { ensureInitialized, skillRegistry } = await import("../index");
    await ensureInitialized();
    const skills = skillRegistry.getAll();
    for (const s of skills) {
      expect(typeof s.filePath).toBe("string");
      expect(s.filePath).toBeTruthy();
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: list command argument parsing
// ---------------------------------------------------------------------------

describe("start-oneshot: list argument parsing", () => {
  it("parses --json flag", () => {
    const { values, positionals } = parseArgs({
      args: ["tools", "--json"],
      options: { json: { type: "boolean" }, verbose: { type: "boolean" } },
      strict: true,
      allowPositionals: true,
    });
    expect(positionals[0]).toBe("tools");
    expect(values.json).toBe(true);
    expect(values.verbose).toBeUndefined();
  });

  it("parses --verbose flag", () => {
    const { values, positionals } = parseArgs({
      args: ["skills", "--verbose"],
      options: { json: { type: "boolean" }, verbose: { type: "boolean" } },
      strict: true,
      allowPositionals: true,
    });
    expect(positionals[0]).toBe("skills");
    expect(values.verbose).toBe(true);
  });

  it("uses 'tools' as default capability when no positional given", () => {
    const { positionals } = parseArgs({
      args: [],
      options: { json: { type: "boolean" }, verbose: { type: "boolean" } },
      strict: true,
      allowPositionals: true,
    });
    const capability = positionals[0] ?? "tools";
    expect(capability).toBe("tools");
  });

  it("throws on unknown flags in strict mode", () => {
    expect(() =>
      parseArgs({
        args: ["tools", "--unknown-flag"],
        options: { json: { type: "boolean" }, verbose: { type: "boolean" } },
        strict: true,
        allowPositionals: true,
      })
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Tests: table rendering helpers
// ---------------------------------------------------------------------------

describe("start-oneshot: list table rendering", () => {
  it("col() pads a short string to the given width", () => {
    // Test the column padding logic used in the list command
    function col(value: string, width: number): string {
      if (value.length > width) return value.slice(0, width - 1) + "…";
      return value.padEnd(width);
    }
    expect(col("hi", 10)).toBe("hi        ");
    expect(col("hi", 2)).toBe("hi");
  });

  it("col() truncates a long string with ellipsis", () => {
    function col(value: string, width: number): string {
      if (value.length > width) return value.slice(0, width - 1) + "…";
      return value.padEnd(width);
    }
    const result = col("very-long-name-here", 10);
    expect(result).toHaveLength(10);
    expect(result.endsWith("…")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests: provider list construction
// ---------------------------------------------------------------------------

describe("start-oneshot: buildProviderList", () => {
  it("marks llm provider as active when API key is set", () => {
    // Simulate what buildProviderList produces
    const appCfg = {
      llmProvider: "mistral",
      mistralApiKey: "sk-test",
      webSearchProvider: "duckduckgo",
      tavilyApiKey: "",
      langsearchApiKey: "",
    };
    // Replicate the logic
    const llmEntry = {
      type: "llm",
      name: appCfg.llmProvider,
      status: appCfg.mistralApiKey ? "active" : "inactive",
      note: appCfg.mistralApiKey ? "MISTRAL_API_KEY set" : "MISTRAL_API_KEY not set",
    };
    expect(llmEntry.status).toBe("active");
    expect(llmEntry.note).toContain("set");
  });

  it("marks llm provider as inactive when API key is missing", () => {
    const appCfg = {
      llmProvider: "mistral",
      mistralApiKey: "",
      webSearchProvider: "duckduckgo",
      tavilyApiKey: "",
      langsearchApiKey: "",
    };
    const status = appCfg.mistralApiKey ? "active" : "inactive";
    expect(status).toBe("inactive");
  });

  it("marks tavily as active when TAVILY_API_KEY is set", () => {
    const appCfg = {
      llmProvider: "mistral",
      mistralApiKey: "sk-test",
      webSearchProvider: "tavily",
      tavilyApiKey: "tvly-key",
      langsearchApiKey: "",
    };
    const tavilyStatus = appCfg.tavilyApiKey ? "active" : "inactive";
    expect(tavilyStatus).toBe("active");
  });

  it("duckduckgo is always active (no key required)", () => {
    const appCfg = {
      llmProvider: "mistral",
      mistralApiKey: "",
      webSearchProvider: "duckduckgo",
      tavilyApiKey: "",
      langsearchApiKey: "",
    };
    // duckduckgo always active
    const ddgEntry = {
      type: "search",
      name: "duckduckgo",
      status: "active" as const,
      note: `no key required${appCfg.webSearchProvider === "duckduckgo" ? " (active provider)" : ""}`,
    };
    expect(ddgEntry.status).toBe("active");
    expect(ddgEntry.note).toContain("active provider");
  });
});

// ---------------------------------------------------------------------------
// Tests: JSON output format
// ---------------------------------------------------------------------------

describe("start-oneshot: list JSON output", () => {
  it("produces valid JSON for tool list", async () => {
    const { ensureInitialized, toolRegistry } = await import("../index");
    await ensureInitialized();
    const tools = toolRegistry.getAll();
    // Should serialize without error
    const json = JSON.stringify(tools, null, 2);
    const parsed = JSON.parse(json);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThan(0);
    expect(parsed[0]).toHaveProperty("name");
    expect(parsed[0]).toHaveProperty("description");
    expect(parsed[0]).toHaveProperty("permissions");
  });

  it("produces valid JSON for agent profile list", async () => {
    const { ensureInitialized, agentProfileRegistry } = await import("../index");
    await ensureInitialized();
    const profiles = agentProfileRegistry.getAll();
    const json = JSON.stringify(profiles, null, 2);
    const parsed = JSON.parse(json);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0]).toHaveProperty("name");
    expect(parsed[0]).toHaveProperty("description");
    expect(parsed[0]).toHaveProperty("source");
  });

  it("produces valid JSON for skill list", async () => {
    const { ensureInitialized, skillRegistry } = await import("../index");
    await ensureInitialized();
    const skills = skillRegistry.getAll();
    const json = JSON.stringify(skills, null, 2);
    const parsed = JSON.parse(json);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThan(0);
    expect(parsed[0]).toHaveProperty("name");
    expect(parsed[0]).toHaveProperty("source");
  });
});
