/**
 * Tests for Task 6.2: Skill Context Injection.
 * Covers render() skill fragment slots, multi-skill ordering, tool merging,
 * and instruction loading via the skill context provider.
 */

// ---------------------------------------------------------------------------
// Mocks (must be declared before imports)
// ---------------------------------------------------------------------------

jest.mock("../config", () => ({
  appConfig: {
    workspaceRoot: "/fake/ws",
    instructionsRoot: "/fake/ws",
    promptContextRefreshMs: 0,
    promptHistoryFile: "",
    logger: { level: "silent", enabled: false, destination: "stdout", name: "test", timestamp: false },
  },
}));

const mockLogger = { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() };
jest.mock("../logger", () => ({ logger: mockLogger }));

jest.mock("../skills/registry", () => ({
  skillRegistry: { listActive: jest.fn().mockReturnValue([]) },
}));

jest.mock("../workspace", () => ({
  analyzeWorkspace: jest.fn().mockResolvedValue({
    language: "node",
    framework: "none",
    packageManager: "npm",
    hasTests: false,
    testCommand: "",
    lintCommand: "",
    buildCommand: "",
    entryPoints: [],
    gitInitialized: false,
  }),
}));

jest.mock("../instructions/loader", () => ({
  loadInstructions: jest.fn().mockResolvedValue({ getActive: () => [] }),
}));

jest.mock("../tools/registry", () => ({
  toolRegistry: { list: jest.fn().mockReturnValue([]) },
}));

jest.mock("fs/promises", () => ({
  readFile: jest.fn(),
  writeFile: jest.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { PromptRegistry } from "../prompts/registry";
import type { ActiveSkillFragment } from "../skills/registry";
import { buildPromptContext, invalidateContextCache } from "../prompts/context";
import { skillRegistry } from "../skills/registry";
import { logger } from "../logger";
import * as fsPromises from "fs/promises";

// ---------------------------------------------------------------------------
// PromptRegistry.render() — skill fragment injection
// ---------------------------------------------------------------------------

describe("PromptRegistry.render() — skill fragment injection", () => {
  let reg: PromptRegistry;

  beforeEach(() => {
    reg = new PromptRegistry();
    reg.register({ name: "base", description: "", template: "Base body.", variables: [] });
  });

  it("no skills — returns base template unchanged", () => {
    const result = reg.render("base", {}, []);
    expect(result).toBe("Base body.");
  });

  it("prepend skill — fragment appears before base text", () => {
    const fragments: ActiveSkillFragment[] = [
      { name: "pre-skill", slot: "prepend", fragment: "Prepend fragment." },
    ];
    const result = reg.render("base", {}, fragments);
    expect(result).toBe("Prepend fragment.\n\nBase body.");
  });

  it("append skill — fragment appears after base text", () => {
    const fragments: ActiveSkillFragment[] = [
      { name: "app-skill", slot: "append", fragment: "Append fragment." },
    ];
    const result = reg.render("base", {}, fragments);
    expect(result).toBe("Base body.\n\nAppend fragment.");
  });

  it("section skill — ## Skill: block appears between base and append position", () => {
    const fragments: ActiveSkillFragment[] = [
      { name: "sec-skill", slot: "section", fragment: "Section content." },
    ];
    const result = reg.render("base", {}, fragments);
    expect(result).toBe("Base body.\n\n## Skill: sec-skill\n\nSection content.");
  });

  it("multiple skills of different slots — correct order: prepend → base → section → append", () => {
    const fragments: ActiveSkillFragment[] = [
      { name: "a-append", slot: "append", fragment: "Appended." },
      { name: "b-prepend", slot: "prepend", fragment: "Prepended." },
      { name: "c-section", slot: "section", fragment: "Sectioned." },
    ];
    const result = reg.render("base", {}, fragments);
    expect(result).toBe("Prepended.\n\nBase body.\n\n## Skill: c-section\n\nSectioned.\n\nAppended.");
  });

  it("multiple append skills — both fragments concatenated in order", () => {
    const fragments: ActiveSkillFragment[] = [
      { name: "app1", slot: "append", fragment: "First append." },
      { name: "app2", slot: "append", fragment: "Second append." },
    ];
    const result = reg.render("base", {}, fragments);
    expect(result).toBe("Base body.\n\nFirst append.\n\nSecond append.");
  });
});

// ---------------------------------------------------------------------------
// Skill context provider (via buildPromptContext)
// ---------------------------------------------------------------------------

describe("skill context provider", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    invalidateContextCache();
    (skillRegistry.listActive as jest.Mock).mockReturnValue([]);
  });

  it("when skills are active, buildPromptContext() includes skills with correct name and slot", async () => {
    (skillRegistry.listActive as jest.Mock).mockReturnValue([
      { name: "my-skill", slot: "append", promptFragment: "Do extra things.", tools: [] },
    ]);

    const ctx = await buildPromptContext();
    expect(ctx.skills).toHaveLength(1);
    expect(ctx.skills[0].name).toBe("my-skill");
    expect(ctx.skills[0].slot).toBe("append");
    expect(ctx.skills[0].fragment).toBe("Do extra things.");
  });

  it("skill tools are merged into context.tools", async () => {
    (skillRegistry.listActive as jest.Mock).mockReturnValue([
      { name: "git-skill", slot: "append", promptFragment: "Git helpers.", tools: ["git-commit", "git-diff"] },
    ]);

    const ctx = await buildPromptContext();
    const toolNames = ctx.tools.map((t) => t.name);
    expect(toolNames).toContain("git-commit");
    expect(toolNames).toContain("git-diff");
    const gitCommit = ctx.tools.find((t) => t.name === "git-commit")!;
    expect(gitCommit.description).toBe("Activated by skill: git-skill");
  });

  it("skill with instructions path loads and appends the file content to the fragment", async () => {
    (skillRegistry.listActive as jest.Mock).mockReturnValue([
      {
        name: "inst-skill",
        slot: "prepend",
        promptFragment: "Base fragment.",
        instructions: "/path/to/instructions.md",
      },
    ]);
    (fsPromises.readFile as jest.Mock).mockResolvedValueOnce("Loaded instructions.");

    const ctx = await buildPromptContext();
    expect(ctx.skills).toHaveLength(1);
    expect(ctx.skills[0].fragment).toBe("Base fragment.\n\n---\n\nLoaded instructions.");
  });

  it("skill with missing instructions file logs a warning and uses base fragment only", async () => {
    (skillRegistry.listActive as jest.Mock).mockReturnValue([
      {
        name: "fail-skill",
        slot: "section",
        promptFragment: "Fallback fragment.",
        instructions: "/nonexistent/instructions.md",
      },
    ]);
    (fsPromises.readFile as jest.Mock).mockRejectedValueOnce(new Error("ENOENT: no such file"));

    const ctx = await buildPromptContext();
    expect(ctx.skills).toHaveLength(1);
    expect(ctx.skills[0].fragment).toBe("Fallback fragment.");
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ skillName: "fail-skill", instructionsPath: "/nonexistent/instructions.md" }),
      expect.stringContaining("not found"),
    );
  });
});
