import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

import { logger } from "../logger";
import { ToolRegistry } from "../tools/registry";
import { runSubagent } from "../subagents/runner";
import { generatePlan } from "../subagents/planner";
import { executePlan } from "../orchestrator";
import type { ExecutionOptions, ExecutionResult } from "../orchestrator";
import type { WorkspaceInfo } from "../workspace";
import type { AgentProfile } from "./types";
import type { AgentProfileRegistry } from "./registry";

// ─────────────────────────────────────────────────────────────────────────────
// Router system prompt
// ─────────────────────────────────────────────────────────────────────────────

/**
 * System prompt for the routing subagent.
 * Instructs the LLM to select exactly one profile name from the provided list,
 * or respond with null when no profile clearly matches the request.
 */
export const ROUTER_SYSTEM_PROMPT =
  `You are a routing assistant. Given a user request and a list of available agent profiles,\n` +
  `select the single most appropriate profile name.\n` +
  `Respond ONLY with a valid JSON object: { "profile": "<profile-name>" }\n` +
  `Rules:\n` +
  `- You MUST use one of the provided profile names exactly.\n` +
  `- If no profile clearly fits, respond with: { "profile": null }`;

// ─────────────────────────────────────────────────────────────────────────────
// routeRequest
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Use a lightweight LLM subagent to select the most appropriate agent profile
 * for the given free-text request.
 *
 * @param request         The raw user request string.
 * @param profileRegistry Registry of available agent profiles.
 * @param registry        Tool registry (passed to the routing subagent; no tools are used).
 * @param llm             Optional LLM instance — created from config when omitted.
 * @returns The matched `AgentProfile`, or `null` when no profile fits or on parse error.
 */
export async function routeRequest(
  request: string,
  profileRegistry: AgentProfileRegistry,
  registry: ToolRegistry,
  llm?: BaseChatModel
): Promise<AgentProfile | null> {
  const profiles = profileRegistry.list();
  if (profiles.length === 0) {
    return null;
  }

  const profileList = profiles.map((p) => `- ${p.name}: ${p.description}`).join("\n");
  const routingTask = `User request: ${request}\n\nAvailable profiles:\n${profileList}`;

  let result;
  try {
    result = await runSubagent(
      {
        name: "coordinator-router",
        systemPrompt: ROUTER_SYSTEM_PROMPT,
        tools: [],
        maxIterations: 1,
      },
      routingTask,
      registry,
      llm
    );
  } catch (err) {
    logger.warn({ error: String(err) }, "Coordinator router subagent failed; falling back to default");
    return null;
  }

  // Parse the JSON response
  let parsed: unknown;
  try {
    const stripped = result.output
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "")
      .trim();
    parsed = JSON.parse(stripped);
  } catch {
    logger.warn(
      { output: result.output },
      "Coordinator router returned invalid JSON; falling back to default"
    );
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) {
    logger.warn("Coordinator router returned non-object JSON; falling back to default");
    return null;
  }

  const profileName = (parsed as Record<string, unknown>).profile;
  if (!profileName || typeof profileName !== "string") {
    // Explicit null or missing profile field — no suitable profile found
    return null;
  }

  const profile = profileRegistry.get(profileName);
  if (!profile) {
    logger.warn(
      { profileName },
      "Coordinator router returned unknown profile name; falling back to default"
    );
    return null;
  }

  return profile;
}

// ─────────────────────────────────────────────────────────────────────────────
// coordinatedExecute options
// ─────────────────────────────────────────────────────────────────────────────

/** Options for `coordinatedExecute()`. */
export interface CoordinatedExecuteOptions {
  /** Tool registry passed to planner and orchestrator. */
  registry: ToolRegistry;
  /** Profile registry used for routing and per-step profile resolution. */
  profileRegistry: AgentProfileRegistry;
  /** Workspace analysis result (language, framework, etc.) — required by the planner. */
  workspaceInfo: WorkspaceInfo;
  /** Optional LLM instance; created from config when omitted. */
  llm?: BaseChatModel;
  /**
   * When the planner produces more steps than this threshold, the plan+orchestrate
   * path is used; otherwise the single-invoke path is taken.
   * Defaults to `appConfig.coordinatorPlanThreshold` (env: COORDINATOR_PLAN_THRESHOLD, default 1).
   */
  planThreshold?: number;
  /** Execution options forwarded to `executePlan()` for the multi-step path. */
  executionOptions?: Omit<ExecutionOptions, "profileRegistry">;
  /**
   * Function used to invoke the agent for single-step requests.
   * Defaults to a no-op that returns an empty string — supply `agentExecutor.invoke`
   * (from `src/index.ts`) to use the full agent loop.
   * Kept as an explicit parameter to avoid a circular import between coordinator and index.
   */
  invoke?: (request: string, profileName?: string) => Promise<{ output: string }>;
}

// ─────────────────────────────────────────────────────────────────────────────
// coordinatedExecute
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Unified high-level entry point that combines routing, planning, and execution.
 *
 * Flow:
 * 1. `routeRequest()` — selects the best agent profile for the request (or null).
 * 2. `generatePlan()` — decomposes the request into annotated steps.
 * 3. If steps ≤ threshold → `options.invoke(request, profile?.name)` (single-invoke path).
 * 4. If steps > threshold → `executePlan(plan, registry, { profileRegistry })` (plan+orchestrate path).
 *
 * @param request  The raw user request string.
 * @param options  Configuration for routing, planning, and execution.
 * @returns `ExecutionResult` from the orchestrator on the multi-step path,
 *          or `{ output: string }` on the single-invoke path.
 */
export async function coordinatedExecute(
  request: string,
  options: CoordinatedExecuteOptions
): Promise<ExecutionResult | { output: string }> {
  const {
    registry,
    profileRegistry,
    workspaceInfo,
    llm,
    executionOptions = {},
    invoke,
  } = options;

  // Import coordinatorPlanThreshold lazily to keep coordinator.ts side-effect-free at module load
  const { appConfig } = await import("../config");
  const planThreshold = options.planThreshold ?? appConfig.coordinatorPlanThreshold;

  // Step 1: Route the request to a profile
  const profile = await routeRequest(request, profileRegistry, registry, llm);

  // Step 2: Generate a plan (with profile annotations when a registry is available)
  const plan = await generatePlan(request, workspaceInfo, registry, llm, profileRegistry);

  // Step 3: Choose execution path based on plan size
  if (plan.steps.length <= planThreshold) {
    // Single-invoke path
    if (!invoke) {
      logger.warn(
        "coordinatedExecute: no invoke function provided for single-step path; returning empty output. " +
          "Pass agentExecutor.invoke as the 'invoke' option to use the full agent loop."
      );
      return { output: "" };
    }
    return invoke(request, profile?.name);
  }

  // Multi-step path: execute the annotated plan with profile-aware orchestration
  return executePlan(plan, registry, { ...executionOptions, profileRegistry }, llm);
}
