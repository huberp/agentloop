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

/**
 * Markers that indicate the LLM could not complete the step (semantic failure).
 * Checked case-insensitively against the full step output.
 */
export const STEP_FAILED_MARKERS = [
  "I cannot",
  "I am unable",
  "I don't have the ability",
  "I do not have the ability",
  "cannot perform",
  "unable to perform",
  "not able to",
];

function explicitlyRequestsPython(text: string): boolean {
  return /\b(python|pip|pytest|requirements\.txt|pyproject\.toml|app\.py)\b/i.test(text);
}

function isNodeTsLanguage(language: string | undefined): boolean {
  if (!language) return false;
  return /^(node|typescript|javascript|ts|js)$/i.test(language.trim());
}

function hasSearchEvidenceInSharedContext(sharedContext?: Record<string, unknown>): boolean {
  if (!sharedContext) return false;
  const stepOutputs = sharedContext.stepOutputs;
  if (!stepOutputs || typeof stepOutputs !== "object") return false;
  return Object.values(stepOutputs as Record<string, unknown>).some((value) => {
    if (typeof value !== "string") return false;
    return value.includes("\"link\"") || value.includes("\"title\"") || value.includes("\"snippet\"");
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

export interface StepRunnerDeps {
  registry: ToolRegistry;
  llm?: BaseChatModel;
  profileRegistry?: AgentProfileRegistry;
  /** Shared context from the graph state (conversation history, prior step outputs). */
  sharedContext?: Record<string, unknown>;
  /** The original user request; injected into every step prompt to prevent hallucination. */
  originalRequest?: string;
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

  const workspaceContext = deps.sharedContext?.workspaceContext as { workspaceInfo?: { language?: string } } | undefined;
  const workspaceLanguage = workspaceContext?.workspaceInfo?.language;
  const pythonRequested = explicitlyRequestsPython(
    `${deps.originalRequest ?? ""}\n${node.description}`,
  );
  const hasSearchTool = stepToolNames.includes("search");
  const hasPriorSearchEvidence = hasSearchEvidenceInSharedContext(deps.sharedContext);
  const shouldBiasToTsJs = isNodeTsLanguage(workspaceLanguage) && !pythonRequested;

  const guardrailLines: string[] = [];
  if (shouldBiasToTsJs) {
    guardrailLines.push(
      `- Workspace language is Node/TypeScript. Keep recommendations and SDK guidance in TypeScript/JavaScript/Node.js unless Python is explicitly requested.`
    );
  }
  if (hasSearchTool && appConfig.webSearchProvider !== "none" && shouldBiasToTsJs) {
    guardrailLines.push(
      `- For search queries, append constraints like "TypeScript OR JavaScript OR Node.js" and prioritize TS/JS/Node sources. Down-rank Python-only hits unless Python was requested.`
    );
  }
  if (!hasSearchTool && !hasPriorSearchEvidence) {
    guardrailLines.push(
      `- You do not have search evidence available. Do NOT claim concrete research/SDK findings. If such findings are requested, respond with "insufficient evidence".`
    );
  }

  const stepSystemPrompt =
    `You are an AI agent executing one step of a larger plan.\n` +
    (deps.originalRequest ? `Original user request (for context): ${deps.originalRequest}\n` : ``) +
    `Step: ${node.description}\n` +
    `${toolList}\n` +
    `Instructions:\n` +
    `- Use tools only as needed to complete the step.\n` +
    `- Once you have enough information, respond with your final answer directly — do NOT call more tools.\n` +
    `- Do NOT repeat a tool call if you already have a useful result from it.\n` +
    `- Be concise.\n` +
    (guardrailLines.length > 0 ? `${guardrailLines.join("\n")}\n` : "");

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

    // Detect semantic failure — LLM explicitly declined or could not act
    const stepFailed = detectStepFailure(result.output);
    if (stepFailed.failed) {
      logger.warn({ nodeId: node.id, reason: stepFailed.reason }, "Step semantically failed (LLM indicated inability)");
      return {
        status: "failed",
        output: result.output,
        error: stepFailed.reason ?? "LLM indicated it could not complete the step",
      };
    }

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

/**
 * Lowercase versions of STEP_FAILED_MARKERS, pre-computed once to avoid
 * repeated `.toLowerCase()` calls in the hot path.
 */
const STEP_FAILED_MARKERS_LOWER = STEP_FAILED_MARKERS.map((m) => m.toLowerCase());

/**
 * Detect whether the LLM output semantically indicates an inability to complete
 * the step (e.g. "I cannot fork…", "I am unable to…").
 *
 * Matching is case-insensitive so that natural variations are caught.
 */
function detectStepFailure(output: string): { failed: boolean; reason?: string } {
  const lower = output.toLowerCase();
  for (let i = 0; i < STEP_FAILED_MARKERS_LOWER.length; i++) {
    const markerLower = STEP_FAILED_MARKERS_LOWER[i];
    const idx = lower.indexOf(markerLower);
    if (idx !== -1) {
      // Extract a short context window around the marker for the error message
      const snippet = output.slice(idx, idx + 200).trim();
      return { failed: true, reason: snippet };
    }
  }
  return { failed: false };
}
