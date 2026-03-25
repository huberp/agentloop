import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

import { logger } from "../logger";
import { ToolRegistry } from "../tools/registry";
import { runSubagent } from "./runner";
import type { WorkspaceInfo } from "../workspace";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** A single actionable step in a generated plan. */
export interface PlanStep {
  description: string;
  /** Names of registered agent tools required to execute this step. */
  toolsNeeded: string[];
  estimatedComplexity: "low" | "medium" | "high";
}

/** A structured plan decomposing a user request into executable steps. */
export interface Plan {
  steps: PlanStep[];
}

/** Result of validating a plan against the tool registry. */
export interface PlanValidationResult {
  valid: boolean;
  /** Tool names referenced in the plan that are not registered. */
  invalidTools: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompt constants
// ─────────────────────────────────────────────────────────────────────────────

/** JSON schema description embedded in the planner prompt to guide output format. */
const JSON_SCHEMA_HINT = `{
  "steps": [
    {
      "description": "string — what to do in this step",
      "toolsNeeded": ["exact-tool-name", ...],
      "estimatedComplexity": "low" | "medium" | "high"
    }
  ]
}`;

/**
 * System prompt for the plan-generation subagent.
 * The model is instructed to produce ONLY JSON so the output can be parsed
 * reliably without fragile text extraction.  Markdown code fences are accepted
 * in practice (parsePlanFromText strips them), but the prompt discourages them
 * to keep responses clean.
 */
const PLANNER_SYSTEM_PROMPT =
  `You are a planning assistant that decomposes software-engineering tasks into actionable steps.\n` +
  `Respond ONLY with a valid JSON object — no prose, no extra text outside the JSON.\n` +
  `Use this exact schema:\n${JSON_SCHEMA_HINT}\n` +
  `Rules:\n` +
  `- Each step must have a non-empty description.\n` +
  `- toolsNeeded lists the exact agent tool names required (use only names from the provided list).\n` +
  `- estimatedComplexity must be one of "low", "medium", or "high".\n` +
  `- Produce at least one step.`;

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Build the user-facing task string sent to the planner subagent. */
function buildPlannerTask(
  task: string,
  workspaceInfo: WorkspaceInfo,
  availableTools: string[]
): string {
  const toolList = availableTools.length > 0 ? availableTools.join(", ") : "(none)";
  return (
    `Task: ${task}\n` +
    `Workspace: language=${workspaceInfo.language}, framework=${workspaceInfo.framework}, ` +
    `packageManager=${workspaceInfo.packageManager}, gitInitialized=${workspaceInfo.gitInitialized}\n` +
    `Available tools: ${toolList}`
  );
}

/**
 * Extract and parse a Plan from raw LLM text.
 * Strips markdown code fences before parsing so the output is tolerant of
 * models that wrap JSON in ```json … ``` despite the prompt instructions.
 *
 * @throws if no valid JSON with a `steps` array can be extracted.
 */
function parsePlanFromText(text: string): Plan {
  // Strip optional markdown code fences (```json … ``` or ``` … ```)
  const stripped = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    const preview = stripped.length > 200 ? stripped.slice(0, 200) + "...(truncated)" : stripped;
    throw new Error(`Planner output is not valid JSON: ${preview}`);
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !Array.isArray((parsed as Record<string, unknown>).steps)
  ) {
    throw new Error(`Planner output missing required "steps" array`);
  }

  const raw = parsed as { steps: unknown[] };

  const steps: PlanStep[] = raw.steps.map((s, i) => {
    if (typeof s !== "object" || s === null) {
      throw new Error(`Plan step ${i} is not an object`);
    }
    const step = s as Record<string, unknown>;
    if (typeof step.description !== "string" || step.description.trim() === "") {
      throw new Error(`Plan step ${i} has a missing or empty description`);
    }
    const description = step.description;
    const toolsNeeded = Array.isArray(step.toolsNeeded)
      ? (step.toolsNeeded as unknown[]).filter((t): t is string => typeof t === "string")
      : [];
    const complexityRaw = step.estimatedComplexity as string;
    const estimatedComplexity: "low" | "medium" | "high" = ["low", "medium", "high"].includes(
      complexityRaw
    )
      ? (complexityRaw as "low" | "medium" | "high")
      : "medium";

    return { description, toolsNeeded, estimatedComplexity };
  });

  return { steps };
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate that every tool name referenced in the plan exists in the registry.
 * Returns `valid: false` and the offending names when any are missing.
 */
export function validatePlan(plan: Plan, registry: ToolRegistry): PlanValidationResult {
  const registeredNames = new Set(registry.list().map((t) => t.name));
  const invalidTools = new Set<string>();

  for (const step of plan.steps) {
    for (const toolName of step.toolsNeeded) {
      if (!registeredNames.has(toolName)) {
        invalidTools.add(toolName);
      }
    }
  }

  return { valid: invalidTools.size === 0, invalidTools: Array.from(invalidTools) };
}

/**
 * Generate a structured plan for the given task using a planning subagent.
 *
 * The planner runs without any tools — it only needs to reason and output JSON.
 *
 * @param task          Natural-language description of what the agent should accomplish.
 * @param workspaceInfo Workspace analysis result (language, framework, etc.).
 * @param registry      Tool registry used to list available tool names for the prompt.
 * @param llm           Optional LLM instance — created from config when omitted.
 */
export async function generatePlan(
  task: string,
  workspaceInfo: WorkspaceInfo,
  registry: ToolRegistry,
  llm?: BaseChatModel
): Promise<Plan> {
  const availableTools = registry.list().map((t) => t.name);
  const plannerTask = buildPlannerTask(task, workspaceInfo, availableTools);

  const result = await runSubagent(
    {
      name: "planner",
      systemPrompt: PLANNER_SYSTEM_PROMPT,
      tools: [], // The planner reasons without tools; it only produces a plan
      maxIterations: 3,
    },
    plannerTask,
    registry,
    llm
  );

  logger.info({ subagent: "planner", task }, "Plan generated");
  return parsePlanFromText(result.output);
}

/**
 * Refine an existing plan that failed validation (e.g. it references unknown tools).
 * The planner subagent receives the original plan plus a feedback message and
 * is asked to produce a corrected version.
 *
 * @param task          The original task string.
 * @param originalPlan  The plan that failed validation.
 * @param feedback      Human-readable description of what is wrong.
 * @param workspaceInfo Workspace analysis result.
 * @param registry      Tool registry used to supply the up-to-date tool list.
 * @param llm           Optional LLM instance.
 */
export async function refinePlan(
  task: string,
  originalPlan: Plan,
  feedback: string,
  workspaceInfo: WorkspaceInfo,
  registry: ToolRegistry,
  llm?: BaseChatModel
): Promise<Plan> {
  const availableTools = registry.list().map((t) => t.name);

  const refinementTask =
    `Original task: ${task}\n` +
    `Available tools: ${availableTools.join(", ") || "(none)"}\n` +
    `The following plan was rejected:\n${JSON.stringify(originalPlan, null, 2)}\n` +
    `Feedback: ${feedback}\n` +
    `Please produce a corrected plan in the same JSON format.`;

  const result = await runSubagent(
    {
      name: "planner-refine",
      systemPrompt: PLANNER_SYSTEM_PROMPT,
      tools: [],
      maxIterations: 3,
    },
    refinementTask,
    registry,
    llm
  );

  logger.info({ subagent: "planner-refine", task }, "Plan refined");
  return parsePlanFromText(result.output);
}
