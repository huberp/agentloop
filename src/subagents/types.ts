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
}

/** Result returned by a completed subagent run. */
export interface SubagentResult {
  /** Name of the subagent that produced this result. */
  name: string;
  /** Final text output from the subagent. */
  output: string;
  /** Number of LLM iterations performed. */
  iterations: number;
}
