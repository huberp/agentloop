// Mock ChatMistralAI before any imports — prevents ESM parse errors in Jest
jest.mock("@langchain/mistralai", () => ({
  ChatMistralAI: jest.fn(),
}));

import { z } from "zod";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

import { ToolRegistry } from "../tools/registry";
import {
  executePlan,
  InMemoryCheckpointStore,
  type ExecutionOptions,
} from "../orchestrator";
import type { Plan } from "../subagents/planner";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Build a mock LLM whose `invoke` responses are controlled per test. */
function makeMockLlm(invokeFn: jest.Mock): BaseChatModel {
  return {
    bindTools: jest.fn().mockReturnValue({ invoke: invokeFn }),
  } as unknown as BaseChatModel;
}

/** Register zero-argument dummy tools in a registry. */
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

/** A 3-step plan with all low-complexity steps (uses direct execution path). */
const THREE_STEP_PLAN: Plan = {
  steps: [
    { description: "step 1", toolsNeeded: [], estimatedComplexity: "low" },
    { description: "step 2", toolsNeeded: [], estimatedComplexity: "low" },
    { description: "step 3", toolsNeeded: [], estimatedComplexity: "low" },
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
// (a) 3-step plan executes all steps in order
// ─────────────────────────────────────────────────────────────────────────────

describe("executePlan — (a) all steps succeed", () => {
  it("executes all 3 steps in order and returns combined results", async () => {
    const invoke = jest
      .fn()
      .mockResolvedValueOnce({ content: "output 1", tool_calls: [] })
      .mockResolvedValueOnce({ content: "output 2", tool_calls: [] })
      .mockResolvedValueOnce({ content: "output 3", tool_calls: [] });

    const result = await executePlan(THREE_STEP_PLAN, new ToolRegistry(), {}, makeMockLlm(invoke));

    expect(result.success).toBe(true);
    expect(result.stepResults).toHaveLength(3);
    expect(result.stepResults[0]).toMatchObject({ stepIndex: 0, status: "success", output: "output 1" });
    expect(result.stepResults[1]).toMatchObject({ stepIndex: 1, status: "success", output: "output 2" });
    expect(result.stepResults[2]).toMatchObject({ stepIndex: 2, status: "success", output: "output 3" });
  });

  it("executes steps in order (LLM is called once per step)", async () => {
    const invoke = jest
      .fn()
      .mockResolvedValueOnce({ content: "a", tool_calls: [] })
      .mockResolvedValueOnce({ content: "b", tool_calls: [] })
      .mockResolvedValueOnce({ content: "c", tool_calls: [] });

    await executePlan(THREE_STEP_PLAN, new ToolRegistry(), {}, makeMockLlm(invoke));

    expect(invoke).toHaveBeenCalledTimes(3);
  });

  it("includes step descriptions in the results", async () => {
    const invoke = jest.fn().mockResolvedValue({ content: "ok", tool_calls: [] });

    const result = await executePlan(THREE_STEP_PLAN, new ToolRegistry(), {}, makeMockLlm(invoke));

    expect(result.stepResults[0]).toMatchObject({ description: "step 1", status: "success" });
    expect(result.stepResults[1]).toMatchObject({ description: "step 2", status: "success" });
    expect(result.stepResults[2]).toMatchObject({ description: "step 3", status: "success" });
  });

  it("uses a subagent for complex (medium/high) steps", async () => {
    const plan: Plan = {
      steps: [
        { description: "complex step", toolsNeeded: ["file-read"], estimatedComplexity: "medium" },
      ],
    };

    const invoke = jest.fn().mockResolvedValue({ content: "complex result", tool_calls: [] });
    const registry = makeRegistry("file-read");

    const result = await executePlan(plan, registry, {}, makeMockLlm(invoke));

    expect(result.stepResults[0].status).toBe("success");
    expect(result.stepResults[0].output).toBe("complex result");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (b) Step failure with retry
// ─────────────────────────────────────────────────────────────────────────────

describe("executePlan — (b) step failure with retry", () => {
  it("retries once and succeeds when the first attempt fails", async () => {
    const invoke = jest
      .fn()
      .mockResolvedValueOnce({ content: "output 1", tool_calls: [] }) // step 1
      .mockRejectedValueOnce(new Error("transient error"))            // step 2: first attempt fails
      .mockResolvedValueOnce({ content: "output 2 retry", tool_calls: [] }) // step 2: retry succeeds
      .mockResolvedValueOnce({ content: "output 3", tool_calls: [] }); // step 3

    const result = await executePlan(
      THREE_STEP_PLAN,
      new ToolRegistry(),
      { onStepFailure: "retry" },
      makeMockLlm(invoke)
    );

    expect(result.success).toBe(true);
    expect(result.stepResults[1].status).toBe("success");
    expect(result.stepResults[1].output).toBe("output 2 retry");
    expect(result.stepResults[2].status).toBe("success");
    // 4 invoke calls: step1, step2-fail, step2-retry, step3
    expect(invoke).toHaveBeenCalledTimes(4);
  });

  it("marks step as failed and continues when both attempts fail (default retry strategy)", async () => {
    const invoke = jest
      .fn()
      .mockResolvedValueOnce({ content: "output 1", tool_calls: [] }) // step 1
      .mockRejectedValueOnce(new Error("error 1"))                    // step 2: first attempt
      .mockRejectedValueOnce(new Error("error 2"))                    // step 2: retry fails too
      .mockResolvedValueOnce({ content: "output 3", tool_calls: [] }); // step 3

    const result = await executePlan(THREE_STEP_PLAN, new ToolRegistry(), {}, makeMockLlm(invoke));

    expect(result.success).toBe(false);
    expect(result.stepResults[1].status).toBe("failed");
    expect(result.stepResults[1].error).toBe("error 2");
    // Execution continues after failed step when strategy is "retry"
    expect(result.stepResults[2].status).toBe("success");
  });

  it("retry is the default failure strategy", async () => {
    const invoke = jest
      .fn()
      .mockRejectedValueOnce(new Error("fail"))
      .mockResolvedValueOnce({ content: "recovered", tool_calls: [] });

    const plan: Plan = {
      steps: [{ description: "flaky step", toolsNeeded: [], estimatedComplexity: "low" }],
    };

    // No onStepFailure option supplied — should default to "retry"
    const result = await executePlan(plan, new ToolRegistry(), {}, makeMockLlm(invoke));

    expect(result.stepResults[0].status).toBe("success");
    expect(result.stepResults[0].output).toBe("recovered");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (c) Checkpoint / resumeFrom
// ─────────────────────────────────────────────────────────────────────────────

describe("executePlan — (c) resumeFrom skips earlier steps", () => {
  it("resumeFrom: 2 skips step 1 and executes steps 2 and 3", async () => {
    const invoke = jest
      .fn()
      .mockResolvedValueOnce({ content: "output 2", tool_calls: [] }) // step 2
      .mockResolvedValueOnce({ content: "output 3", tool_calls: [] }); // step 3

    const result = await executePlan(
      THREE_STEP_PLAN,
      new ToolRegistry(),
      { resumeFrom: 2 },
      makeMockLlm(invoke)
    );

    expect(result.stepResults[0].status).toBe("skipped"); // step 1 skipped
    expect(result.stepResults[1].status).toBe("success");
    expect(result.stepResults[1].output).toBe("output 2");
    expect(result.stepResults[2].status).toBe("success");
    // LLM called only for steps 2 and 3
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("resumeFrom: 3 skips steps 1 and 2 and executes only step 3", async () => {
    const invoke = jest
      .fn()
      .mockResolvedValueOnce({ content: "output 3", tool_calls: [] });

    const result = await executePlan(
      THREE_STEP_PLAN,
      new ToolRegistry(),
      { resumeFrom: 3 },
      makeMockLlm(invoke)
    );

    expect(result.stepResults[0].status).toBe("skipped");
    expect(result.stepResults[1].status).toBe("skipped");
    expect(result.stepResults[2].status).toBe("success");
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("success is true when only non-failed steps are present", async () => {
    const invoke = jest.fn().mockResolvedValue({ content: "ok", tool_calls: [] });

    const result = await executePlan(
      THREE_STEP_PLAN,
      new ToolRegistry(),
      { resumeFrom: 2 },
      makeMockLlm(invoke)
    );

    // Skipped steps don't affect success
    expect(result.success).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// onStepFailure modes
// ─────────────────────────────────────────────────────────────────────────────

describe("executePlan — onStepFailure modes", () => {
  it('"skip" marks the failed step as skipped and continues execution', async () => {
    const invoke = jest
      .fn()
      .mockResolvedValueOnce({ content: "output 1", tool_calls: [] })
      .mockRejectedValueOnce(new Error("step 2 failed"))
      .mockResolvedValueOnce({ content: "output 3", tool_calls: [] });

    const result = await executePlan(
      THREE_STEP_PLAN,
      new ToolRegistry(),
      { onStepFailure: "skip" },
      makeMockLlm(invoke)
    );

    expect(result.stepResults[1].status).toBe("skipped");
    expect(result.stepResults[2].status).toBe("success");
    // Skipped steps don't make success false
    expect(result.success).toBe(true);
  });

  it('"abort" stops execution after the first failed step', async () => {
    const invoke = jest
      .fn()
      .mockResolvedValueOnce({ content: "output 1", tool_calls: [] })
      .mockRejectedValueOnce(new Error("step 2 failed"));

    const result = await executePlan(
      THREE_STEP_PLAN,
      new ToolRegistry(),
      { onStepFailure: "abort" },
      makeMockLlm(invoke)
    );

    // Only steps 1 and 2 are in the results; step 3 was never started
    expect(result.stepResults).toHaveLength(2);
    expect(result.stepResults[1].status).toBe("failed");
    expect(result.success).toBe(false);
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Checkpointing
// ─────────────────────────────────────────────────────────────────────────────

describe("executePlan — checkpointing", () => {
  it("saves a checkpoint after each step", async () => {
    const store = new InMemoryCheckpointStore();
    const saveSizes: number[] = [];

    const originalSave = store.save.bind(store);
    jest.spyOn(store, "save").mockImplementation(async (cp) => {
      saveSizes.push(cp.stepResults.length);
      return originalSave(cp);
    });

    const invoke = jest.fn().mockResolvedValue({ content: "ok", tool_calls: [] });

    await executePlan(THREE_STEP_PLAN, new ToolRegistry(), { checkpoint: store }, makeMockLlm(invoke));

    // Checkpoint is saved once per step: after step 1 (1 result), step 2 (2), step 3 (3)
    expect(saveSizes).toEqual([1, 2, 3]);
  });

  it("checkpoint store contains the final results after plan completion", async () => {
    const store = new InMemoryCheckpointStore();
    const invoke = jest
      .fn()
      .mockResolvedValueOnce({ content: "r1", tool_calls: [] })
      .mockResolvedValueOnce({ content: "r2", tool_calls: [] })
      .mockResolvedValueOnce({ content: "r3", tool_calls: [] });

    await executePlan(THREE_STEP_PLAN, new ToolRegistry(), { checkpoint: store }, makeMockLlm(invoke));

    const saved = await store.load();
    expect(saved).not.toBeNull();
    expect(saved!.stepResults).toHaveLength(3);
    expect(saved!.stepResults[0].output).toBe("r1");
    expect(saved!.stepResults[2].output).toBe("r3");
  });
});
