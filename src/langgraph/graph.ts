/**
 * LangGraphJS static graph — the core orchestration engine.
 *
 * Graph nodes:
 *   plan            → produce a BlocksPlan (via LLM planner)
 *   compile         → validate + compile to DAG + init records
 *   select_runnable → pick runnable nodes respecting deps / resources
 *   execute_batch   → run 1..N steps in parallel (bounded)
 *   handle_outcomes → apply failure strategy, join:any cancellation
 *   maybe_replan    → if triggered and within budget, call replanner
 *   finalize        → produce final output summary
 *
 * Conditional routing:
 *   after handle_outcomes → finalize | maybe_replan | select_runnable
 *   after maybe_replan   → compile (recompile new plan)
 */

import { Annotation, StateGraph, START, END, MemorySaver } from "@langchain/langgraph";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

import { logger } from "../logger";
import { ToolRegistry } from "../tools/registry";
import { runSubagent } from "../subagents/runner";
import type { AgentProfileRegistry } from "../agents/registry";
import { exploreWorkspace } from "../agents/project-explorer";
import { validateBlocksPlan, compileBlocksPlanToDag, detectPkgManifestConflicts } from "./compiler";
import { buildRuntimeContextBody } from "../prompts/context";
import {
  selectRunnable,
  getCancellableForRace,
  isAllDone,
  isDeadlocked,
} from "./scheduler";
import { runPlannedStep } from "./step-runner";
import type {
  BlocksPlan,
  CompiledPlan,
  GraphState,
  NodeRecord,
  GraphEvent,
  GraphInvokeOptions,
  GraphTrace,
} from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Graph Annotation (state schema for LangGraphJS)
// ─────────────────────────────────────────────────────────────────────────────

// Helper: overwrite reducer — always takes the new value
const overwrite = <T>() => ({
  reducer: (_old: T, next: T) => next,
});

// Events use an append reducer so each node can add events incrementally
const appendEvents = () => ({
  reducer: (old: GraphEvent[], next: GraphEvent[]) => [...old, ...next],
  default: () => [] as GraphEvent[],
});

const GraphAnnotation = Annotation.Root({
  request:            Annotation<string>(overwrite<string>()),
  plan:               Annotation<BlocksPlan | null>(overwrite<BlocksPlan | null>()),
  compiledPlan:       Annotation<CompiledPlan | null>(overwrite<CompiledPlan | null>()),
  records:            Annotation<Record<string, NodeRecord>>(overwrite<Record<string, NodeRecord>>()),
  lastBatchIds:       Annotation<string[]>(overwrite<string[]>()),
  onFailure:          Annotation<"retry" | "skip" | "abort">(overwrite<"retry" | "skip" | "abort">()),
  replanRequested:    Annotation<boolean>(overwrite<boolean>()),
  replanReason:       Annotation<string>(overwrite<string>()),
  replanCount:        Annotation<number>(overwrite<number>()),
  maxReplans:         Annotation<number>(overwrite<number>()),
  maxRefinements:     Annotation<number>(overwrite<number>()),
  maxConcurrency:     Annotation<number>(overwrite<number>()),
  networkConcurrency: Annotation<number>(overwrite<number>()),
  output:             Annotation<string>(overwrite<string>()),
  done:               Annotation<boolean>(overwrite<boolean>()),
  fatalError:         Annotation<string>(overwrite<string>()),
  events:             Annotation<GraphEvent[]>(appendEvents()),
  sharedContext:      Annotation<Record<string, unknown>>(overwrite<Record<string, unknown>>()),
});

// ─────────────────────────────────────────────────────────────────────────────
// Planner prompt for blocks plan
// ─────────────────────────────────────────────────────────────────────────────

const BLOCKS_PLAN_SCHEMA_HINT = `{
  "version": "2.0",
  "goal": "string",
  "blocks": [
    {
      "type": "step",
      "description": "string",
      "toolsNeeded": ["tool-name"],
      "estimatedComplexity": "low" | "medium" | "high",
      "agentProfile": "profile-name" | null,
      "resources": ["network"] | ["file:WRITE:path"] | [],
      "canRequestReplan": false
    }
  ]
}
A parallel block looks like:
{
  "type": "parallel",
  "join": "all" | "any",
  "branches": [{ "name": "branch-name", "blocks": [...] }]
}`;

const BLOCKS_PLANNER_SYSTEM =
  `You are a planning assistant that decomposes tasks into a structured blocks plan.\n` +
  `Respond ONLY with a valid JSON object — no prose, no extra text.\n` +
  `Use this schema:\n${BLOCKS_PLAN_SCHEMA_HINT}\n` +
  `Rules:\n` +
  `- version must be "2.0"\n` +
  `- Each step block must have a non-empty description and toolsNeeded array.\n` +
  `- estimatedComplexity must be "low", "medium", or "high".\n` +
  `- Use "parallel" blocks when tasks can run concurrently.\n` +
  `- Set join to "any" when only the first successful branch matters.\n` +
  `- Mark resources: ["network"] for steps using web search/fetch.\n` +
  `- Mark resources: ["file:WRITE:<path>"] for steps writing to a specific file.\n` +
  `- Steps that run npm install, yarn, pnpm install, pip install, cargo build, go get, bundle install, gem install, or any other package-manager command MUST declare resources: ["file:WRITE:<manifest>"] where <manifest> is the manifest file they modify (e.g. "file:WRITE:package.json" for npm/yarn/pnpm, "file:WRITE:requirements.txt" for pip, "file:WRITE:Cargo.toml" for cargo, "file:WRITE:go.mod" for go). NEVER place such a step in the same parallel block as a step that edits the same manifest file — they must be sequential.\n` +
  `- Steps using file-edit or file-write tools MUST declare resources: ["file:WRITE:<path>"] for every file they modify.\n` +
  `- Produce at least one block.\n` +
  `- Include all concrete values (URLs, repository names, file paths, version numbers, package names) needed to execute the step directly in the step description itself.`;

// ─────────────────────────────────────────────────────────────────────────────
// Dependencies injected when building the graph
// ─────────────────────────────────────────────────────────────────────────────

export interface GraphDeps {
  registry: ToolRegistry;
  llm?: BaseChatModel;
  profileRegistry?: AgentProfileRegistry;
}

// ─────────────────────────────────────────────────────────────────────────────
// Node implementations
// ─────────────────────────────────────────────────────────────────────────────

function makeEvent(type: GraphEvent["type"], message: string, nodeId?: string): GraphEvent {
  return { type, message, nodeId, timestamp: Date.now() };
}

/** Parse planner output, tolerating markdown code fences. */
function parsePlanOutput(text: string): BlocksPlan {
  const stripped = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  const parsed = JSON.parse(stripped);
  validateBlocksPlan(parsed);
  return parsed as BlocksPlan;
}

/** Build graph node functions that close over the injected deps. */
export function buildGraphNodes(deps: GraphDeps, progressCb?: (evt: GraphEvent) => void) {
  const emit = (state: GraphState, evt: GraphEvent): GraphEvent[] => {
    progressCb?.(evt);
    return [evt];
  };

  // --- plan node ---
  async function planNode(state: GraphState): Promise<Partial<GraphState>> {
    logger.info({ request: state.request }, "Graph: generating blocks plan");
    const availableTools = deps.registry.list().map((t) => t.name);

    // Explore the workspace so the planner knows what files/build-systems exist.
    // This prevents the planner from hallucinating file paths that don't exist.
    let workspaceCtxStr = "";
    try {
      const workspaceCtx = await exploreWorkspace({ registry: deps.registry, llm: deps.llm });
      workspaceCtxStr = JSON.stringify(workspaceCtx, null, 2);
      logger.info({ workspaceCtx }, "Graph: workspace exploration complete");
    } catch (err) {
      logger.warn(
        { error: (err as Error).message },
        "Graph: workspace exploration failed; proceeding without workspace context",
      );
    }

    const parts: string[] = [
      `Task: ${state.request}`,
      `Available tools: ${availableTools.join(", ") || "(none)"}`,
      buildRuntimeContextBody(),
    ];
    if (workspaceCtxStr) {
      parts.push(`Workspace context (use this to understand the actual repo structure before planning steps):\n${workspaceCtxStr}`);
    }
    const convHistory = state.sharedContext.conversationHistory as string | undefined;
    if (convHistory) {
      parts.push(`Previous conversation context:\n${convHistory}`);
    }
    const task = parts.join("\n");
    const result = await runSubagent(
      { name: "graph-planner", systemPrompt: BLOCKS_PLANNER_SYSTEM, tools: [], maxIterations: 3 },
      task,
      deps.registry,
      deps.llm,
    );

    const plan = parsePlanOutput(result.output);

    // Post-plan safety check: warn when parallel branches contain a
    // package-manager step and a file-edit step that share a manifest file
    // without a declared resource lock.  The compiler will auto-add inferred
    // locks for known patterns, but log the conflict so operators are aware.
    const conflicts = detectPkgManifestConflicts(plan);
    if (conflicts.length > 0) {
      logger.warn(
        { conflicts },
        "Graph: plan contains package-manager/file-edit parallelism conflicts — resource locks will be inferred automatically",
      );
    }

    // Build a compact, readable summary of the block tree
    function summariseBlocks(blocks: BlocksPlan["blocks"], indent = 0): string[] {
      const lines: string[] = [];
      for (const b of blocks) {
        const pad = "  ".repeat(indent);
        if (b.type === "step") {
          lines.push(`${pad}• [step] ${b.description} (${b.estimatedComplexity})`);
        } else {
          lines.push(`${pad}• [parallel/${b.join}]`);
          for (const branch of b.branches) {
            lines.push(`${pad}  branch "${branch.name}":`);
            lines.push(...summariseBlocks(branch.blocks, indent + 2));
          }
        }
      }
      return lines;
    }

    logger.info(
      { goal: plan.goal, blocks: summariseBlocks(plan.blocks) },
      `Graph: blocks plan — goal: "${plan.goal}"`,
    );

    const evt = makeEvent("plan_created", `Plan created with ${plan.blocks.length} top-level block(s)`);
    return { plan, events: emit(state, evt) };
  }

  // --- compile node ---
  function compileNode(state: GraphState): Partial<GraphState> {
    if (!state.plan) throw new Error("No plan to compile");

    const compiled = compileBlocksPlanToDag(state.plan);

    // Init execution records for every node not already completed
    const records: Record<string, NodeRecord> = {};
    for (const nodeId of Object.keys(compiled.nodes)) {
      if (state.records[nodeId] && (state.records[nodeId].status === "success" || state.records[nodeId].status === "skipped")) {
        // Preserve completed records across replans
        records[nodeId] = state.records[nodeId];
      } else {
        records[nodeId] = { nodeId, status: "pending", retryCount: 0 };
      }
    }

    const dagSummary = Object.values(compiled.nodes).map((n) => ({
      id: n.id,
      description: n.description,
      dependsOn: n.dependsOn,
    }));
    logger.info(
      { nodeCount: dagSummary.length, dag: dagSummary },
      "Graph: compiled DAG",
    );
    return { compiledPlan: compiled, records, replanRequested: false, replanReason: "" };
  }

  // --- select_runnable node ---
  function selectRunnableNode(state: GraphState): Partial<GraphState> {
    if (!state.compiledPlan) throw new Error("No compiled plan");
    const runnable = selectRunnable(state.compiledPlan, state.records, {
      maxConcurrency: state.maxConcurrency,
      networkConcurrency: state.networkConcurrency,
    });
    logger.info({ runnable }, "Graph: selected runnable nodes");
    return { lastBatchIds: runnable };
  }

  // --- execute_batch node ---
  async function executeBatchNode(state: GraphState): Promise<Partial<GraphState>> {
    if (!state.compiledPlan) throw new Error("No compiled plan");
    const batchIds = state.lastBatchIds;
    if (batchIds.length === 0) return {};

    const newRecords = { ...state.records };
    const allEvents: GraphEvent[] = [];

    // Mark nodes as running
    for (const id of batchIds) {
      newRecords[id] = { ...newRecords[id], status: "running" };
      const evt = makeEvent("step_started", `Starting step ${id}`, id);
      allEvents.push(...emit(state, evt));
    }

    // Execute concurrently (up to maxConcurrency)
    const results = await Promise.all(
      batchIds.map(async (nodeId) => {
        const node = state.compiledPlan!.nodes[nodeId];
        // Join nodes are synthetic — resolve them immediately
        if (node.joinGroup) {
          return { nodeId, status: "success" as const, output: "join resolved", filesModified: [] };
        }
        const result = await runPlannedStep(node, {
          registry: deps.registry,
          llm: deps.llm,
          profileRegistry: deps.profileRegistry,
          sharedContext: state.sharedContext,
          originalRequest: state.request,
        });
        return { nodeId, ...result };
      }),
    );

    // Record results
    let replanRequested = state.replanRequested;
    let replanReason = state.replanReason;

    for (const r of results) {
      const prev = newRecords[r.nodeId];
      newRecords[r.nodeId] = {
        ...prev,
        status: r.status,
        output: r.output,
        error: r.error,
        filesModified: r.filesModified,
        replanRequested: r.replanRequested,
        replanReason: r.replanReason,
      };

      if (r.status === "success") {
        allEvents.push(...emit(state, makeEvent("step_succeeded", `Step ${r.nodeId} succeeded`, r.nodeId)));
      } else {
        allEvents.push(...emit(state, makeEvent("step_failed", `Step ${r.nodeId} failed: ${r.error ?? "unknown"}`, r.nodeId)));
      }

      // Propagate replan request
      if (r.replanRequested) {
        replanRequested = true;
        replanReason = r.replanReason ?? "step requested replan";
      }
    }

    // Accumulate successful step outputs into sharedContext so later steps can reference them
    const stepOutputs = { ...(state.sharedContext.stepOutputs as Record<string, string> ?? {}) };
    for (const r of results) {
      if (r.status === "success" && r.output) {
        stepOutputs[r.nodeId] = r.output.slice(0, 500);
      }
    }
    const updatedSharedContext = { ...state.sharedContext, stepOutputs };

    return { records: newRecords, replanRequested, replanReason, events: allEvents, sharedContext: updatedSharedContext };
  }

  // --- handle_outcomes node ---
  function handleOutcomesNode(state: GraphState): Partial<GraphState> {
    if (!state.compiledPlan) throw new Error("No compiled plan");
    const newRecords = { ...state.records };
    const allEvents: GraphEvent[] = [];
    let replanRequested = state.replanRequested;
    let replanReason = state.replanReason;

    // Apply failure strategy to nodes that just failed
    for (const id of state.lastBatchIds) {
      const rec = newRecords[id];
      if (rec.status !== "failed") continue;

      if (state.onFailure === "retry" && rec.retryCount < 1) {
        // Re-queue for retry
        newRecords[id] = { ...rec, status: "pending", retryCount: rec.retryCount + 1 };
        allEvents.push(...emit(state, makeEvent("step_retried", `Retrying step ${id}`, id)));
      } else if (state.onFailure === "skip") {
        newRecords[id] = { ...rec, status: "skipped" };
        allEvents.push(...emit(state, makeEvent("step_skipped", `Skipping failed step ${id}`, id)));
      } else if (state.onFailure === "abort") {
        // Mark as fatal
        return {
          records: newRecords,
          done: true,
          fatalError: `Step ${id} failed and abort policy is active: ${rec.error ?? "unknown"}`,
          events: allEvents,
        };
      }
      // If retry exhausted (retryCount >= 1 and onFailure is retry), request replan
      if (state.onFailure === "retry" && rec.retryCount >= 1 && newRecords[id].status === "failed") {
        replanRequested = true;
        replanReason = `Step ${id} failed after retry`;
      }
    }

    // Apply join:any cancellation
    const toCancel = getCancellableForRace(state.compiledPlan, newRecords);
    for (const id of toCancel) {
      if (newRecords[id].status === "pending" || newRecords[id].status === "running") {
        newRecords[id] = { ...newRecords[id], status: "cancelled" };
        allEvents.push(...emit(state, makeEvent("step_cancelled", `Cancelled branch step ${id} (race won)`, id)));
      }
    }
    // Emit race-won event when we cancel branches
    if (toCancel.length > 0) {
      allEvents.push(...emit(state, makeEvent("parallel_race_won", `Race completed, cancelled ${toCancel.length} node(s)`)));
    }

    // Check if all done
    const done = isAllDone(newRecords);

    return { records: newRecords, done, replanRequested, replanReason, events: allEvents };
  }

  // --- maybe_replan node ---
  async function maybeReplanNode(state: GraphState): Promise<Partial<GraphState>> {
    if (state.replanCount >= state.maxReplans) {
      logger.warn({ replanCount: state.replanCount }, "Graph: replan budget exhausted");
      return {
        replanRequested: false,
        done: true,
        fatalError: "Replan budget exhausted",
      };
    }

    logger.info({ reason: state.replanReason }, "Graph: replanning");
    const allEvents: GraphEvent[] = [];
    allEvents.push(...emit(state, makeEvent("replan_started", `Replanning (attempt ${state.replanCount + 1}): ${state.replanReason}`)));

    // Build feedback from completed + failed records
    const completedSummary = Object.values(state.records)
      .filter((r) => r.status === "success")
      .map((r) => `- [done] ${r.nodeId}: ${(r.output ?? "").slice(0, 100)}`)
      .join("\n");
    const failedSummary = Object.values(state.records)
      .filter((r) => r.status === "failed")
      .map((r) => `- [FAILED] ${r.nodeId}: ${r.error ?? "unknown"}`)
      .join("\n");

    const availableTools = deps.registry.list().map((t) => t.name);
    const replanTask =
      `Original goal: ${state.request}\n` +
      `Available tools: ${availableTools.join(", ") || "(none)"}\n` +
      `Previously completed work:\n${completedSummary || "(none)"}\n` +
      `Failed steps:\n${failedSummary || "(none)"}\n` +
      `Reason for replan: ${state.replanReason}\n` +
      `Please produce a corrected blocks plan (version "2.0") that addresses the remaining work.` +
      ` Do not re-do already completed steps. Respond with JSON only.`;

    let plan: BlocksPlan | null = null;

    // Refinement loop: allow up to maxRefinements attempts
    for (let attempt = 0; attempt <= state.maxRefinements; attempt++) {
      try {
        const result = await runSubagent(
          { name: "graph-replanner", systemPrompt: BLOCKS_PLANNER_SYSTEM, tools: [], maxIterations: 3 },
          attempt === 0 ? replanTask : `${replanTask}\n\nPrevious attempt failed validation. Try again.`,
          deps.registry,
          deps.llm,
        );
        plan = parsePlanOutput(result.output);
        break;
      } catch (err) {
        logger.warn({ attempt, error: (err as Error).message }, "Graph: replan attempt failed");
        if (attempt === state.maxRefinements) {
          return {
            replanRequested: false,
            done: true,
            fatalError: `Replanning failed after ${attempt + 1} attempt(s): ${(err as Error).message}`,
            events: allEvents,
          };
        }
        allEvents.push(...emit(state, makeEvent("plan_refined", `Replan attempt ${attempt + 1} failed, refining`)));
      }
    }

    allEvents.push(...emit(state, makeEvent("replan_applied", "Replan applied successfully")));

    return {
      plan,
      replanCount: state.replanCount + 1,
      replanRequested: false,
      replanReason: "",
      events: allEvents,
    };
  }

  // --- finalize node ---
  function finalizeNode(state: GraphState): Partial<GraphState> {
    const successes = Object.values(state.records).filter((r) => r.status === "success");
    const failures = Object.values(state.records).filter((r) => r.status === "failed");

    let output: string;
    if (state.fatalError) {
      output = `Execution failed: ${state.fatalError}\n\n` +
        `Completed ${successes.length} step(s) before failure.`;
    } else {
      const summaryLines = successes
        .map((r) => `- ${r.nodeId}: ${(r.output ?? "").slice(0, 200)}`)
        .join("\n");
      output = `Completed ${successes.length} step(s)` +
        (failures.length > 0 ? `, ${failures.length} failed` : "") +
        `.\n\nResults:\n${summaryLines}`;
    }

    logger.info({ successes: successes.length, failures: failures.length }, "Graph: finalized");
    return { output, done: true };
  }

  return {
    planNode,
    compileNode,
    selectRunnableNode,
    executeBatchNode,
    handleOutcomesNode,
    maybeReplanNode,
    finalizeNode,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Graph builder
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build and compile the LangGraphJS StateGraph for plan-based orchestration.
 *
 * Returns a compiled graph that can be invoked with an initial GraphState.
 */
export function buildGraph(deps: GraphDeps, opts?: GraphInvokeOptions) {
  const nodes = buildGraphNodes(deps, opts?.progress);

  const builder = new StateGraph(GraphAnnotation)
    .addNode("generate_plan", nodes.planNode)
    .addNode("compile", nodes.compileNode)
    .addNode("select_runnable", nodes.selectRunnableNode)
    .addNode("execute_batch", nodes.executeBatchNode)
    .addNode("handle_outcomes", nodes.handleOutcomesNode)
    .addNode("maybe_replan", nodes.maybeReplanNode)
    .addNode("finalize", nodes.finalizeNode);

  // Edges
  builder.addEdge(START, "generate_plan");
  builder.addEdge("generate_plan", "compile");
  builder.addEdge("compile", "select_runnable");
  builder.addEdge("select_runnable", "execute_batch");
  builder.addEdge("execute_batch", "handle_outcomes");

  // Conditional routing after handle_outcomes
  builder.addConditionalEdges("handle_outcomes", (state: GraphState) => {
    if (state.done) return "finalize";
    if (state.replanRequested) return "maybe_replan";
    return "select_runnable";
  });

  // After replan, recompile
  builder.addEdge("maybe_replan", "compile");
  builder.addEdge("finalize", END);

  // Compile with in-memory checkpointing
  const checkpointer = new MemorySaver();
  return builder.compile({ checkpointer });
}

// ─────────────────────────────────────────────────────────────────────────────
// Invoke helper
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Invoke the graph with a request string and options.
 * Returns { output, trace }.
 */
export async function invokeGraph(
  request: string,
  deps: GraphDeps,
  opts: GraphInvokeOptions = {},
): Promise<{ output: string; trace?: GraphTrace }> {
  const graph = buildGraph(deps, opts);

  const initialState: GraphState = {
    request,
    plan: null,
    compiledPlan: null,
    records: {},
    lastBatchIds: [],
    onFailure: opts.onFailure ?? "retry",
    replanRequested: false,
    replanReason: "",
    replanCount: 0,
    maxReplans: opts.maxReplans ?? 3,
    maxRefinements: opts.maxRefinements ?? 3,
    maxConcurrency: opts.maxConcurrency ?? 2,
    networkConcurrency: opts.networkConcurrency ?? 2,
    output: "",
    done: false,
    fatalError: "",
    events: [],
    sharedContext: opts.sharedContext ?? {},
  };

  const threadId = `graph-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const result = await graph.invoke(initialState, {
    configurable: { thread_id: threadId },
    recursionLimit: opts.recursionLimit ?? 100,
  }) as GraphState;

  return {
    output: result.output,
    trace: {
      events: result.events,
      replanCount: result.replanCount,
      nodeRecords: result.records,
    },
  };
}
