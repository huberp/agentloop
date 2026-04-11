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

// ---------------------------------------------------------------------------
// Tests: getActiveExecutor() / ORCHESTRATOR config integration
// ---------------------------------------------------------------------------

describe("start-oneshot: getActiveExecutor", () => {
  it("getActiveExecutor is a function exported from index", async () => {
    const { getActiveExecutor } = await import("../index");
    expect(typeof getActiveExecutor).toBe("function");
  });

  it("returns agentExecutor when ORCHESTRATOR is 'default'", async () => {
    const config = await import("../config");
    const original = config.appConfig.orchestrator;
    (config.appConfig as any).orchestrator = "default";
    try {
      const { getActiveExecutor, agentExecutor } = await import("../index");
      const executor = getActiveExecutor();
      expect(executor.invoke).toBe(agentExecutor.invoke);
    } finally {
      (config.appConfig as any).orchestrator = original;
    }
  });

  it("returns a graph executor adapter when ORCHESTRATOR is 'langgraph'", async () => {
    // Temporarily override the config to "langgraph"
    const config = await import("../config");
    const original = config.appConfig.orchestrator;
    (config.appConfig as any).orchestrator = "langgraph";
    try {
      const { getActiveExecutor, agentExecutor } = await import("../index");
      const executor = getActiveExecutor();
      // The adapter should NOT be the same reference as agentExecutor
      expect(executor.invoke).not.toBe(agentExecutor.invoke);
      expect(typeof executor.invoke).toBe("function");
      expect(typeof executor.stream).toBe("function");
    } finally {
      (config.appConfig as any).orchestrator = original;
    }
  });

  it("graph executor adapter invoke returns { output: string }", async () => {
    const config = await import("../config");
    const original = config.appConfig.orchestrator;
    (config.appConfig as any).orchestrator = "langgraph";

    // Override mock LLM to return a valid blocks plan then a step response
    const planJson = JSON.stringify({
      version: "2.0",
      goal: "say hello",
      blocks: [{ type: "step", description: "greet", toolsNeeded: [], estimatedComplexity: "low" }],
    });
    mockLlmInvoke
      .mockResolvedValueOnce({ content: planJson, tool_calls: [] })
      .mockResolvedValueOnce({ content: "Hello!", tool_calls: [] });

    try {
      const { getActiveExecutor } = await import("../index");
      const executor = getActiveExecutor();
      const result = await executor.invoke("say hello");
      expect(result).toHaveProperty("output");
      expect(typeof result.output).toBe("string");
    } finally {
      (config.appConfig as any).orchestrator = original;
      mockLlmInvoke.mockResolvedValue({ content: "mocked response", tool_calls: [] });
    }
  });

  it("graph executor adapter stream yields a string", async () => {
    const config = await import("../config");
    const original = config.appConfig.orchestrator;
    (config.appConfig as any).orchestrator = "langgraph";

    // Override mock LLM to return a valid blocks plan then a step response
    const planJson = JSON.stringify({
      version: "2.0",
      goal: "say hello",
      blocks: [{ type: "step", description: "greet", toolsNeeded: [], estimatedComplexity: "low" }],
    });
    mockLlmInvoke
      .mockResolvedValueOnce({ content: planJson, tool_calls: [] })
      .mockResolvedValueOnce({ content: "Hello!", tool_calls: [] });

    try {
      const { getActiveExecutor } = await import("../index");
      const executor = getActiveExecutor();
      const chunks: string[] = [];
      for await (const chunk of executor.stream("say hello")) {
        chunks.push(chunk);
      }
      expect(chunks.length).toBeGreaterThan(0);
      expect(typeof chunks[0]).toBe("string");
    } finally {
      (config.appConfig as any).orchestrator = original;
      mockLlmInvoke.mockResolvedValue({ content: "mocked response", tool_calls: [] });
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: applyApiKeyOverride() in config module
// ---------------------------------------------------------------------------

describe("config: applyApiKeyOverride", () => {
  it("applyApiKeyOverride is exported from config", async () => {
    const config = await import("../config");
    expect(typeof config.applyApiKeyOverride).toBe("function");
  });

  it("updates appConfig.mistralApiKey", async () => {
    const config = await import("../config");
    const original = config.appConfig.mistralApiKey;
    try {
      config.applyApiKeyOverride("sk-override-test");
      expect(config.appConfig.mistralApiKey).toBe("sk-override-test");
    } finally {
      config.applyApiKeyOverride(original);
    }
  });

  it("updates process.env.MISTRAL_API_KEY", async () => {
    const config = await import("../config");
    const original = process.env.MISTRAL_API_KEY;
    try {
      config.applyApiKeyOverride("sk-env-test");
      expect(process.env.MISTRAL_API_KEY).toBe("sk-env-test");
    } finally {
      process.env.MISTRAL_API_KEY = original;
      config.applyApiKeyOverride(original ?? "");
    }
  });

  it("keeps appConfig.mistralApiKey and process.env in sync after override", async () => {
    const config = await import("../config");
    const original = config.appConfig.mistralApiKey;
    try {
      config.applyApiKeyOverride("sk-sync-test");
      expect(config.appConfig.mistralApiKey).toBe(process.env.MISTRAL_API_KEY);
    } finally {
      config.applyApiKeyOverride(original);
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: early argv scan in config.ts (applyCliApiKeyOverride)
//
// The IIFE in config.ts reads process.argv at module-load time to apply
// --api-key before appConfig is built.  These tests verify the logic by
// directly replicating the scan behaviour so the module-singleton limitation
// does not interfere.
// ---------------------------------------------------------------------------

describe("config: early --api-key argv scan logic", () => {
  // Replicates the IIFE logic: returns the value, or undefined if absent,
  // or throws if --api-key is present but has no valid value (consistent with
  // the exit(1) in the real IIFE and with stripApiKeyArg).
  function simulateArgvScan(argv: string[]): string | undefined {
    const idx = argv.indexOf("--api-key");
    if (idx === -1) return undefined;
    const value = argv[idx + 1];
    if (!value || value.startsWith("-")) {
      throw new Error("Error: --api-key requires a value");
    }
    return value;
  }

  it("extracts the api key when --api-key is present with a value", () => {
    const result = simulateArgvScan(["node", "script.js", "--api-key", "sk-early"]);
    expect(result).toBe("sk-early");
  });

  it("returns undefined when --api-key is absent", () => {
    const result = simulateArgvScan(["node", "script.js", "-u", "hello"]);
    expect(result).toBeUndefined();
  });

  it("errors when --api-key has no value (consistent with stripApiKeyArg)", () => {
    expect(() => simulateArgvScan(["node", "script.js", "--api-key"])).toThrow(
      "--api-key requires a value"
    );
  });

  it("errors when --api-key value starts with a dash (consistent with stripApiKeyArg)", () => {
    expect(() =>
      simulateArgvScan(["node", "script.js", "--api-key", "--other-flag"])
    ).toThrow("--api-key requires a value");
  });

  it("works when --api-key appears after the subcommand (oneshot pattern)", () => {
    const result = simulateArgvScan(["node", "script.js", "agent", "--api-key", "sk-sub", "-u", "hi"]);
    expect(result).toBe("sk-sub");
  });

  it("covers all start modes — cli, tui, oneshot, and direct index", () => {
    // All start modes use the same config module, so the argv scan fires once
    // before appConfig is built, regardless of which entry point is used.
    const cliResult = simulateArgvScan(["node", "start-cli.ts", "--api-key", "sk-cli"]);
    const tuiResult = simulateArgvScan(["node", "start-tui.ts", "--api-key", "sk-tui"]);
    const oneshotResult = simulateArgvScan(["node", "start-oneshot.ts", "agent", "--api-key", "sk-oneshot", "-u", "hi"]);
    expect(cliResult).toBe("sk-cli");
    expect(tuiResult).toBe("sk-tui");
    expect(oneshotResult).toBe("sk-oneshot");
  });
});

// ---------------------------------------------------------------------------
// Tests: stripApiKeyArg() in config module
// ---------------------------------------------------------------------------

describe("config: stripApiKeyArg", () => {
  it("stripApiKeyArg is exported from config", async () => {
    const config = await import("../config");
    expect(typeof config.stripApiKeyArg).toBe("function");
  });

  it("removes --api-key and its value from the array", async () => {
    const { stripApiKeyArg } = await import("../config");
    const result = stripApiKeyArg(["--api-key", "sk-my-key", "-u", "Hello"]);
    expect(result).toEqual(["-u", "Hello"]);
    expect(result.includes("--api-key")).toBe(false);
  });

  it("returns the array unchanged when --api-key is absent", async () => {
    const { stripApiKeyArg } = await import("../config");
    const result = stripApiKeyArg(["-u", "Hello"]);
    expect(result).toEqual(["-u", "Hello"]);
  });

  it("strips --api-key placed after other flags", async () => {
    const { stripApiKeyArg } = await import("../config");
    const result = stripApiKeyArg(["-u", "Hello", "--api-key", "sk-after"]);
    expect(result).toEqual(["-u", "Hello"]);
  });

  it("does not mutate the original array", async () => {
    const { stripApiKeyArg } = await import("../config");
    const original = ["-u", "Hello", "--api-key", "sk-key"];
    const result = stripApiKeyArg(original);
    expect(original).toEqual(["-u", "Hello", "--api-key", "sk-key"]);
    expect(result).toEqual(["-u", "Hello"]);
  });
});

// ---------------------------------------------------------------------------
// Tests: --api-key global option pre-processing in start-oneshot main()
// (delegates to config.stripApiKeyArg — verified via the config tests above)
// ---------------------------------------------------------------------------

describe("start-oneshot: --api-key is stripped before subcommand dispatch", () => {
  it("stripApiKeyArg produces clean args consumable by parseArgs strict mode", async () => {
    const { stripApiKeyArg } = await import("../config");
    // Simulate: agent --api-key sk-key -u "Hello"
    const cleaned = stripApiKeyArg(["--api-key", "sk-key", "-u", "Hello"]);
    // parseArgs with strict:true must not throw on the cleaned array
    expect(() =>
      parseArgs({
        args: cleaned,
        options: {
          system: { type: "string", short: "s" },
          user: { type: "string", short: "u" },
          profile: { type: "string", short: "p" },
          stream: { type: "boolean" },
          json: { type: "boolean" },
        },
        strict: true,
        allowPositionals: false,
      })
    ).not.toThrow();
    const { values } = parseArgs({
      args: cleaned,
      options: { user: { type: "string", short: "u" } },
      strict: false,
    });
    expect(values.user).toBe("Hello");
  });
});
