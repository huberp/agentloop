/**
 * Structured configuration schema for agentloop.
 *
 * Defines the typed shape of the layered JSON config. Each section groups
 * related settings; the full `AgentLoopConfig` represents the merged,
 * resolved configuration used at runtime.
 */

// ---------------------------------------------------------------------------
// Model configuration
// ---------------------------------------------------------------------------

export interface ModelConfig {
  id: string;
  provider: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  /** Name of the env var that holds the API key for this model (e.g. "MISTRAL_API_KEY"). */
  apiKeyEnv?: string;
  enabled?: boolean;
}

// ---------------------------------------------------------------------------
// Section interfaces
// ---------------------------------------------------------------------------

export interface LlmConfig {
  provider: string;
  activeModel?: string;
  temperature: number;
  model?: string;
  maxIterations: number;
  maxTokensBudget: number;
  maxContextTokens: number;
  retryMax: number;
  retryBaseDelayMs: number;
  streamingEnabled: boolean;
}

export interface ToolsConfig {
  timeoutMs: number;
  allowlist: string[];
  blocklist: string[];
  maxConcurrent: number;
  shellCommandBlocklist: string[];
  autoApproveAll: boolean;
}

export interface ExecutionConfig {
  timeoutMs: number;
  environment: string;
  sandboxMode: "none" | "docker";
  dockerImage: string;
}

export interface PathsConfig {
  workspaceRoot?: string;
  instructionsRoot?: string;
  promptTemplatesDir?: string;
  promptHistoryFile?: string;
  skillsDir?: string;
  agentProfilesDir?: string;
  systemPromptPath?: string;
}

export interface PromptsConfig {
  contextRefreshMs: number;
  runtimeContextEnabled: boolean;
}

export interface SearchConfig {
  provider: string;
  tavilyMaxResults?: number;
  langsearchMaxResults?: number;
  duckduckgoMaxResults?: number;
  duckduckgoMinDelayMs?: number;
  duckduckgoRetryMax?: number;
  duckduckgoRetryBaseDelayMs?: number;
  duckduckgoRateLimitPenaltyMs?: number;
  duckduckgoCacheTtlMs?: number;
  duckduckgoCacheMaxEntries?: number;
  duckduckgoServeStaleOnError?: boolean;
}

export interface ObservabilityConfig {
  tracingEnabled: boolean;
  traceOutputDir: string;
  tracingCostPerInputTokenUsd: number;
  tracingCostPerOutputTokenUsd: number;
  logLevel: string;
  logEnabled: boolean;
  logDestination: string;
  logFile?: string;
  logName: string;
  logTimestamp: boolean;
}

export interface SecurityConfig {
  maxFileSizeBytes: number;
  maxShellOutputBytes: number;
  networkAllowedDomains: string[];
}

export interface WebFetchConfig {
  domainBlocklist: string[];
  domainAllowlist: string[];
  allowHttp: boolean;
  maxResponseBytes: number;
  maxContentChars: number;
  userAgent: string;
  fetchTimeoutMs: number;
}

// ---------------------------------------------------------------------------
// Top-level config
// ---------------------------------------------------------------------------

export interface AgentLoopConfig {
  llm: LlmConfig;
  models: ModelConfig[];
  tools: ToolsConfig;
  execution: ExecutionConfig;
  paths: PathsConfig;
  prompts: PromptsConfig;
  search: SearchConfig;
  observability: ObservabilityConfig;
  security: SecurityConfig;
  webFetch: WebFetchConfig;
}

// ---------------------------------------------------------------------------
// Partial (deep-partial) variant used for user/repo JSON files
// ---------------------------------------------------------------------------

/** Deep-partial version of AgentLoopConfig used when reading partial JSON files. */
export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends (infer U)[]
    ? U[]
    : T[P] extends object
      ? DeepPartial<T[P]>
      : T[P];
};

export type PartialAgentLoopConfig = DeepPartial<AgentLoopConfig>;
