import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import type { WorkspaceInfo } from "../workspace";

// Mock appConfig so tests don't require a real .env file
jest.mock("../config", () => ({
  appConfig: { systemPromptPath: "" },
}));

import { getSystemPrompt } from "../prompts/system";
import { appConfig } from "../config";

describe("getSystemPrompt", () => {
  // Cast to allow mutation in tests
  const cfg = appConfig as { systemPromptPath: string };

  // Temp files created during tests, cleaned up in afterEach
  const tmpFiles: string[] = [];

  function writeTmpPrompt(content: string): string {
    const tmpFile = path.join(os.tmpdir(), `test-prompt-${Date.now()}.txt`);
    fs.writeFileSync(tmpFile, content, "utf-8");
    tmpFiles.push(tmpFile);
    return tmpFile;
  }

  beforeEach(() => {
    cfg.systemPromptPath = "";
  });

  afterEach(() => {
    // Remove any temp files created during the test
    for (const f of tmpFiles.splice(0)) {
      try { fs.unlinkSync(f); } catch { /* already gone */ }
    }
  });

  // --- Template-based generation ---

  it("returns a string when called with no arguments", async () => {
    const prompt = await getSystemPrompt();
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(0);
  });

  it("includes tool names when provided via context", async () => {
    const prompt = await getSystemPrompt({ tools: ["search", "calculate"] });
    expect(prompt).toContain("search");
    expect(prompt).toContain("calculate");
  });

  it("changes content when different tools are provided", async () => {
    const promptA = await getSystemPrompt({ tools: ["search"] });
    const promptB = await getSystemPrompt({ tools: ["calculate"] });
    expect(promptA).not.toBe(promptB);
  });

  it("includes projectInfo when provided", async () => {
    const prompt = await getSystemPrompt({ projectInfo: "My awesome project" });
    expect(prompt).toContain("My awesome project");
  });

  it("includes agent identity and behavioral instructions", async () => {
    const prompt = await getSystemPrompt();
    // Identity
    expect(prompt).toMatch(/assistant/i);
    // At least one behavioral instruction keyword
    expect(prompt).toMatch(/concise|honest|precise|tool/i);
  });

  it("states no tools are available when tools array is empty", async () => {
    const prompt = await getSystemPrompt({ tools: [] });
    expect(prompt).toMatch(/no tools/i);
  });

  // --- File-based override ---

  it("returns file content when SYSTEM_PROMPT_PATH is set", async () => {
    const customPrompt = "Custom operator prompt from file.";
    cfg.systemPromptPath = writeTmpPrompt(customPrompt);

    const prompt = await getSystemPrompt();
    expect(prompt).toBe(customPrompt);
  });

  it("uses the file prompt regardless of context when SYSTEM_PROMPT_PATH is set", async () => {
    const customPrompt = "File-based prompt ignores context.";
    cfg.systemPromptPath = writeTmpPrompt(customPrompt);

    const prompt = await getSystemPrompt({ tools: ["search", "calculate"], projectInfo: "ignored" });
    expect(prompt).toBe(customPrompt);
  });

  it("throws when SYSTEM_PROMPT_PATH points to a non-existent file", async () => {
    cfg.systemPromptPath = "/non/existent/prompt.txt";
    await expect(getSystemPrompt()).rejects.toThrow();
  });

  // --- Workspace context ---

  it("includes workspace language in the prompt", async () => {
    const workspace: WorkspaceInfo = {
      language: "node",
      framework: "none",
      packageManager: "npm",
      hasTests: true,
      testCommand: "npm test",
      lintCommand: "npm run lint",
      buildCommand: "npm run build",
      entryPoints: [],
      gitInitialized: true,
    };
    const prompt = await getSystemPrompt({ workspace });
    expect(prompt).toContain("node");
    expect(prompt).toContain("npm");
  });

  it("includes workspace test command in the prompt", async () => {
    const workspace: WorkspaceInfo = {
      language: "python",
      framework: "django",
      packageManager: "poetry",
      hasTests: true,
      testCommand: "pytest",
      lintCommand: "flake8",
      buildCommand: "",
      entryPoints: [],
      gitInitialized: false,
    };
    const prompt = await getSystemPrompt({ workspace });
    expect(prompt).toContain("pytest");
    expect(prompt).toContain("django");
  });

  it("omits framework line when framework is 'none'", async () => {
    const workspace: WorkspaceInfo = {
      language: "go",
      framework: "none",
      packageManager: "go mod",
      hasTests: false,
      testCommand: "go test ./...",
      lintCommand: "",
      buildCommand: "go build ./...",
      entryPoints: [],
      gitInitialized: false,
    };
    const prompt = await getSystemPrompt({ workspace });
    expect(prompt).not.toContain("Framework:");
    expect(prompt).toContain("go");
  });
});

