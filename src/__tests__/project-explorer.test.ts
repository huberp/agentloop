// Mock ChatMistralAI before any imports — prevents ESM parse errors in Jest
jest.mock("@langchain/mistralai", () => ({
  ChatMistralAI: jest.fn(),
}));

import { z } from "zod";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

import { ToolRegistry } from "../tools/registry";
import { exploreWorkspace } from "../agents/project-explorer";
import type { WorkspaceContext } from "../workspace";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeMockLlm(invokeFn: jest.Mock): BaseChatModel {
  return {
    bindTools: jest.fn().mockReturnValue({ invoke: invokeFn }),
  } as unknown as BaseChatModel;
}

/** Minimal registry with file-list and file-read stubs for unit tests. */
function makeExplorerRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register({
    name: "file-list",
    description: "List directory contents",
    schema: z.object({ path: z.string().optional(), recursive: z.boolean().optional() }),
    execute: async () => JSON.stringify({ entries: [] }),
  });
  registry.register({
    name: "file-read",
    description: "Read a file",
    schema: z.object({ path: z.string() }),
    execute: async () => JSON.stringify({ content: "", encoding: "utf-8", sizeBytes: 0 }),
  });
  return registry;
}

// ─────────────────────────────────────────────────────────────────────────────
// exploreWorkspace
// ─────────────────────────────────────────────────────────────────────────────

describe("exploreWorkspace", () => {
  it("returns a WorkspaceContext with workspaceInfo from the LLM output", async () => {
    const explorerOutput = JSON.stringify({
      workspaceInfo: {
        language: "rust",
        framework: "none",
        packageManager: "cargo",
        hasTests: true,
        testCommand: "",
        lintCommand: "",
        buildCommand: "",
        entryPoints: ["src/main.rs"],
        gitInitialized: true,
      },
      buildSystems: [
        {
          name: "cargo",
          configFile: "Cargo.toml",
          notes: "Single-crate project. Use 'cargo build' and 'cargo test'.",
        },
      ],
      explorerNotes: "Standard Rust project layout.",
    });

    const invoke = jest.fn().mockResolvedValueOnce({ content: explorerOutput, tool_calls: [] });
    const registry = makeExplorerRegistry();

    const context = await exploreWorkspace({ registry, llm: makeMockLlm(invoke) });

    expect(context.workspaceInfo.language).toBe("rust");
    expect(context.workspaceInfo.packageManager).toBe("cargo");
    expect(context.workspaceInfo.hasTests).toBe(true);
    expect(context.workspaceInfo.entryPoints).toContain("src/main.rs");
    expect(context.workspaceInfo.gitInitialized).toBe(true);
  });

  it("captures buildSystems from LLM output in the context map", async () => {
    const explorerOutput = JSON.stringify({
      workspaceInfo: {
        language: "cpp",
        framework: "none",
        packageManager: "cmake",
        hasTests: false,
        testCommand: "",
        lintCommand: "",
        buildCommand: "",
        entryPoints: [],
        gitInitialized: false,
      },
      buildSystems: [
        {
          name: "cmake",
          configFile: "CMakeLists.txt",
          notes: "CMakePresets.json present. Use preset 'linux-release' for release builds.",
        },
      ],
    });

    const invoke = jest.fn().mockResolvedValueOnce({ content: explorerOutput, tool_calls: [] });
    const registry = makeExplorerRegistry();

    const context = await exploreWorkspace({ registry, llm: makeMockLlm(invoke) });

    expect(context.workspaceInfo.language).toBe("cpp");
    const buildSystems = context.buildSystems as Array<{ name: string; configFile: string; notes: string }>;
    expect(Array.isArray(buildSystems)).toBe(true);
    expect(buildSystems).toHaveLength(1);
    expect(buildSystems[0].name).toBe("cmake");
    expect(buildSystems[0].notes).toContain("linux-release");
  });

  it("captures explorerNotes in the context map when present", async () => {
    const explorerOutput = JSON.stringify({
      workspaceInfo: {
        language: "java",
        framework: "spring",
        packageManager: "gradle",
        hasTests: true,
        testCommand: "",
        lintCommand: "",
        buildCommand: "",
        entryPoints: [],
        gitInitialized: true,
      },
      explorerNotes: "Gradle wrapper (./gradlew) is present. Kotlin DSL (build.gradle.kts).",
    });

    const invoke = jest.fn().mockResolvedValueOnce({ content: explorerOutput, tool_calls: [] });
    const registry = makeExplorerRegistry();

    const context = await exploreWorkspace({ registry, llm: makeMockLlm(invoke) });

    expect(context.explorerNotes).toContain("Gradle wrapper");
    expect(context.explorerNotes).toContain("Kotlin DSL");
  });

  it("handles multiple build systems in a monorepo", async () => {
    const explorerOutput = JSON.stringify({
      workspaceInfo: {
        language: "cpp",
        framework: "none",
        packageManager: "cmake",
        hasTests: true,
        testCommand: "",
        lintCommand: "",
        buildCommand: "",
        entryPoints: [],
        gitInitialized: true,
      },
      buildSystems: [
        {
          name: "cmake",
          configFile: "CMakeLists.txt",
          notes: "C++ core library.",
        },
        {
          name: "cargo",
          configFile: "bindings/rust/Cargo.toml",
          notes: "Rust FFI bindings to the C++ core.",
        },
      ],
      explorerNotes: "Hybrid C++/Rust project.",
    });

    const invoke = jest.fn().mockResolvedValueOnce({ content: explorerOutput, tool_calls: [] });
    const registry = makeExplorerRegistry();

    const context = await exploreWorkspace({ registry, llm: makeMockLlm(invoke) });

    const buildSystems = context.buildSystems as Array<{ name: string }>;
    expect(buildSystems).toHaveLength(2);
    expect(buildSystems.map((b) => b.name)).toContain("cmake");
    expect(buildSystems.map((b) => b.name)).toContain("cargo");
  });

  it("strips markdown code fences from the LLM output", async () => {
    const inner = JSON.stringify({
      workspaceInfo: {
        language: "go",
        framework: "none",
        packageManager: "go mod",
        hasTests: false,
        testCommand: "",
        lintCommand: "",
        buildCommand: "",
        entryPoints: [],
        gitInitialized: false,
      },
    });
    const fenced = `\`\`\`json\n${inner}\n\`\`\``;

    const invoke = jest.fn().mockResolvedValueOnce({ content: fenced, tool_calls: [] });
    const registry = makeExplorerRegistry();

    const context = await exploreWorkspace({ registry, llm: makeMockLlm(invoke) });
    expect(context.workspaceInfo.language).toBe("go");
  });

  it("returns a fallback context when the LLM output is not valid JSON", async () => {
    const invoke = jest.fn().mockResolvedValueOnce({ content: "I could not explore", tool_calls: [] });
    const registry = makeExplorerRegistry();

    const context = await exploreWorkspace({ registry, llm: makeMockLlm(invoke) });

    expect(context.workspaceInfo.language).toBe("unknown");
    expect(context.workspaceInfo.framework).toBe("none");
    expect(context.buildSystems).toBeUndefined();
  });

  it("returns a fallback context when workspaceInfo is missing from JSON", async () => {
    const invoke = jest
      .fn()
      .mockResolvedValueOnce({ content: JSON.stringify({ noInfo: true }), tool_calls: [] });
    const registry = makeExplorerRegistry();

    const context = await exploreWorkspace({ registry, llm: makeMockLlm(invoke) });

    expect(context.workspaceInfo.language).toBe("unknown");
  });

  it("uses the file-list and file-read tools (registered by name) when exploring", async () => {
    const explorerOutput = JSON.stringify({
      workspaceInfo: {
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
    });

    const invoke = jest
      .fn()
      .mockResolvedValueOnce({ content: explorerOutput, tool_calls: [] });

    const mockLlm = {
      bindTools: jest.fn().mockReturnValue({ invoke }),
    } as unknown as BaseChatModel;

    const registry = makeExplorerRegistry();
    await exploreWorkspace({ registry, llm: mockLlm });

    // The LLM should have been bound with the file-list and file-read tools
    expect(mockLlm.bindTools).toHaveBeenCalledTimes(1);
    const boundTools = (mockLlm.bindTools as jest.Mock).mock.calls[0][0] as Array<{ name: string }>;
    const toolNames = boundTools.map((t) => t.name);
    expect(toolNames).toContain("file-list");
    expect(toolNames).toContain("file-read");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// WorkspaceContext type
// ─────────────────────────────────────────────────────────────────────────────

describe("WorkspaceContext type", () => {
  it("workspaceInfo key is required", () => {
    const ctx: WorkspaceContext = {
      workspaceInfo: {
        language: "python",
        framework: "django",
        packageManager: "poetry",
        hasTests: true,
        testCommand: "pytest",
        lintCommand: "flake8",
        buildCommand: "",
        entryPoints: [],
        gitInitialized: false,
      },
    };
    expect(ctx.workspaceInfo.language).toBe("python");
  });

  it("allows arbitrary additional keys in the context map", () => {
    const ctx: WorkspaceContext = {
      workspaceInfo: {
        language: "go",
        framework: "none",
        packageManager: "go mod",
        hasTests: false,
        testCommand: "",
        lintCommand: "",
        buildCommand: "",
        entryPoints: [],
        gitInitialized: true,
      },
      buildSystems: [{ name: "go", configFile: "go.mod", notes: "Standard Go module." }],
      explorerNotes: "Simple CLI tool.",
      customKey: { nested: true },
    };
    expect(ctx.buildSystems).toBeDefined();
    expect(ctx.explorerNotes).toBe("Simple CLI tool.");
    expect(ctx.customKey).toEqual({ nested: true });
  });
});
