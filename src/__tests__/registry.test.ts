import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { z } from "zod";
import { ToolRegistry, ToolDefinition } from "../tools/registry";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/** Build a minimal ToolDefinition for testing. */
function makeDefinition(name: string, description = "Test tool"): ToolDefinition {
  return {
    name,
    description,
    schema: z.object({ input: z.string() }),
    execute: async ({ input }: { input: string }) => `echo: ${input}`,
  };
}

// ---------------------------------------------------------------------------
// ToolRegistry unit tests
// ---------------------------------------------------------------------------

describe("ToolRegistry — register / unregister", () => {
  it("(a) registers a tool and makes it retrievable by name", () => {
    const registry = new ToolRegistry();
    registry.register(makeDefinition("search"));
    expect(registry.get("search")).toBeDefined();
    expect(registry.getDefinition("search")?.name).toBe("search");
  });

  it("(a) unregisters a tool so it is no longer retrievable", () => {
    const registry = new ToolRegistry();
    registry.register(makeDefinition("search"));
    registry.unregister("search");
    expect(registry.get("search")).toBeUndefined();
  });

  it("unregister is a no-op for a name that was never registered", () => {
    const registry = new ToolRegistry();
    expect(() => registry.unregister("nonexistent")).not.toThrow();
  });
});

describe("ToolRegistry — duplicate name rejection", () => {
  it("(c) throws when registering a tool with an already-registered name", () => {
    const registry = new ToolRegistry();
    registry.register(makeDefinition("search"));
    expect(() => registry.register(makeDefinition("search"))).toThrow(
      'Tool "search" is already registered'
    );
  });

  it("allows re-registration after unregister", () => {
    const registry = new ToolRegistry();
    registry.register(makeDefinition("search"));
    registry.unregister("search");
    expect(() => registry.register(makeDefinition("search"))).not.toThrow();
  });
});

describe("ToolRegistry — list", () => {
  it("(d) returns an empty array when no tools are registered", () => {
    const registry = new ToolRegistry();
    expect(registry.list()).toEqual([]);
  });

  it("(d) returns name and description for each registered tool", () => {
    const registry = new ToolRegistry();
    registry.register(makeDefinition("search", "Search the web"));
    registry.register(makeDefinition("calculate", "Do maths"));

    const list = registry.list();
    expect(list).toHaveLength(2);
    expect(list).toContainEqual({ name: "search", description: "Search the web" });
    expect(list).toContainEqual({ name: "calculate", description: "Do maths" });
  });

  it("(d) list updates after unregister", () => {
    const registry = new ToolRegistry();
    registry.register(makeDefinition("search"));
    registry.register(makeDefinition("calculate"));
    registry.unregister("search");

    const names = registry.list().map((t) => t.name);
    expect(names).not.toContain("search");
    expect(names).toContain("calculate");
  });
});

describe("ToolRegistry — toLangChainTools", () => {
  it("returns LangChain tool wrappers with name and invoke()", () => {
    const registry = new ToolRegistry();
    registry.register(makeDefinition("search"));

    const tools = registry.toLangChainTools();
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("search");
    expect(typeof tools[0].invoke).toBe("function");
  });

  it("the LangChain tool executes the underlying execute function", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "echo",
      description: "Echo tool",
      schema: z.object({ input: z.string() }),
      execute: async ({ input }: { input: string }) => `echoed: ${input}`,
    });

    const [tool] = registry.toLangChainTools();
    const result = await tool.invoke({ input: "hello" });
    expect(result).toBe("echoed: hello");
  });
});

describe("ToolRegistry — loadFromDirectory", () => {
  // Temp directories created per test; cleaned up in afterEach
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp dir already gone — safe to ignore */ }
    }
  });

  it("(b) auto-registers tools from the real src/tools/ directory", async () => {
    // Load the actual tool files (search + calculate) — the primary production path
    const registry = new ToolRegistry();
    await registry.loadFromDirectory(path.join(__dirname, "..", "tools"));

    expect(registry.get("search")).toBeDefined();
    expect(registry.get("calculate")).toBeDefined();
  });

  it("(b) loads multiple tools — list reflects all loaded tools", async () => {
    const registry = new ToolRegistry();
    await registry.loadFromDirectory(path.join(__dirname, "..", "tools"));

    expect(registry.list().length).toBeGreaterThanOrEqual(2);
    const names = registry.list().map((t) => t.name);
    expect(names).toContain("search");
    expect(names).toContain("calculate");
  });

  it("(b) skips files that do not export toolDefinition", async () => {
    // Stub file with no toolDefinition export — no external deps needed
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentloop-skip-test-"));
    tmpDirs.push(dir);
    fs.writeFileSync(path.join(dir, "helper.js"), "exports.helper = () => {};", "utf-8");

    const registry = new ToolRegistry();
    await registry.loadFromDirectory(dir);

    expect(registry.list()).toHaveLength(0);
  });

  it("(b) skips the registry file itself", async () => {
    // A registry.js in the dir must be ignored to prevent self-registration loops
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentloop-registry-skip-"));
    tmpDirs.push(dir);
    fs.writeFileSync(
      path.join(dir, "registry.js"),
      "exports.toolDefinition = { name: 'r', description: '', schema: {}, execute: async () => '' };",
      "utf-8"
    );

    const registry = new ToolRegistry();
    await registry.loadFromDirectory(dir);
    expect(registry.list()).toHaveLength(0);
  });
});
