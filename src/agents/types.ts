export class AgentProfileError extends Error {
  constructor(message: string, public readonly filePath?: string) {
    super(message);
    this.name = "AgentProfileError";
  }
}

export interface AgentConstraints {
  requireConfirmation?: string[];
  blockedTools?: string[];
  maxFileSizeBytes?: number;
  allowedDomains?: string[];
}

export interface AgentProfile {
  name: string;
  description: string;
  version: string;
  model?: string;
  temperature?: number;
  systemPrompt?: string;
  promptTemplate?: string;
  skills?: string[];
  tools?: string[];
  instructions?: string[];
  maxIterations?: number;
  constraints?: AgentConstraints;
  /** Source classification: where this profile was loaded from. */
  source?: "built-in" | "custom";
  /** Absolute path to the file this profile was loaded from. */
  filePath?: string;
}

export interface AgentRuntimeConfig {
  model?: string;
  temperature?: number;
  maxIterations?: number;
  activeSkills: string[];
  activeTools: string[]; // empty = all tools
  constraints: AgentConstraints;
}
