import { z } from "zod";

import { appConfig } from "../config";
import { logger } from "../logger";
import { spinner } from "../spinner";
import { generatePlan, refinePlan, validatePlan } from "../subagents/planner";
import { analyzeWorkspace } from "../workspace";
import type { ToolDefinition } from "./registry";
import { toolRegistry } from "./registry";

const schema = z.object({
  goal: z.string().describe("High-level goal to decompose into an actionable plan"),
});

export const toolDefinition: ToolDefinition = {
  name: "plan",
  description:
    "Decompose a high-level goal into a structured, step-by-step plan using the planner " +
    "subagent. Returns the plan as a JSON object — pass it directly to the 'run' tool to execute.",
  schema,
  permissions: "safe",
  timeout: 10 * 60_000,
  execute: async ({ goal }) => {
    logger.info({ tool: "plan", goal }, "generating plan");

    const workspaceInfo = await analyzeWorkspace(appConfig.workspaceRoot);

    let plan = await generatePlan(goal, workspaceInfo, toolRegistry);

    let validation = validatePlan(plan, toolRegistry);
    if (!validation.valid) {
      logger.warn(
        { tool: "plan", invalidTools: validation.invalidTools },
        "plan references unknown tools — refining"
      );
      plan = await refinePlan(
        goal,
        plan,
        `These tools are not available: ${validation.invalidTools.join(", ")}. ` +
          "Use only tools from the available list.",
        workspaceInfo,
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

    logger.info({ tool: "plan", steps: plan.steps.length }, "plan generated");

    // Return JSON so the LLM can inspect steps and pass the object to the 'run' tool.
    return JSON.stringify(plan);
  },
};
