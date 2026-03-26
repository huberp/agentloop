// Prevent ESM parse errors when Jest (CommonJS) requires @langchain/mistralai.
// Remove this mock and set MISTRAL_API_KEY to a real key for live LLM testing.
jest.mock("@langchain/mistralai", () => ({
  ChatMistralAI: jest.fn(),
}));

process.env.MISTRAL_API_KEY = process.env.MISTRAL_API_KEY ?? "e2e-test-key";

import * as path from "path";
import * as fs from "fs/promises";

import { ToolRegistry } from "../../../src/tools/registry";
import { toolDefinition as fileWriteDef } from "../../../src/tools/file-write";
import { toolDefinition as fileReadDef } from "../../../src/tools/file-read";
import { runSubagent } from "../../../src/subagents/runner";
import { appConfig } from "../../../src/config";
import { createMockLlm } from "../helpers/mock-llm";
import { createWorkspaceFixture } from "../helpers/workspace-fixture";

// When E2E_USE_REAL_LLM=true the test uses undefined (falls back to createLLM).
// Note: that requires removing the jest.mock above and setting a real MISTRAL_API_KEY.
const USE_REAL_LLM = process.env.E2E_USE_REAL_LLM === "true";

describe("E2E: Create a new file with specific content", () => {
  let workspaceDir: string;
  let cleanup: () => Promise<void>;
  let savedWorkspaceRoot: string;

  beforeAll(async () => {
    const fixture = await createWorkspaceFixture();
    workspaceDir = fixture.dir;
    cleanup = fixture.cleanup;
    savedWorkspaceRoot = appConfig.workspaceRoot;
    appConfig.workspaceRoot = workspaceDir;
  });

  afterAll(async () => {
    appConfig.workspaceRoot = savedWorkspaceRoot;
    await cleanup();
  });

  it("writes a file with specified content and completes in under 10 seconds", async () => {
    const registry = new ToolRegistry();
    registry.register(fileWriteDef);
    registry.register(fileReadDef);

    const expectedContent = "Hello, World!\nThis is the expected content.\n";

    // Build a mock LLM that drives the subagent to call file-write then return a response.
    const llm = USE_REAL_LLM
      ? undefined
      : createMockLlm([
          {
            // Turn 1: request a file-write tool call
            content: "",
            tool_calls: [
              {
                id: "call_write_1",
                name: "file-write",
                args: { path: "output.txt", content: expectedContent },
              },
            ],
          },
          {
            // Turn 2: final answer after seeing the tool result
            content: "File created successfully with the specified content.",
            tool_calls: [],
          },
        ]);

    const start = Date.now();

    const result = await runSubagent(
      {
        name: "create-file-agent",
        tools: ["file-write", "file-read"],
        maxIterations: 5,
      },
      'Create a file named "output.txt" with the content: Hello, World!\nThis is the expected content.',
      registry,
      llm,
    );

    const elapsed = Date.now() - start;

    // The subagent should return a non-empty final response
    expect(result.output).toBeTruthy();

    // The file must exist at the workspace root
    const filePath = path.join(workspaceDir, "output.txt");
    const written = await fs.readFile(filePath, "utf-8");
    expect(written).toBe(expectedContent);

    // The subagent should report the file it modified
    expect(result.filesModified).toBeDefined();

    // Scenario must complete within 10 seconds with the mock LLM
    expect(elapsed).toBeLessThan(10_000);
  });
});
