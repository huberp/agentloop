/**
 * Types for the LangGraphJS-based orchestrator.
 *
 * - BlocksPlan / PlanBlock: planner output format (v2.0 "blocks" plan)
 * - CompiledPlan / CompiledPlanNode: DAG representation after compilation
 * - GraphState: state flowing through the LangGraph static graph
 * - StepExecResult: per-step execution outcome
 * - GraphEvent / GraphTrace: progress and observability types
 */

// ─────────────────────────────────────────────────────────────────────────────
// Planner output format (Blocks Plan, B1)
// ─────────────────────────────────────────────────────────────────────────────

export type BlocksPlan = {
  version: "2.0";
  goal: string;
  blocks: PlanBlock[];
};

export type PlanBlock = StepBlock | ParallelBlock;

export type StepBlock = {
  type: "step";
  id?: string;
  description: string;
  toolsNeeded: string[];
  estimatedComplexity: "low" | "medium" | "high";
  agentProfile?: string | null;
  /** Resource hints, e.g. ["network"] or ["file:WRITE:src/a.ts"] */
  resources?: string[];
  /** If true, execution may explicitly request a replan */
  canRequestReplan?: boolean;
};

export type ParallelBlock = {
  type: "parallel";
  /** "all" waits for every branch; "any" races and cancels losers */
  join: "all" | "any";
  branches: Array<{
    name: string;
    blocks: PlanBlock[];
  }>;
};

// ─────────────────────────────────────────────────────────────────────────────
// Compiled plan (DAG)
// ─────────────────────────────────────────────────────────────────────────────

export type CompiledPlanNode = {
  id: string;
  description: string;
  dependsOn: string[];
  toolsNeeded: string[];
  estimatedComplexity: "low" | "medium" | "high";
  agentProfile?: string | null;
  /** Normalised resource hints */
  resources: string[];
  /** Present when the node is part of a fork/join group */
  joinGroup?: { kind: "all" | "any"; groupId: string };
  /** Present when the node is inside a parallel branch */
  branch?: { groupId: string; name: string };
};

export type CompiledPlan = {
  nodes: Record<string, CompiledPlanNode>;
};

// ─────────────────────────────────────────────────────────────────────────────
// Step execution result
// ─────────────────────────────────────────────────────────────────────────────

export type StepExecResult = {
  status: "success" | "failed";
  output: string;
  error?: string;
  filesModified?: string[];
  replanRequested?: boolean;
  replanReason?: string;
};

// ─────────────────────────────────────────────────────────────────────────────
// Execution records (per-node tracking inside graph state)
// ─────────────────────────────────────────────────────────────────────────────

export type NodeRecord = {
  nodeId: string;
  status: "pending" | "running" | "success" | "failed" | "skipped" | "cancelled";
  output?: string;
  error?: string;
  filesModified?: string[];
  retryCount: number;
  replanRequested?: boolean;
  replanReason?: string;
};

// ─────────────────────────────────────────────────────────────────────────────
// Graph state — flows through the LangGraphJS StateGraph
// ─────────────────────────────────────────────────────────────────────────────

export type GraphState = {
  /** Original user request */
  request: string;
  /** Raw blocks plan from the planner */
  plan: BlocksPlan | null;
  /** Compiled DAG */
  compiledPlan: CompiledPlan | null;
  /** Per-node execution records */
  records: Record<string, NodeRecord>;
  /** IDs of nodes completed in the batch just executed */
  lastBatchIds: string[];
  /** Failure strategy for the current run */
  onFailure: "retry" | "skip" | "abort";
  /** Whether a replan has been requested */
  replanRequested: boolean;
  /** Reason for the replan request */
  replanReason: string;
  /** Number of replans performed so far */
  replanCount: number;
  /** Maximum replans allowed */
  maxReplans: number;
  /** Maximum refinement rounds per replan */
  maxRefinements: number;
  /** Maximum concurrent steps */
  maxConcurrency: number;
  /** Maximum concurrent network operations */
  networkConcurrency: number;
  /** Final output summary */
  output: string;
  /** Whether execution is complete */
  done: boolean;
  /** Error message when execution fails fatally */
  fatalError: string;
  /** Collected events for observability */
  events: GraphEvent[];
  /**
   * Shared context that flows through the whole graph.
   * - conversationHistory: digest of previous turns from the main agent
   * - stepOutputs: outputs from completed steps, keyed by node id
   */
  sharedContext: Record<string, unknown>;
};

// ─────────────────────────────────────────────────────────────────────────────
// Events & observability
// ─────────────────────────────────────────────────────────────────────────────

export type GraphEventType =
  | "plan_created"
  | "plan_refined"
  | "replan_started"
  | "replan_applied"
  | "step_started"
  | "step_succeeded"
  | "step_failed"
  | "step_retried"
  | "step_skipped"
  | "step_cancelled"
  | "parallel_race_won";

export type GraphEvent = {
  type: GraphEventType;
  nodeId?: string;
  message: string;
  timestamp: number;
};

export type GraphTrace = {
  events: GraphEvent[];
  replanCount: number;
  nodeRecords: Record<string, NodeRecord>;
};

// ─────────────────────────────────────────────────────────────────────────────
// Public API options
// ─────────────────────────────────────────────────────────────────────────────

export interface GraphInvokeOptions {
  onFailure?: "retry" | "skip" | "abort";
  maxReplans?: number;
  maxRefinements?: number;
  maxConcurrency?: number;
  networkConcurrency?: number;
  progress?: (evt: GraphEvent) => void;
  /** Shared context to seed into the graph (e.g. conversation history from the main agent). */
  sharedContext?: Record<string, unknown>;
  /** Maximum number of LangGraph steps before aborting (default: 100). */
  recursionLimit?: number;
}
