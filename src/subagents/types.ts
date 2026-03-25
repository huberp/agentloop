/** Definition of a subagent: an isolated agent loop with its own scope. */
export interface SubagentDefinition {
  /** Human-readable name used for logging and identification. */
  name: string;
  /** Optional custom system prompt; defaults to a generated prompt when omitted. */
  systemPrompt?: string;
  /** Names of tools this subagent may use (must be registered in the parent registry). */
  tools: string[];
  /** Maximum LLM iterations before the subagent returns with a warning. */
  maxIterations: number;
  /** Reserved for a future parent↔subagent communication channel. */
  parentCommunication?: boolean;
  /**
   * Read-only shared state injected into the subagent's system prompt.
   * Subagents can read these values but cannot modify the shared context.
   */
  sharedContext?: Record<string, unknown>;
}

/** Result returned by a completed subagent run. */
export interface SubagentResult {
  /** Name of the subagent that produced this result. */
  name: string;
  /** Final text output from the subagent. */
  output: string;
  /** Number of LLM iterations performed. */
  iterations: number;
  /** File paths mutated (written/edited/deleted) during this run. */
  filesModified: string[];
}

// ---------------------------------------------------------------------------
// Task 3.5: Multi-Agent Coordination
// ---------------------------------------------------------------------------

/** Input task for runParallel: pairs a subagent definition with its task string. */
export interface ParallelTask {
  definition: SubagentDefinition;
  task: string;
}

/** A file that was modified by more than one subagent in the same parallel run. */
export interface ConflictInfo {
  /** Conflicting file path. */
  file: string;
  /** Names of the subagents that modified this file. */
  agents: string[];
}

/** Aggregated result of a runParallel call. */
export interface ParallelResult {
  /**
   * One entry per input task — either a fulfilled SubagentResult or a minimal
   * error record (with `name` and `error`) when the subagent threw.
   */
  results: Array<SubagentResult | { name: string; error: string }>;
  /** Files modified by more than one subagent; empty when no conflicts exist. */
  conflicts: ConflictInfo[];
}
