/**
 * Step runner — executes a single compiled plan node as a subagent.
 *
 * Reuses the existing subagent infrastructure (runSubagent, SubagentManager,
 * profile activation) but wraps it to produce a StepExecResult with replan
 * detection and file-modification tracking.
 */

import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

import { logger } from "../logger";
import { ToolRegistry } from "../tools/registry";
import { runSubagent } from "../subagents/runner";
import type { AgentProfileRegistry } from "../agents/registry";
import { activateProfile } from "../agents/activator";
import { createLLM } from "../llm";
import { appConfig } from "../config";
import type { CompiledPlanNode, StepExecResult } from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Map complexity to iteration budget. */
function iterationBudget(complexity: "low" | "medium" | "high"): number {
  if (complexity === "high") return 20;
  if (complexity === "medium") return 12;
  return 6;
}

/** Markers that trigger a replan request from step output. */
const REPLAN_MARKERS = [
  "[REPLAN_REQUESTED]",
  "[REQUEST_REPLAN]",
  "REPLAN_REQUESTED",
];

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

export interface StepRunnerDeps {
  registry: ToolRegistry;
  llm?: BaseChatModel;
  profileRegistry?: AgentProfileRegistry;
  /** Shared context from the graph state (conversation history, prior step outputs). */
  sharedContext?: Record<string, unknown>;
}

/**
 * Execute a single plan node using the subagent runner.
 *
 * - Selects tool subset from node.toolsNeeded
 * - Applies agentProfile if specified
 * - Sets iteration budget from complexity
 * - Detects replan requests in the output
 */
export async function runPlannedStep(
  node: CompiledPlanNode,
  deps: StepRunnerDeps,
): Promise<StepExecResult> {
  let stepLlm = deps.llm;
  let stepTools = node.toolsNeeded;

  // Apply agent profile overrides when specified
  if (node.agentProfile && deps.profileRegistry) {
    const profile = deps.profileRegistry.get(node.agentProfile);
    if (profile) {
      const runtimeConfig = activateProfile(profile);

      if (runtimeConfig.activeTools.length > 0 && stepTools.length > 0) {
        const profileToolSet = new Set(runtimeConfig.activeTools);
        stepTools = stepTools.filter((t) => profileToolSet.has(t));
      } else if (runtimeConfig.activeTools.length > 0) {
        stepTools = runtimeConfig.activeTools;
      }

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
    } else {
      logger.warn({ nodeId: node.id, agentProfile: node.agentProfile },
        "Node references unknown agent profile; using defaults");
    }
  }

  const stepToolNames = stepTools.length > 0
    ? stepTools
    : deps.registry.list().map((t) => t.name);

  const toolList = stepToolNames.length > 0
    ? `Available tools: ${stepToolNames.join(", ")}.`
    : "No tools available.";

  const stepSystemPrompt =
    `You are an AI agent executing one step of a larger plan.\n` +
    `Step: ${node.description}\n` +
    `${toolList}\n` +
    `Instructions:\n` +
    `- Use tools only as needed to complete the step.\n` +
    `- Once you have enough information, respond with your final answer directly — do NOT call more tools.\n` +
    `- Do NOT repeat a tool call if you already have a useful result from it.\n` +
    `- Be concise.`;

  try {
    const result = await runSubagent(
      {
        name: `graph-step-${node.id}`,
        tools: stepToolNames,
        maxIterations: iterationBudget(node.estimatedComplexity),
        systemPrompt: stepSystemPrompt,
        sharedContext: deps.sharedContext,
      },
      node.description,
      deps.registry,
      stepLlm,
    );

    // Detect replan request in the output
    const replanRequested = detectReplanRequest(result.output);

    return {
      status: "success",
      output: result.output,
      filesModified: result.filesModified,
      replanRequested: replanRequested.requested,
      replanReason: replanRequested.reason,
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.warn({ nodeId: node.id, error: errorMsg }, "Step execution failed");
    return {
      status: "failed",
      output: "",
      error: errorMsg,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Replan detection
// ─────────────────────────────────────────────────────────────────────────────

function detectReplanRequest(output: string): { requested: boolean; reason?: string } {
  for (const marker of REPLAN_MARKERS) {
    if (output.includes(marker)) {
      // Try to extract a reason after the marker
      const idx = output.indexOf(marker);
      const after = output.slice(idx + marker.length).trim();
      const reason = after.length > 0 ? after.slice(0, 200) : "Step requested replan";
      return { requested: true, reason };
    }
  }
  return { requested: false };
}
