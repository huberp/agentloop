/**
 * Tests for Task 5.4: Dynamic Prompt Rendering with Context Injection.
 * Covers buildPromptContext, registerContextProvider, clearContextProviders,
 * getCachedPromptContext, and invalidateContextCache.
 */

// ---------------------------------------------------------------------------
// Mocks (must be declared before imports)
// ---------------------------------------------------------------------------

jest.mock("../config", () => ({
  appConfig: {
    workspaceRoot: "/fake/ws",
    instructionsRoot: "/fake/ws",
    promptContextRefreshMs: 5000,
    logger: { level: "silent", enabled: false, destination: "stdout", name: "test", timestamp: false },
  },
}));

jest.mock("../workspace", () => ({
  analyzeWorkspace: jest.fn().mockResolvedValue({
    language: "node",
    framework: "none",
    packageManager: "npm",
    hasTests: true,
    testCommand: "jest",
    lintCommand: "",
    buildCommand: "",
    entryPoints: [],
    gitInitialized: false,
  }),
}));

jest.mock("../instructions/loader", () => ({
  loadInstructions: jest.fn().mockResolvedValue({
    getActive: () => [
      {
        body: "Be helpful.",
        meta: { description: "test", priority: 0 },
        filePath: "test.md",
      },
    ],
  }),
}));

jest.mock("../tools/registry", () => ({
  toolRegistry: {
    list: jest.fn().mockReturnValue([
      { name: "file-read", description: "Read a file" },
      { name: "shell", description: "Run shell commands" },
    ]),
  },
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import {
  buildPromptContext,
  registerContextProvider,
  clearContextProviders,
  getCachedPromptContext,
  invalidateContextCache,
} from "../prompts/context";
import { appConfig } from "../config";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Reset all test state before each test. */
function resetState() {
  clearContextProviders();
  invalidateContextCache();
}

// ---------------------------------------------------------------------------
// buildPromptContext
// ---------------------------------------------------------------------------

describe("buildPromptContext()", () => {
  beforeEach(resetState);

  it("returns a PromptContext with timestamp set", async () => {
    const ctx = await buildPromptContext();
    expect(typeof ctx.timestamp).toBe("string");
    expect(ctx.timestamp.length).toBeGreaterThan(0);
    // Must be a parseable ISO date
    expect(new Date(ctx.timestamp).toISOString()).toBe(ctx.timestamp);
  });

  it("merges workspace from a workspace provider", async () => {
    registerContextProvider(async () => ({
      workspace: {
        language: "python",
        framework: "django",
        packageManager: "pip",
        hasTests: true,
        testCommand: "pytest",
        lintCommand: "",
        buildCommand: "",
        entryPoints: [],
        gitInitialized: true,
      },
    }));

    const ctx = await buildPromptContext();
    expect(ctx.workspace.language).toBe("python");
    expect(ctx.workspace.testCommand).toBe("pytest");
  });

  it("merges tools from a tool registry provider", async () => {
    registerContextProvider(async () => ({
      tools: [
        { name: "file-read", description: "Read a file" },
        { name: "shell", description: "Run shell commands" },
      ],
    }));

    const ctx = await buildPromptContext();
    expect(ctx.tools).toHaveLength(2);
    expect(ctx.tools[0].name).toBe("file-read");
    expect(ctx.tools[1].name).toBe("shell");
  });

  it("merges instructions from an instructions provider", async () => {
    registerContextProvider(async () => ({
      instructions: [
        { body: "Always be concise.", meta: { priority: 0 }, filePath: "inst.md" },
      ],
    }));

    const ctx = await buildPromptContext();
    expect(ctx.instructions).toHaveLength(1);
    expect(ctx.instructions[0].body).toBe("Always be concise.");
  });

  it("accumulates tools from multiple providers", async () => {
    registerContextProvider(async () => ({
      tools: [{ name: "tool-a", description: "A" }],
    }));
    registerContextProvider(async () => ({
      tools: [{ name: "tool-b", description: "B" }],
    }));

    const ctx = await buildPromptContext();
    expect(ctx.tools).toHaveLength(2);
    expect(ctx.tools.map((t) => t.name)).toEqual(["tool-a", "tool-b"]);
  });

  it("includes result from a custom registered provider", async () => {
    registerContextProvider(async () => ({ historyDigest: "summary-abc" }));

    const ctx = await buildPromptContext();
    expect(ctx.historyDigest).toBe("summary-abc");
  });

  it("after clearContextProviders, custom providers no longer run", async () => {
    const spy = jest.fn().mockResolvedValue({ historyDigest: "should-not-appear" });
    registerContextProvider(spy);
    clearContextProviders();

    const ctx = await buildPromptContext();
    expect(spy).not.toHaveBeenCalled();
    // Context still has a timestamp (defaults are applied)
    expect(ctx.timestamp).toBeTruthy();
    expect(ctx.historyDigest).toBe(""); // left at default
  });

  it("uses last-writer-wins for scalar workspace field across providers", async () => {
    registerContextProvider(async () => ({
      workspace: {
        language: "node",
        framework: "none",
        packageManager: "npm",
        hasTests: false,
        testCommand: "",
        lintCommand: "",
        buildCommand: "",
        entryPoints: [],
        gitInitialized: false,
      },
    }));
    registerContextProvider(async () => ({
      workspace: {
        language: "python",
        framework: "none",
        packageManager: "pip",
        hasTests: false,
        testCommand: "",
        lintCommand: "",
        buildCommand: "",
        entryPoints: [],
        gitInitialized: false,
      },
    }));

    const ctx = await buildPromptContext();
    expect(ctx.workspace.language).toBe("python"); // second provider wins
  });
});

// ---------------------------------------------------------------------------
// getCachedPromptContext / invalidateContextCache
// ---------------------------------------------------------------------------

describe("getCachedPromptContext()", () => {
  beforeEach(resetState);

  it("returns the same object reference on second call within TTL", async () => {
    const first = await getCachedPromptContext();
    const second = await getCachedPromptContext();
    expect(second).toBe(first);
  });

  it("with PROMPT_CONTEXT_REFRESH_MS=0, rebuilds on every call", async () => {
    (appConfig as any).promptContextRefreshMs = 0;

    const spy = jest.fn().mockResolvedValue({ historyDigest: "x" });
    registerContextProvider(spy);

    await getCachedPromptContext();
    await getCachedPromptContext();

    expect(spy).toHaveBeenCalledTimes(2);

    (appConfig as any).promptContextRefreshMs = 5000; // restore
  });

  it("invalidateContextCache forces a rebuild on next call", async () => {
    const spy = jest.fn().mockResolvedValue({ historyDigest: "v" });
    registerContextProvider(spy);

    const first = await getCachedPromptContext();
    invalidateContextCache();
    const second = await getCachedPromptContext();

    expect(second).not.toBe(first); // different object → rebuilt
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("rebuilds after TTL has elapsed", async () => {
    const nowSpy = jest.spyOn(Date, "now");
    nowSpy.mockReturnValue(1_000);

    const spy = jest.fn().mockResolvedValue({ historyDigest: "ttl-test" });
    registerContextProvider(spy);

    const first = await getCachedPromptContext(); // builds, cacheExpiresAt = 6000

    // Advance time past the 5000 ms TTL
    nowSpy.mockReturnValue(7_000);
    const second = await getCachedPromptContext(); // should rebuild

    expect(second).not.toBe(first);
    expect(spy).toHaveBeenCalledTimes(2);

    nowSpy.mockRestore();
  });

  it("does NOT rebuild when called within TTL", async () => {
    const nowSpy = jest.spyOn(Date, "now");
    nowSpy.mockReturnValue(1_000);

    const spy = jest.fn().mockResolvedValue({ historyDigest: "within-ttl" });
    registerContextProvider(spy);

    await getCachedPromptContext(); // builds at t=1000, expires at t=6000
    nowSpy.mockReturnValue(4_000);  // still within TTL
    await getCachedPromptContext(); // should use cache

    expect(spy).toHaveBeenCalledTimes(1);

    nowSpy.mockRestore();
  });
});
