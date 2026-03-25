// Mock ChatMistralAI before any imports — prevents ESM parse errors in Jest
jest.mock("@langchain/mistralai", () => ({
  ChatMistralAI: jest.fn(),
}));

import { z } from "zod";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

import { ToolRegistry } from "../tools/registry";
import { generatePlan, validatePlan, refinePlan } from "../subagents/planner";
import type { Plan } from "../subagents/planner";
import type { WorkspaceInfo } from "../workspace";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Build a mock LLM whose invoke responses are controlled per test. */
function makeMockLlm(invokeFn: jest.Mock): BaseChatModel {
  return {
    bindTools: jest.fn().mockReturnValue({ invoke: invokeFn }),
  } as unknown as BaseChatModel;
}

/** Create a registry pre-populated with zero-argument tools. */
function makeRegistry(...names: string[]): ToolRegistry {
  const registry = new ToolRegistry();
  for (const name of names) {
    registry.register({
      name,
      description: `${name} tool`,
      schema: z.object({}),
      execute: async () => "ok",
    });
  }
  return registry;
}

/** A representative workspace used across tests. */
const MOCK_WORKSPACE: WorkspaceInfo = {
  language: "node",
  framework: "express",
  packageManager: "npm",
  hasTests: true,
  testCommand: "npm test",
  lintCommand: "npm run lint",
  buildCommand: "npm run build",
  entryPoints: ["src/index.ts"],
  gitInitialized: true,
};

// ─────────────────────────────────────────────────────────────────────────────
// generatePlan
// ─────────────────────────────────────────────────────────────────────────────

describe("generatePlan", () => {
  it("(a) returns a plan with steps from the LLM output", async () => {
    const mockPlan: Plan = {
      steps: [
        {
          description: "Read existing routes file",
          toolsNeeded: ["file-read"],
          estimatedComplexity: "low",
        },
        {
          description: "Write new endpoint",
          toolsNeeded: ["file-write"],
          estimatedComplexity: "medium",
        },
        {
          description: "Run tests",
          toolsNeeded: ["code-run"],
          estimatedComplexity: "low",
        },
      ],
    };

    const invoke = jest
      .fn()
      .mockResolvedValueOnce({ content: JSON.stringify(mockPlan), tool_calls: [] });

    const registry = makeRegistry("file-read", "file-write", "code-run");
    const plan = await generatePlan(
      "Add a new endpoint to the Express app",
      MOCK_WORKSPACE,
      registry,
      makeMockLlm(invoke)
    );

    expect(plan.steps).toHaveLength(3);
    expect(plan.steps[0].description).toBe("Read existing routes file");
    expect(plan.steps[0].toolsNeeded).toContain("file-read");
    expect(plan.steps[1].estimatedComplexity).toBe("medium");
  });

  it("passes workspace info and available tool names to the LLM", async () => {
    const mockPlan: Plan = {
      steps: [{ description: "step", toolsNeeded: [], estimatedComplexity: "low" }],
    };

    const invokeWithCapture = jest
      .fn()
      .mockResolvedValueOnce({ content: JSON.stringify(mockPlan), tool_calls: [] });

    const mockLlm = {
      bindTools: jest.fn().mockReturnValue({ invoke: invokeWithCapture }),
    } as unknown as BaseChatModel;

    const registry = makeRegistry("file-read", "file-write");
    await generatePlan("my task", MOCK_WORKSPACE, registry, mockLlm);

    // The user message passed to invoke should contain workspace and tool info
    const messages: Array<{ content: string }> = invokeWithCapture.mock.calls[0][0];
    const userMsg = messages.find((m) => typeof m.content === "string" && m.content.includes("my task"));
    expect(userMsg).toBeDefined();
    expect(userMsg!.content).toContain("file-read");
    expect(userMsg!.content).toContain("node"); // workspace language
  });

  it("parses JSON wrapped in markdown code fences", async () => {
    const planJson = JSON.stringify({
      steps: [{ description: "do something", toolsNeeded: [], estimatedComplexity: "low" }],
    });

    const invoke = jest
      .fn()
      .mockResolvedValueOnce({ content: `\`\`\`json\n${planJson}\n\`\`\``, tool_calls: [] });

    const plan = await generatePlan("task", MOCK_WORKSPACE, new ToolRegistry(), makeMockLlm(invoke));

    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0].description).toBe("do something");
  });

  it("defaults estimatedComplexity to 'medium' for unknown values", async () => {
    const invoke = jest.fn().mockResolvedValueOnce({
      content: JSON.stringify({
        steps: [{ description: "step", toolsNeeded: [], estimatedComplexity: "unknown-value" }],
      }),
      tool_calls: [],
    });

    const plan = await generatePlan("task", MOCK_WORKSPACE, new ToolRegistry(), makeMockLlm(invoke));
    expect(plan.steps[0].estimatedComplexity).toBe("medium");
  });

  it("throws when the LLM output is not valid JSON", async () => {
    const invoke = jest
      .fn()
      .mockResolvedValueOnce({ content: "I am not JSON at all", tool_calls: [] });

    await expect(
      generatePlan("task", MOCK_WORKSPACE, new ToolRegistry(), makeMockLlm(invoke))
    ).rejects.toThrow("not valid JSON");
  });

  it("throws when the JSON is missing the steps array", async () => {
    const invoke = jest
      .fn()
      .mockResolvedValueOnce({ content: JSON.stringify({ noSteps: true }), tool_calls: [] });

    await expect(
      generatePlan("task", MOCK_WORKSPACE, new ToolRegistry(), makeMockLlm(invoke))
    ).rejects.toThrow("steps");
  });

  it("throws when a step has an empty description", async () => {
    const invoke = jest.fn().mockResolvedValueOnce({
      content: JSON.stringify({
        steps: [{ description: "", toolsNeeded: [], estimatedComplexity: "low" }],
      }),
      tool_calls: [],
    });

    await expect(
      generatePlan("task", MOCK_WORKSPACE, new ToolRegistry(), makeMockLlm(invoke))
    ).rejects.toThrow("missing or empty description");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// validatePlan
// ─────────────────────────────────────────────────────────────────────────────

describe("validatePlan", () => {
  it("(b) returns valid=true when all referenced tools are registered", () => {
    const registry = makeRegistry("file-read", "file-write");
    const plan: Plan = {
      steps: [
        { description: "do", toolsNeeded: ["file-read", "file-write"], estimatedComplexity: "low" },
      ],
    };

    const result = validatePlan(plan, registry);
    expect(result.valid).toBe(true);
    expect(result.invalidTools).toHaveLength(0);
  });

  it("(b) flags non-existent tools and sets valid=false", () => {
    const registry = makeRegistry("file-read");
    const plan: Plan = {
      steps: [
        {
          description: "do",
          toolsNeeded: ["file-read", "nonexistent-tool"],
          estimatedComplexity: "low",
        },
      ],
    };

    const result = validatePlan(plan, registry);
    expect(result.valid).toBe(false);
    expect(result.invalidTools).toContain("nonexistent-tool");
    expect(result.invalidTools).not.toContain("file-read");
  });

  it("(b) accumulates invalid tool names across multiple steps", () => {
    const registry = makeRegistry("file-read");
    const plan: Plan = {
      steps: [
        { description: "s1", toolsNeeded: ["missing-a"], estimatedComplexity: "low" },
        { description: "s2", toolsNeeded: ["missing-b"], estimatedComplexity: "medium" },
      ],
    };

    const result = validatePlan(plan, registry);
    expect(result.valid).toBe(false);
    expect(result.invalidTools).toContain("missing-a");
    expect(result.invalidTools).toContain("missing-b");
  });

  it("deduplicates invalid tool names referenced in multiple steps", () => {
    const registry = new ToolRegistry();
    const plan: Plan = {
      steps: [
        { description: "s1", toolsNeeded: ["ghost"], estimatedComplexity: "low" },
        { description: "s2", toolsNeeded: ["ghost"], estimatedComplexity: "low" },
      ],
    };

    const result = validatePlan(plan, registry);
    expect(result.invalidTools).toHaveLength(1);
    expect(result.invalidTools[0]).toBe("ghost");
  });

  it("returns valid=true when all toolsNeeded arrays are empty", () => {
    const plan: Plan = {
      steps: [{ description: "think only", toolsNeeded: [], estimatedComplexity: "low" }],
    };

    const result = validatePlan(plan, new ToolRegistry());
    expect(result.valid).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// refinePlan
// ─────────────────────────────────────────────────────────────────────────────

describe("refinePlan", () => {
  it("(c) returns a corrected plan that no longer references invalid tools", async () => {
    const originalPlan: Plan = {
      steps: [
        { description: "use bad tool", toolsNeeded: ["nonexistent-tool"], estimatedComplexity: "low" },
      ],
    };
    const correctedPlan: Plan = {
      steps: [
        { description: "use good tool", toolsNeeded: ["file-read"], estimatedComplexity: "low" },
      ],
    };

    const invoke = jest
      .fn()
      .mockResolvedValueOnce({ content: JSON.stringify(correctedPlan), tool_calls: [] });

    const registry = makeRegistry("file-read");
    const refined = await refinePlan(
      "some task",
      originalPlan,
      'Tool "nonexistent-tool" is not registered',
      MOCK_WORKSPACE,
      registry,
      makeMockLlm(invoke)
    );

    expect(refined.steps[0].toolsNeeded).toContain("file-read");
    expect(refined.steps[0].toolsNeeded).not.toContain("nonexistent-tool");
  });

  it("(c) sends the original plan and feedback text to the LLM", async () => {
    const originalPlan: Plan = {
      steps: [{ description: "do", toolsNeeded: ["bad-tool"], estimatedComplexity: "high" }],
    };
    const correctedPlan: Plan = {
      steps: [{ description: "do better", toolsNeeded: [], estimatedComplexity: "low" }],
    };

    const invokeFn = jest
      .fn()
      .mockResolvedValueOnce({ content: JSON.stringify(correctedPlan), tool_calls: [] });

    const mockLlm = {
      bindTools: jest.fn().mockReturnValue({ invoke: invokeFn }),
    } as unknown as BaseChatModel;

    await refinePlan(
      "my task",
      originalPlan,
      "feedback about bad-tool",
      MOCK_WORKSPACE,
      new ToolRegistry(),
      mockLlm
    );

    // Verify the task message passed to the subagent includes feedback and original plan
    const messages: Array<{ content: string }> = invokeFn.mock.calls[0][0];
    const userMsg = messages.find(
      (m) => typeof m.content === "string" && m.content.includes("feedback about bad-tool")
    );
    expect(userMsg).toBeDefined();
    expect(userMsg!.content).toContain("bad-tool"); // original plan referenced
  });

  it("(c) refined plan passes validation after correcting invalid tools", async () => {
    const originalPlan: Plan = {
      steps: [{ description: "use ghost", toolsNeeded: ["ghost-tool"], estimatedComplexity: "low" }],
    };
    const correctedPlan: Plan = {
      steps: [{ description: "use real tool", toolsNeeded: ["file-read"], estimatedComplexity: "low" }],
    };

    const invoke = jest
      .fn()
      .mockResolvedValueOnce({ content: JSON.stringify(correctedPlan), tool_calls: [] });

    const registry = makeRegistry("file-read");
    const refined = await refinePlan(
      "task",
      originalPlan,
      'ghost-tool is not registered',
      MOCK_WORKSPACE,
      registry,
      makeMockLlm(invoke)
    );

    const validation = validatePlan(refined, registry);
    expect(validation.valid).toBe(true);
  });
});
