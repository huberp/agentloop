// Prevent ESM parse errors when Jest (CommonJS) requires @langchain/mistralai.
// Remove this mock and set MISTRAL_API_KEY to a real key for live LLM testing.
jest.mock("@langchain/mistralai", () => ({
  ChatMistralAI: jest.fn(),
}));

process.env.MISTRAL_API_KEY = process.env.MISTRAL_API_KEY ?? "e2e-test-key";

import { ToolRegistry } from "../../../src/tools/registry";
import { toolDefinition as fileWriteDef } from "../../../src/tools/file-write";
import { toolDefinition as fileReadDef } from "../../../src/tools/file-read";
import { toolDefinition as fileEditDef } from "../../../src/tools/file-edit";
import { generatePlan } from "../../../src/subagents/planner";
import { appConfig } from "../../../src/config";
import { createMockLlm } from "../helpers/mock-llm";
import { createWorkspaceFixture } from "../helpers/workspace-fixture";
import type { WorkspaceInfo } from "../../../src/workspace";

// When E2E_USE_REAL_LLM=true the test uses undefined (falls back to createLLM).
// Note: that requires removing the jest.mock above and setting a real MISTRAL_API_KEY.
const USE_REAL_LLM = process.env.E2E_USE_REAL_LLM === "true";

/** Representative workspace metadata used as planner input. */
const MOCK_WORKSPACE: WorkspaceInfo = {
  language: "node",
  framework: "express",
  packageManager: "npm",
  hasTests: true,
  testCommand: "npm test",
  lintCommand: "npm run lint",
  buildCommand: "npm run build",
  entryPoints: ["src/index.ts"],
  gitInitialized: false,
};

describe("E2E: Generate a plan for a feature", () => {
  let cleanup: () => Promise<void>;
  let savedWorkspaceRoot: string;

  beforeAll(async () => {
    const fixture = await createWorkspaceFixture();
    cleanup = fixture.cleanup;
    savedWorkspaceRoot = appConfig.workspaceRoot;
    appConfig.workspaceRoot = fixture.dir;
  });

  afterAll(async () => {
    appConfig.workspaceRoot = savedWorkspaceRoot;
    await cleanup();
  });

  it("generates a valid multi-step plan for a new API endpoint and completes in under 10 seconds", async () => {
    const registry = new ToolRegistry();
    registry.register(fileWriteDef);
    registry.register(fileReadDef);
    registry.register(fileEditDef);

    // The plan the mock LLM will return — must be valid JSON matching the Plan schema
    const mockedPlanJson = JSON.stringify({
      steps: [
        {
          description: "Read the existing routes file to understand the current structure",
          toolsNeeded: ["file-read"],
          estimatedComplexity: "low",
        },
        {
          description: "Write the new GET /health endpoint handler to the routes file",
          toolsNeeded: ["file-write"],
          estimatedComplexity: "medium",
        },
        {
          description: "Edit the main index file to register the new health route",
          toolsNeeded: ["file-edit"],
          estimatedComplexity: "low",
        },
      ],
    });

    // The planner subagent has no tools (tools: []); the LLM responds once with the plan JSON.
    const llm = USE_REAL_LLM
      ? undefined
      : createMockLlm([
          {
            content: mockedPlanJson,
            tool_calls: [],
          },
        ]);

    const start = Date.now();

    const plan = await generatePlan(
      "Add a new GET /health endpoint to the Express app",
      MOCK_WORKSPACE,
      registry,
      llm,
    );

    const elapsed = Date.now() - start;

    // The plan must have the expected number of steps
    expect(plan.steps).toHaveLength(3);

    // Step 1: read existing code
    expect(plan.steps[0].description).toMatch(/read/i);
    expect(plan.steps[0].toolsNeeded).toContain("file-read");
    expect(["low", "medium", "high"]).toContain(plan.steps[0].estimatedComplexity);

    // Step 2: write the new endpoint
    expect(plan.steps[1].description).toMatch(/write/i);
    expect(plan.steps[1].toolsNeeded).toContain("file-write");
    expect(["low", "medium", "high"]).toContain(plan.steps[1].estimatedComplexity);

    // Step 3: edit to register the route
    expect(plan.steps[2].description).toMatch(/edit/i);
    expect(plan.steps[2].toolsNeeded).toContain("file-edit");
    expect(["low", "medium", "high"]).toContain(plan.steps[2].estimatedComplexity);

    // All tool names referenced in the plan must be registered
    for (const step of plan.steps) {
      for (const toolName of step.toolsNeeded) {
        expect(registry.getDefinition(toolName)).toBeDefined();
      }
    }

    // Scenario must complete within 10 seconds with the mock LLM
    expect(elapsed).toBeLessThan(10_000);
  });
});
