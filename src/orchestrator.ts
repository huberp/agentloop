import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

import { logger } from "./logger";
import { ToolRegistry } from "./tools/registry";
import { SubagentManager } from "./subagents/manager";
import { runSubagent } from "./subagents/runner";
import type { Plan, PlanStep } from "./subagents/planner";
import type { SubagentResult } from "./subagents/types";
import type { AgentProfileRegistry } from "./agents/registry";
import { activateProfile } from "./agents/activator";
import { createLLM } from "./llm";
import { appConfig } from "./config";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Result of executing a single plan step. */
export interface StepResult {
  /** 0-based index of the step in the plan. */
  stepIndex: number;
  /** Human-readable description of the step. */
  description: string;
  /** Output produced by the step, or empty string when skipped/failed. */
  output: string;
  /** Execution status. */
  status: "success" | "failed" | "skipped";
  /** Error message when status is "failed". */
  error?: string;
}

/** Combined result of executing an entire plan. */
export interface ExecutionResult {
  /** Per-step results in execution order. */
  stepResults: StepResult[];
  /** True when no step ended with status "failed". */
  success: boolean;
}

/** Checkpoint state persisted after each completed step. */
export interface Checkpoint {
  /** Results accumulated so far (one entry per processed step, in order). */
  stepResults: StepResult[];
}

/** Interface for loading and saving checkpoint state externally. */
export interface CheckpointStore {
  save(checkpoint: Checkpoint): Promise<void>;
  load(): Promise<Checkpoint | null>;
}

/** In-memory checkpoint store — used by default when no store is supplied. */
export class InMemoryCheckpointStore implements CheckpointStore {
  private data: Checkpoint | null = null;

  async save(checkpoint: Checkpoint): Promise<void> {
    // StepResult contains only primitive fields, so spreading the array is a sufficient copy
    this.data = { stepResults: [...checkpoint.stepResults] };
  }

  async load(): Promise<Checkpoint | null> {
    return this.data;
  }
}

/** Controls how the orchestrator responds when a step throws an exception. */
export type FailureStrategy = "retry" | "skip" | "abort";

/** Options controlling orchestrator behaviour. */
export interface ExecutionOptions {
  /**
   * 1-based step number to resume execution from.
   * Steps numbered below this value are skipped (marked as "skipped").
   * Defaults to 1 (execute from the beginning).
   */
  resumeFrom?: number;
  /**
   * What to do when a step fails:
   * - "retry": attempt the step one more time; mark failed only if the retry also fails.
   * - "skip":  mark the step as skipped and continue with the next step.
   * - "abort": mark the step as failed and stop plan execution immediately.
   * Defaults to "retry".
   */
  onStepFailure?: FailureStrategy;
  /**
   * Store for persisting checkpoint state after each step.
   * Defaults to a new in-memory store.
   */
  checkpoint?: CheckpointStore;
  /**
   * Optional progress callback invoked just before each step begins.
   * Receives a human-readable message such as "Step 2/7: Write the endpoint handler".
   * Use this to drive a spinner or status line in the calling layer.
   */
  progress?: (message: string) => void;
  /**
   * Optional agent profile registry used to resolve per-step profiles.
   * When a step's `agentProfile` field names a registered profile, the orchestrator
   * activates that profile for the step (model, temperature, tool subset).
   */
  profileRegistry?: AgentProfileRegistry;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Map estimated complexity to an LLM iteration budget. */
function iterationBudget(step: PlanStep): number {
  if (step.estimatedComplexity === "high") return 10;
  if (step.estimatedComplexity === "medium") return 5;
  return 3; // low
}

/**
 * Execute one step:
 * - Simple steps (low complexity, ≤1 tool needed) run directly via runSubagent,
 *   bypassing the concurrency manager.
 * - Complex steps are dispatched through the SubagentManager.
 * - When `step.agentProfile` names a registered profile, the profile's model,
 *   temperature and tool subset are applied for this step.
 *
 * Any exception thrown by the underlying runner propagates to the caller so the
 * configured failure strategy can be applied.
 */
async function runStep(
  step: PlanStep,
  index: number,
  manager: SubagentManager,
  registry: ToolRegistry,
  llm: BaseChatModel | undefined,
  profileRegistry?: AgentProfileRegistry
): Promise<SubagentResult> {
  // Resolve per-step LLM and tool list when an agentProfile is annotated on the step
  let stepLlm = llm;
  let stepTools = step.toolsNeeded;

  if (step.agentProfile && profileRegistry) {
    const profile = profileRegistry.get(step.agentProfile);
    if (profile) {
      const runtimeConfig = activateProfile(profile);

      // Intersect profile's active tools with the step's required tools (when both non-empty)
      if (runtimeConfig.activeTools.length > 0 && step.toolsNeeded.length > 0) {
        const profileToolSet = new Set(runtimeConfig.activeTools);
        stepTools = step.toolsNeeded.filter((t) => profileToolSet.has(t));
        if (stepTools.length === 0) {
          logger.warn(
            { stepIndex: index, agentProfile: step.agentProfile, stepToolsNeeded: step.toolsNeeded, profileTools: runtimeConfig.activeTools },
            "Step tool intersection with profile is empty; step will run with no tools"
          );
        }
      } else if (runtimeConfig.activeTools.length > 0) {
        stepTools = runtimeConfig.activeTools;
      }

      // Create a per-step LLM when the profile overrides model or temperature
      const needsNewLlm =
        runtimeConfig.model !== undefined || runtimeConfig.temperature !== undefined;
      if (needsNewLlm) {
        stepLlm = createLLM({
          ...appConfig,
          ...(runtimeConfig.model !== undefined && { llmModel: runtimeConfig.model }),
          ...(runtimeConfig.temperature !== undefined && {
            llmTemperature: runtimeConfig.temperature,
          }),
        });
      }

      logger.debug(
        { stepIndex: index, agentProfile: step.agentProfile, stepTools },
        "Step using agent profile"
      );
    } else {
      logger.warn(
        { stepIndex: index, agentProfile: step.agentProfile },
        "Step references unknown agent profile; using defaults"
      );
    }
  }

  const definition = {
    name: `step-${index + 1}`,
    tools: stepTools,
    maxIterations: iterationBudget(step),
  };

  const isSimple = step.estimatedComplexity === "low" && stepTools.length <= 1;

  if (isSimple) {
    // Direct execution for lightweight steps — no manager overhead
    return runSubagent(definition, step.description, registry, stepLlm);
  }

  // Complex step: run through the SubagentManager (handles concurrency)
  return manager.run(definition, step.description);
}

/**
 * Execute a step and apply the failure strategy if an exception is thrown.
 * Always returns a StepResult (never throws).
 */
async function executeStep(
  step: PlanStep,
  index: number,
  manager: SubagentManager,
  registry: ToolRegistry,
  llm: BaseChatModel | undefined,
  onStepFailure: FailureStrategy,
  profileRegistry?: AgentProfileRegistry
): Promise<StepResult> {
  const attempt = (): Promise<SubagentResult> =>
    runStep(step, index, manager, registry, llm, profileRegistry);

  try {
    const result = await attempt();
    return { stepIndex: index, description: step.description, output: result.output, status: "success" };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);

    if (onStepFailure === "retry") {
      logger.warn({ stepIndex: index, error: errorMsg }, "Step failed — retrying once");
      try {
        const retryResult = await attempt();
        return { stepIndex: index, description: step.description, output: retryResult.output, status: "success" };
      } catch (retryErr) {
        const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
        return { stepIndex: index, description: step.description, output: "", status: "failed", error: retryMsg };
      }
    }

    // "skip" treats failure as skipped; "abort" marks it failed and lets the caller stop
    return {
      stepIndex: index,
      description: step.description,
      output: "",
      status: onStepFailure === "skip" ? "skipped" : "failed",
      error: errorMsg,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Execute a plan produced by the planning subagent step-by-step.
 *
 * - Steps are run in order; simple steps execute directly, complex ones via a subagent.
 * - A checkpoint is saved after every step so execution can resume from a given point.
 * - Step-level failures are handled according to `options.onStepFailure`.
 * - Progress is logged after each step (step N of M, status).
 *
 * @param plan     Structured plan (from generatePlan / refinePlan).
 * @param registry Tool registry; tools are filtered per step by the runner.
 * @param options  Execution options (resumeFrom, onStepFailure, checkpoint).
 * @param llm      Optional LLM instance — created from config when omitted.
 */
export async function executePlan(
  plan: Plan,
  registry: ToolRegistry,
  options: ExecutionOptions = {},
  llm?: BaseChatModel
): Promise<ExecutionResult> {
  const resumeFrom = options.resumeFrom ?? 1;
  const onStepFailure = options.onStepFailure ?? "retry";
  const checkpoint = options.checkpoint ?? new InMemoryCheckpointStore();

  // Shared manager for complex steps (concurrencyLimit=2)
  const manager = new SubagentManager(2, registry, llm);

  const stepResults: StepResult[] = [];
  const total = plan.steps.length;

  for (let i = 0; i < total; i++) {
    const step = plan.steps[i];
    const stepNumber = i + 1; // 1-based number used for resumeFrom comparison and logging

    if (stepNumber < resumeFrom) {
      // Already completed in a previous run — skip without re-executing
      logger.info({ step: stepNumber, total }, "Skipping step (resume)");
      stepResults.push({ stepIndex: i, description: step.description, output: "", status: "skipped" });
      continue;
    }

    logger.info({ step: stepNumber, total, description: step.description }, "Executing step");
    options.progress?.(`Step ${stepNumber}/${total}: ${step.description}`);

    const result = await executeStep(step, i, manager, registry, llm, onStepFailure, options.profileRegistry);
    stepResults.push(result);

    // Persist progress after every step
    await checkpoint.save({ stepResults: [...stepResults] });

    logger.info({ step: stepNumber, total, status: result.status }, "Step completed");

    if (result.status === "failed" && onStepFailure === "abort") {
      logger.warn({ step: stepNumber, total }, "Aborting plan execution");
      break;
    }
  }

  const success = stepResults.every((r) => r.status !== "failed");
  return { stepResults, success };
}
