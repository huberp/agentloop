import { z } from "zod";

import { logger } from "../logger";
import { spinner } from "../spinner";
import { executePlan } from "../orchestrator";
import type { ToolDefinition } from "./registry";
import { toolRegistry } from "./registry";

const planStepSchema = z.object({
  description: z.string(),
  toolsNeeded: z.array(z.string()).default([]),
  estimatedComplexity: z.enum(["low", "medium", "high"]).default("medium"),
});

const schema = z.object({
  plan: z
    .object({ steps: z.array(planStepSchema) })
    .describe("Plan object returned by the 'plan' tool"),
  onStepFailure: z
    .enum(["retry", "skip", "abort"])
    .optional()
    .default("retry")
    .describe('What to do when a step fails: "retry" (default), "skip", or "abort"'),
});

export const toolDefinition: ToolDefinition = {
  name: "run",
  description:
    "Execute a plan produced by the 'plan' tool. " +
    "Runs each step as an isolated subagent in sequence and returns per-step results.",
  schema,
  permissions: "dangerous",
  timeout: 30 * 60_000,
  execute: async ({ plan, onStepFailure = "retry" }) => {
    logger.info({ tool: "run", steps: plan.steps.length }, "executing plan");

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
