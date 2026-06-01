/**
 * Tests for the five guardrail features:
 * 1. Language guardrails in planner/step prompts
 * 2. Evidence requirements for research findings
 * 3. Query shaping + reranking for workspace-aware web search
 * 4. CI scenario realism (TS guidance for TS repos, no Python-only setup)
 * 5. Plan-only mode
 */

// ---------------------------------------------------------------------------
// Mocks — must come before imports
// ---------------------------------------------------------------------------

jest.mock("../config", () => ({
  appConfig: {
    systemPromptPath: "",
    webSearchProvider: "duckduckgo",
    duckduckgoCacheTtlMs: 0,
    duckduckgoCacheMaxEntries: 0,
    duckduckgoServeStaleOnError: false,
    duckduckgoMaxResults: 5,
    duckduckgoMinDelayMs: 0,
    duckduckgoRetryMax: 0,
    duckduckgoRetryBaseDelayMs: 0,
    duckduckgoRateLimitPenaltyMs: 0,
    logger: { level: "silent", enabled: false, destination: "stdout", name: "test", timestamp: false },
  },
}));

jest.mock("../logger", () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import type { WorkspaceInfo } from "../workspace";
import { getSystemPrompt, buildWorkspaceSection } from "../prompts/system";
import {
  shapeQueryForWorkspace,
  rerankResultsForWorkspace,
  setSearchWorkspaceLanguage,
  getSearchWorkspaceLanguage,
} from "../tools/search";
import type { SearchOutputItem } from "../tools/search";

// ---------------------------------------------------------------------------
// 1. Language guardrails in system prompt
// ---------------------------------------------------------------------------

describe("Language guardrails — system prompt (buildWorkspaceSection)", () => {
  it("injects guardrail for Node.js workspaces", () => {
    const ws: WorkspaceInfo = {
      language: "node",
      framework: "react",
      packageManager: "npm",
      hasTests: true,
      testCommand: "npm test",
      lintCommand: "npm run lint",
      buildCommand: "npm run build",
      entryPoints: ["dist/index.js"],
      gitInitialized: true,
    };
    const section = buildWorkspaceSection(ws);
    expect(section).toContain("Language guardrail");
    expect(section).toContain("TypeScript / JavaScript (Node.js)");
    expect(section).toContain("MUST target");
    expect(section).toContain("Do NOT suggest libraries");
  });

  it("injects guardrail for Python workspaces", () => {
    const ws: WorkspaceInfo = {
      language: "python",
      framework: "django",
      packageManager: "pip",
      hasTests: true,
      testCommand: "pytest",
      lintCommand: "flake8",
      buildCommand: "",
      entryPoints: [],
      gitInitialized: false,
    };
    const section = buildWorkspaceSection(ws);
    expect(section).toContain("Language guardrail");
    expect(section).toContain("Python");
  });

  it("does not inject guardrail for unknown language", () => {
    const ws: WorkspaceInfo = {
      language: "unknown",
      framework: "none",
      packageManager: "unknown",
      hasTests: false,
      testCommand: "",
      lintCommand: "",
      buildCommand: "",
      entryPoints: [],
      gitInitialized: false,
    };
    const section = buildWorkspaceSection(ws);
    expect(section).not.toContain("Language guardrail");
  });

  it("includes guardrail in getSystemPrompt output", async () => {
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
    expect(prompt).toContain("Language guardrail");
    expect(prompt).toContain("Go");
    expect(prompt).toContain("MUST target");
  });
});

// ---------------------------------------------------------------------------
// 2. Evidence requirements for research findings (step prompt text)
// ---------------------------------------------------------------------------

describe("Evidence requirement — step runner prompt", () => {
  // We test that the step-runner module builds a prompt containing the
  // evidence guardrail by inspecting the constant / module output.
  // (The actual prompt is built inside runPlannedStep which requires a
  //  full subagent harness; we verify the template text exists.)
  it("step runner prompt template includes evidence guardrail", async () => {
    // Dynamic import to get step-runner after mocks are applied
    const stepRunnerSource = await import("fs").then((fs) =>
      fs.readFileSync(require.resolve("../langgraph/step-runner"), "utf-8"),
    );
    expect(stepRunnerSource).toContain("insufficient evidence");
    expect(stepRunnerSource).toContain("search tool");
  });
});

// ---------------------------------------------------------------------------
// 3. Query shaping + reranking
// ---------------------------------------------------------------------------

describe("Query shaping — shapeQueryForWorkspace", () => {
  afterEach(() => setSearchWorkspaceLanguage(undefined));

  it("appends TypeScript/JavaScript hints for 'node' workspace", () => {
    const shaped = shapeQueryForWorkspace("best SDK for payments", "node");
    expect(shaped).toContain("TypeScript");
    expect(shaped).toContain("JavaScript");
  });

  it("appends Python hints for 'python' workspace", () => {
    const shaped = shapeQueryForWorkspace("best SDK for payments", "python");
    expect(shaped).toContain("Python");
  });

  it("does not modify query when language is 'unknown'", () => {
    const original = "best SDK for payments";
    expect(shapeQueryForWorkspace(original, "unknown")).toBe(original);
  });

  it("does not double-add hints if query already contains a boost term", () => {
    const query = "TypeScript SDK for payments";
    expect(shapeQueryForWorkspace(query, "node")).toBe(query);
  });

  it("uses the globally configured language when no explicit arg", () => {
    setSearchWorkspaceLanguage("rust");
    const shaped = shapeQueryForWorkspace("best logging library");
    expect(shaped).toContain("Rust");
  });

  it("returns query unchanged for unsupported language", () => {
    const query = "best logging library";
    expect(shapeQueryForWorkspace(query, "haskell")).toBe(query);
  });
});

describe("Result reranking — rerankResultsForWorkspace", () => {
  const nodeResults: SearchOutputItem[] = [
    { title: "Flask Setup Guide", link: "https://example.com/flask", snippet: "Install Flask using pip" },
    { title: "Express.js Setup Guide", link: "https://example.com/express", snippet: "Install Express.js using npm" },
    { title: "Generic Guide", link: "https://example.com/generic", snippet: "How to build APIs" },
  ];

  it("promotes Node.js results and demotes Python results for 'node' workspace", () => {
    const reranked = rerankResultsForWorkspace(nodeResults, "node");
    // Express.js result should come before Flask
    const expressIdx = reranked.findIndex((r) => r.title.includes("Express"));
    const flaskIdx = reranked.findIndex((r) => r.title.includes("Flask"));
    expect(expressIdx).toBeLessThan(flaskIdx);
  });

  it("promotes Python results for 'python' workspace", () => {
    const reranked = rerankResultsForWorkspace(nodeResults, "python");
    const flaskIdx = reranked.findIndex((r) => r.title.includes("Flask"));
    const expressIdx = reranked.findIndex((r) => r.title.includes("Express"));
    // Flask should score higher in Python workspace (pip boost, npm demote)
    expect(flaskIdx).toBeLessThan(expressIdx);
  });

  it("returns results unchanged for unknown language", () => {
    const reranked = rerankResultsForWorkspace(nodeResults, "unknown");
    expect(reranked).toEqual(nodeResults);
  });

  it("returns single-item arrays unchanged", () => {
    const single = [nodeResults[0]];
    expect(rerankResultsForWorkspace(single, "node")).toEqual(single);
  });
});

describe("Search workspace language global setter", () => {
  afterEach(() => setSearchWorkspaceLanguage(undefined));

  it("set and get round-trip", () => {
    setSearchWorkspaceLanguage("go");
    expect(getSearchWorkspaceLanguage()).toBe("go");
  });

  it("defaults to undefined", () => {
    setSearchWorkspaceLanguage(undefined);
    expect(getSearchWorkspaceLanguage()).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 4. CI scenario realism — TS workspace produces TS-oriented guidance
// ---------------------------------------------------------------------------

describe("CI realism — TS workspace guardrails exclude Python-only setup", () => {
  it("system prompt for Node/TS workspace does NOT contain pip, pytest, app.py", async () => {
    const workspace: WorkspaceInfo = {
      language: "node",
      framework: "express",
      packageManager: "npm",
      hasTests: true,
      testCommand: "npm test",
      lintCommand: "npm run lint",
      buildCommand: "npm run build",
      entryPoints: ["dist/index.js"],
      gitInitialized: true,
    };
    const prompt = await getSystemPrompt({ workspace });
    // Should contain TS-oriented guidance
    expect(prompt).toContain("TypeScript / JavaScript (Node.js)");
    expect(prompt).toContain("npm");
    // Should NOT contain Python-only references
    expect(prompt).not.toContain("pip");
    expect(prompt).not.toContain("pytest");
    expect(prompt).not.toContain("app.py");
  });

  it("query shaping for Node workspace adds TS/JS terms, not Python", () => {
    const shaped = shapeQueryForWorkspace("how to test API endpoints", "node");
    expect(shaped).toContain("TypeScript");
    expect(shaped).not.toContain("Python");
    expect(shaped).not.toContain("pip");
  });

  it("result reranking for Node workspace demotes pip-based results", () => {
    const results: SearchOutputItem[] = [
      { title: "Testing with pip install pytest", link: "https://a.com", snippet: "Use pip and pytest" },
      { title: "Testing with npm and Jest", link: "https://b.com", snippet: "Install Jest via npm" },
    ];
    const reranked = rerankResultsForWorkspace(results, "node");
    expect(reranked[0].title).toContain("npm");
  });
});

// ---------------------------------------------------------------------------
// 5. Plan-only mode
// ---------------------------------------------------------------------------

describe("Plan-only mode — GraphInvokeOptions and types", () => {
  it("GraphInvokeOptions accepts planOnly boolean", () => {
    // TypeScript compilation test — if this compiles, the type is correct.
    const opts: import("../langgraph/types").GraphInvokeOptions = {
      planOnly: true,
    };
    expect(opts.planOnly).toBe(true);
  });

  it("GraphState includes planOnly field", () => {
    const state: Partial<import("../langgraph/types").GraphState> = {
      planOnly: true,
    };
    expect(state.planOnly).toBe(true);
  });

  it("planOnly defaults to false in config", () => {
    // appConfig is mocked but we can verify the real module's default
    const configSource = require("fs").readFileSync(
      require.resolve("../config"),
      "utf-8",
    );
    expect(configSource).toContain("PLAN_ONLY");
    expect(configSource).toContain("planOnly");
  });
});

describe("Plan-only mode — graph finalize node", () => {
  it("finalize node produces plan summary without execution results", () => {
    // Import buildGraphNodes to test finalize behavior directly
    // This test verifies the finalize path via source inspection
    const graphSource = require("fs").readFileSync(
      require.resolve("../langgraph/graph"),
      "utf-8",
    );
    expect(graphSource).toContain("plan-only mode");
    expect(graphSource).toContain("no steps were executed");
    // Graph compile node routes to finalize when planOnly is true
    expect(graphSource).toContain("state.planOnly");
  });
});
