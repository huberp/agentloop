// Prevent ESM parse errors when Jest (CommonJS) requires @langchain/mistralai.
// Remove this mock and set MISTRAL_API_KEY to a real key for live LLM testing.
jest.mock("@langchain/mistralai", () => ({
  ChatMistralAI: jest.fn(),
}));

process.env.MISTRAL_API_KEY = process.env.MISTRAL_API_KEY ?? "e2e-test-key";

import * as path from "path";
import * as fs from "fs/promises";

import { ToolRegistry } from "../../../src/tools/registry";
import { toolDefinition as codeSearchDef } from "../../../src/tools/code-search";
import { toolDefinition as fileEditDef } from "../../../src/tools/file-edit";
import { toolDefinition as codeRunDef } from "../../../src/tools/code-run";
import { runSubagent } from "../../../src/subagents/runner";
import { appConfig } from "../../../src/config";
import { createMockLlm } from "../helpers/mock-llm";
import { createWorkspaceFixture } from "../helpers/workspace-fixture";

// When E2E_USE_REAL_LLM=true the test uses undefined (falls back to createLLM).
// Note: that requires removing the jest.mock above and setting a real MISTRAL_API_KEY.
const USE_REAL_LLM = process.env.E2E_USE_REAL_LLM === "true";

/** The buggy source file written to the temp workspace before each test. */
const BUGGY_JS_CONTENT = `function add(a, b) {
  return a - b;
}
console.log(add(1, 2));
`;

describe("E2E: Find and fix a bug", () => {
  let workspaceDir: string;
  let cleanup: () => Promise<void>;
  let savedWorkspaceRoot: string;

  beforeAll(async () => {
    const fixture = await createWorkspaceFixture();
    workspaceDir = fixture.dir;
    cleanup = fixture.cleanup;

    // Pre-populate the workspace with a file containing a known bug
    await fixture.writeFile("buggy.js", BUGGY_JS_CONTENT);

    savedWorkspaceRoot = appConfig.workspaceRoot;
    appConfig.workspaceRoot = workspaceDir;
  });

  afterAll(async () => {
    appConfig.workspaceRoot = savedWorkspaceRoot;
    await cleanup();
  });

  it("searches for a bug, edits the file, runs verification, and completes in under 10 seconds", async () => {
    const registry = new ToolRegistry();
    registry.register(codeSearchDef);
    registry.register(fileEditDef);
    registry.register(codeRunDef);

    // Absolute path needed for code_run in "file" mode
    const buggyFilePath = path.join(workspaceDir, "buggy.js");

    // Build a mock LLM that drives the subagent through the full find-and-fix flow:
    //   1. code-search  → locate the subtraction bug
    //   2. file-edit    → replace the buggy line
    //   3. code_run     → run the fixed script to confirm output is 3
    //   4. final answer
    const llm = USE_REAL_LLM
      ? undefined
      : createMockLlm([
          {
            // Turn 1: search for the subtraction pattern
            content: "",
            tool_calls: [
              {
                id: "call_search_1",
                name: "code-search",
                args: { pattern: "a - b", mode: "literal", path: "." },
              },
            ],
          },
          {
            // Turn 2: edit the bug (after seeing the search result)
            content: "",
            tool_calls: [
              {
                id: "call_edit_1",
                name: "file-edit",
                args: {
                  path: "buggy.js",
                  search: "return a - b;",
                  replace: "return a + b;",
                },
              },
            ],
          },
          {
            // Turn 3: run the fixed file to verify the output
            content: "",
            tool_calls: [
              {
                id: "call_run_1",
                name: "code_run",
                args: {
                  mode: "file",
                  file: buggyFilePath,
                  interpreter: "node",
                },
              },
            ],
          },
          {
            // Turn 4: final answer after seeing the run output (3)
            content: "Bug fixed! The addition function now correctly returns 3.",
            tool_calls: [],
          },
        ]);

    const start = Date.now();

    const result = await runSubagent(
      {
        name: "find-and-fix-agent",
        tools: ["code-search", "file-edit", "code_run"],
        maxIterations: 10,
      },
      "Find and fix the bug in buggy.js: the add function subtracts instead of adding.",
      registry,
      llm,
    );

    const elapsed = Date.now() - start;

    // The final answer should be non-empty
    expect(result.output).toBeTruthy();

    // The file should now contain the fix and not the original bug
    const fixedContent = await fs.readFile(path.join(workspaceDir, "buggy.js"), "utf-8");
    expect(fixedContent).toContain("return a + b;");
    expect(fixedContent).not.toContain("return a - b;");

    // Scenario must complete within 10 seconds with the mock LLM
    expect(elapsed).toBeLessThan(10_000);
  });
});
