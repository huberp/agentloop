import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// Mock appConfig and logger before imports
jest.mock("../config", () => ({
  appConfig: {
    systemPromptPath: "",
    instructionsRoot: "",
    logger: { level: "silent", enabled: false, destination: "stdout", name: "test", timestamp: false },
  },
}));
jest.mock("../logger", () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import {
  loadInstructions,
  InstructionSet,
  matchesGlob,
  type InstructionBlock,
} from "../instructions/loader";
import { getSystemPrompt } from "../prompts/system";
import { appConfig } from "../config";

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

let tmpDir: string;

function mkDir(...segments: string[]): string {
  const dir = path.join(tmpDir, ...segments);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeFile(relativePath: string, content: string): string {
  const full = path.join(tmpDir, relativePath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, "utf-8");
  return full;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "instr-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// --------------------------------------------------------------------------
// matchesGlob
// --------------------------------------------------------------------------

describe("matchesGlob", () => {
  it("matches ** wildcard across directories", () => {
    expect(matchesGlob("src/foo/bar.ts", "src/**/*.ts")).toBe(true);
  });

  it("does not match when extension differs", () => {
    expect(matchesGlob("src/foo/bar.js", "src/**/*.ts")).toBe(false);
  });

  it("matches single * within one directory level", () => {
    expect(matchesGlob("src/bar.ts", "src/*.ts")).toBe(true);
    expect(matchesGlob("src/sub/bar.ts", "src/*.ts")).toBe(false);
  });

  it("matches ? as a single character", () => {
    expect(matchesGlob("a.ts", "?.ts")).toBe(true);
    expect(matchesGlob("ab.ts", "?.ts")).toBe(false);
  });

  it("normalises backslashes (Windows paths)", () => {
    expect(matchesGlob("src\\foo\\bar.ts", "src/**/*.ts")).toBe(true);
  });
});

// --------------------------------------------------------------------------
// File discovery
// --------------------------------------------------------------------------

describe("loadInstructions — file discovery", () => {
  it("loads .github/copilot-instructions.md when present", async () => {
    writeFile(".github/copilot-instructions.md", "Global instructions here.");
    const set = await loadInstructions(tmpDir);
    expect(set.blocks).toHaveLength(1);
    expect(set.blocks[0].body).toBe("Global instructions here.");
  });

  it("loads AGENTS.md when present", async () => {
    writeFile("AGENTS.md", "Repo-level conventions.");
    const set = await loadInstructions(tmpDir);
    expect(set.blocks).toHaveLength(1);
    expect(set.blocks[0].body).toBe("Repo-level conventions.");
  });

  it("discovers .instructions.md files recursively", async () => {
    writeFile(".instructions.md", "Root instructions.");
    writeFile("src/.instructions.md", "Source instructions.");
    writeFile("src/tools/.instructions.md", "Tool instructions.");
    const set = await loadInstructions(tmpDir);
    expect(set.blocks.length).toBe(3);
  });

  it("loads all three conventions together", async () => {
    writeFile(".github/copilot-instructions.md", "Global.");
    writeFile("AGENTS.md", "Agents.");
    writeFile("src/.instructions.md", "Scoped.");
    const set = await loadInstructions(tmpDir);
    expect(set.blocks.length).toBe(3);
  });

  it("returns empty set when no instruction files exist", async () => {
    const set = await loadInstructions(tmpDir);
    expect(set.blocks).toHaveLength(0);
  });

  it("skips empty instruction files", async () => {
    writeFile(".github/copilot-instructions.md", "");
    const set = await loadInstructions(tmpDir);
    expect(set.blocks).toHaveLength(0);
  });

  it("skips node_modules during recursive scan", async () => {
    writeFile("node_modules/.instructions.md", "Should be skipped.");
    const set = await loadInstructions(tmpDir);
    expect(set.blocks).toHaveLength(0);
  });
});

// --------------------------------------------------------------------------
// Frontmatter parsing
// --------------------------------------------------------------------------

describe("loadInstructions — frontmatter parsing", () => {
  it("parses applyTo, description, and priority from frontmatter", async () => {
    writeFile(
      ".instructions.md",
      `---\napplyTo: "src/**/*.ts"\ndescription: TypeScript rules\npriority: 10\n---\nUse strict mode.`,
    );
    const set = await loadInstructions(tmpDir);
    expect(set.blocks).toHaveLength(1);
    const block = set.blocks[0];
    expect(block.meta.applyTo).toBe("src/**/*.ts");
    expect(block.meta.description).toBe("TypeScript rules");
    expect(block.meta.priority).toBe(10);
    expect(block.body).toBe("Use strict mode.");
  });

  it("treats files without frontmatter as always-applicable", async () => {
    writeFile(".instructions.md", "No frontmatter, just text.");
    const set = await loadInstructions(tmpDir);
    expect(set.blocks).toHaveLength(1);
    expect(set.blocks[0].meta.applyTo).toBeUndefined();
    expect(set.blocks[0].meta.priority).toBe(0);
  });

  it("defaults priority to 0 when not specified", async () => {
    writeFile(".instructions.md", "---\ndescription: test\n---\nBody.");
    const set = await loadInstructions(tmpDir);
    expect(set.blocks[0].meta.priority).toBe(0);
  });

  it("handles single-quoted values in frontmatter", async () => {
    writeFile(".instructions.md", "---\napplyTo: 'docs/**'\n---\nDocs rules.");
    const set = await loadInstructions(tmpDir);
    expect(set.blocks[0].meta.applyTo).toBe("docs/**");
  });
});

// --------------------------------------------------------------------------
// InstructionSet.getActive — applyTo filtering
// --------------------------------------------------------------------------

describe("InstructionSet.getActive — applyTo filtering", () => {
  it("returns all blocks when no context is provided", async () => {
    writeFile(".instructions.md", "Always applies.");
    const set = await loadInstructions(tmpDir);
    const active = set.getActive();
    expect(active).toHaveLength(1);
  });

  it("includes blocks without applyTo regardless of context", async () => {
    writeFile(".instructions.md", "Always applies.");
    const set = await loadInstructions(tmpDir);
    const active = set.getActive({ activeFilePath: "anything.py" });
    expect(active).toHaveLength(1);
  });

  it("includes scoped block when activeFilePath matches applyTo", async () => {
    writeFile(
      ".instructions.md",
      '---\napplyTo: "src/**/*.ts"\n---\nTS rules.',
    );
    const set = await loadInstructions(tmpDir);
    expect(set.getActive({ activeFilePath: "src/index.ts" })).toHaveLength(1);
  });

  it("excludes scoped block when activeFilePath does not match applyTo", async () => {
    writeFile(
      ".instructions.md",
      '---\napplyTo: "src/**/*.ts"\n---\nTS rules.',
    );
    const set = await loadInstructions(tmpDir);
    expect(set.getActive({ activeFilePath: "docs/readme.md" })).toHaveLength(0);
  });

  it("excludes scoped block when no activeFilePath is given", async () => {
    writeFile(
      ".instructions.md",
      '---\napplyTo: "src/**/*.ts"\n---\nTS rules.',
    );
    const set = await loadInstructions(tmpDir);
    expect(set.getActive()).toHaveLength(0);
    expect(set.getActive({})).toHaveLength(0);
  });
});

// --------------------------------------------------------------------------
// InstructionSet.getActive — priority ordering
// --------------------------------------------------------------------------

describe("InstructionSet.getActive — priority ordering", () => {
  it("returns blocks sorted by priority descending", async () => {
    writeFile(
      ".github/copilot-instructions.md",
      "---\npriority: 5\n---\nMedium priority.",
    );
    writeFile("AGENTS.md", "---\npriority: 100\n---\nHighest priority.");
    writeFile(".instructions.md", "---\npriority: 1\n---\nLow priority.");

    const set = await loadInstructions(tmpDir);
    const active = set.getActive();
    expect(active).toHaveLength(3);
    expect(active[0].meta.priority).toBe(100);
    expect(active[1].meta.priority).toBe(5);
    expect(active[2].meta.priority).toBe(1);
  });
});

// --------------------------------------------------------------------------
// System prompt injection
// --------------------------------------------------------------------------

describe("system prompt — instruction injection", () => {
  const cfg = appConfig as { systemPromptPath: string };

  beforeEach(() => {
    cfg.systemPromptPath = "";
  });

  it("appends ## Instructions section when instructions are provided", async () => {
    const instructions: InstructionBlock[] = [
      {
        filePath: "/fake/instructions.md",
        meta: { priority: 0 },
        body: "Follow these coding standards.",
      },
    ];
    const prompt = await getSystemPrompt({ instructions });
    expect(prompt).toContain("## Instructions");
    expect(prompt).toContain("Follow these coding standards.");
  });

  it("does not include ## Instructions when no instructions are provided", async () => {
    const prompt = await getSystemPrompt({});
    expect(prompt).not.toContain("## Instructions");
  });

  it("does not include ## Instructions when instructions array is empty", async () => {
    const prompt = await getSystemPrompt({ instructions: [] });
    expect(prompt).not.toContain("## Instructions");
  });

  it("preserves instruction priority order in the prompt", async () => {
    const instructions: InstructionBlock[] = [
      { filePath: "/a.md", meta: { priority: 10 }, body: "FIRST BLOCK" },
      { filePath: "/b.md", meta: { priority: 5 }, body: "SECOND BLOCK" },
    ];
    const prompt = await getSystemPrompt({ instructions });
    const firstIdx = prompt.indexOf("FIRST BLOCK");
    const secondIdx = prompt.indexOf("SECOND BLOCK");
    expect(firstIdx).toBeLessThan(secondIdx);
  });

  it("composes instructions with tool names and workspace info", async () => {
    const instructions: InstructionBlock[] = [
      { filePath: "/x.md", meta: { priority: 0 }, body: "Custom rule." },
    ];
    const prompt = await getSystemPrompt({
      tools: ["file-read"],
      instructions,
    });
    expect(prompt).toContain("file-read");
    expect(prompt).toContain("Custom rule.");
    expect(prompt).toContain("## Instructions");
  });
});
