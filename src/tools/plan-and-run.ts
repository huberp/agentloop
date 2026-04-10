import { z } from "zod";

import { appConfig } from "../config";
import { logger } from "../logger";
import { spinner } from "../spinner";
import { executePlan } from "../orchestrator";
import { generatePlan, refinePlan, validatePlan } from "../subagents/planner";
import { analyzeWorkspace, toWorkspaceContext } from "../workspace";
import type { ToolDefinition } from "./registry";
import { toolRegistry } from "./registry";

const schema = z.object({
  goal: z.string().describe("High-level goal to plan and execute"),
  onStepFailure: z
    .enum(["retry", "skip", "abort"])
    .optional()
    .default("retry")
    .describe('What to do when a step fails: "retry" (default), "skip", or "abort"'),
});

export const toolDefinition: ToolDefinition = {
  name: "plan-and-run",
  description:
    "Decompose a high-level goal into an actionable plan using the planner subagent, " +
    "then execute each step in sequence. Auto-refines the plan once if unknown tools are referenced.",
  schema,
  permissions: "dangerous",
  // Planning + multi-step execution spawns many sequential LLM calls; allow up to 30 minutes.
  timeout: 30 * 60_000,
  execute: async ({ goal, onStepFailure = "retry" }) => {
    logger.info({ tool: "plan-and-run", goal }, "generating plan");

    const workspaceInfo = await analyzeWorkspace(appConfig.workspaceRoot);
    const context = toWorkspaceContext(workspaceInfo);

    let plan = await generatePlan(goal, context, toolRegistry);

    let validation = validatePlan(plan, toolRegistry);
    if (!validation.valid) {
      logger.warn(
        { tool: "plan-and-run", invalidTools: validation.invalidTools },
        "plan references unknown tools — refining"
      );
      plan = await refinePlan(
        goal,
        plan,
        `These tools are not available: ${validation.invalidTools.join(", ")}. ` +
          "Use only tools from the available list.",
        context,
        toolRegistry
      );
      validation = validatePlan(plan, toolRegistry);
      if (!validation.valid) {
        return (
          `Plan generation failed — unknown tools after refinement: ` +
          validation.invalidTools.join(", ")
        );
      }
    }

    // Print the plan via the spinner so it doesn't interleave with spinner frames.
    spinner.writeLine("\nPlan:");
    for (let i = 0; i < plan.steps.length; i++) {
      const s = plan.steps[i];
      spinner.writeLine(`  ${i + 1}. [${s.estimatedComplexity}] ${s.description}`);
    }
    spinner.writeLine("");

    logger.info({ tool: "plan-and-run", steps: plan.steps.length }, "executing plan");

    const result = await executePlan(plan, toolRegistry, {
      onStepFailure,
      progress: (msg) => spinner.writeLine(`  ↳ ${msg}`),
    });

    const lines = result.stepResults.map((s) => {
      const icon = s.status === "success" ? "✓" : s.status === "skipped" ? "–" : "✗";
      const suffix = s.error ? ` [${s.error}]` : "";
      return `${icon} Step ${s.stepIndex + 1}: ${s.description}${suffix}`;
    });

    lines.push("", result.success ? "Completed successfully." : "Completed with failures.");

    return lines.join("\n");
  },
};
