import * as dotenv from "dotenv";

dotenv.config({ quiet: true });

function asBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) {
    return defaultValue;
  }

  return value.toLowerCase() === "true";
}

/** Parse a comma-separated env var into a trimmed, non-empty string array. */
function asStringArray(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Shape of a single entry in the MCP_SERVERS configuration array. */
interface McpServerEntry {
  name: string;
  transport: "stdio" | "sse";
  command?: string;
  args?: string[];
  url?: string;
}

/** Parse MCP_SERVERS as a JSON array; returns an empty array on missing or invalid input. */
function parseMcpServers(value: string | undefined): McpServerEntry[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as McpServerEntry[]) : [];
  } catch {
    return [];
  }
}

export const appConfig = {
  mistralApiKey: process.env.MISTRAL_API_KEY ?? "",
  // Maximum number of agentic iterations before aborting with a warning
  maxIterations: parseInt(process.env.MAX_ITERATIONS ?? "20", 10),
  // Token budget reserved for future context-window management (0 = disabled)
  maxTokensBudget: parseInt(process.env.MAX_TOKENS_BUDGET ?? "0", 10),
  // Maximum tokens allowed in the context window (system prompt + history + headroom for response)
  maxContextTokens: parseInt(process.env.MAX_CONTEXT_TOKENS ?? "28000", 10),
  // LLM retry settings: max retries on API failure and base delay for exponential back-off
  llmRetryMax: parseInt(process.env.LLM_RETRY_MAX ?? "3", 10),
  llmRetryBaseDelayMs: parseInt(process.env.LLM_RETRY_BASE_DELAY_MS ?? "500", 10),
  // Per-tool execution timeout in milliseconds (AbortController kills the promise after this)
  toolTimeoutMs: parseInt(process.env.TOOL_TIMEOUT_MS ?? "30000", 10),
  // LLM provider selection and model settings
  llmProvider: process.env.LLM_PROVIDER ?? "mistral",
  llmModel: process.env.LLM_MODEL ?? "",
  llmTemperature: parseFloat(process.env.LLM_TEMPERATURE ?? "0.7"),
  // Optional path to a .txt or .md file that overrides the generated system prompt
  systemPromptPath: process.env.SYSTEM_PROMPT_PATH ?? "",
  // Tool security (Task 1.7): bypass all confirmation prompts (for CI / non-interactive use)
  autoApproveAll: asBoolean(process.env.AUTO_APPROVE_ALL, false),
  // Comma-separated list of tool names that are allowed to run (empty = allow all)
  toolAllowlist: asStringArray(process.env.TOOL_ALLOWLIST),
  // Comma-separated list of tool names that are always blocked
  toolBlocklist: asStringArray(process.env.TOOL_BLOCKLIST),
  // Shell tool (Task 2.1): extra blocked command patterns appended to built-in defaults
  shellCommandBlocklist: asStringArray(process.env.SHELL_COMMAND_BLOCKLIST),
  // Code execution tool (Task 2.5): timeout for code-run (falls back to TOOL_TIMEOUT_MS)
  executionTimeoutMs: parseInt(process.env.EXECUTION_TIMEOUT_MS ?? "60000", 10),
  // Code execution environment label — reserved for future sandboxing (Phase 4)
  executionEnvironment: process.env.EXECUTION_ENVIRONMENT ?? "local",
  // File management tools (Task 2.2): all file operations are restricted to this directory
  workspaceRoot: process.env.WORKSPACE_ROOT ?? process.cwd(),
  // MCP client integration (Task 2.8): JSON array of server configs
  // Each entry: { name, transport, command?, args?, url? }
  mcpServers: parseMcpServers(process.env.MCP_SERVERS),
  // Security hardening (Task 4.3)
  // Maximum number of bytes allowed for file read/write operations (default: 10 MB)
  maxFileSizeBytes: parseInt(process.env.MAX_FILE_SIZE_BYTES ?? "10485760", 10),
  // Maximum number of bytes allowed in shell stdout+stderr combined (default: 1 MB)
  maxShellOutputBytes: parseInt(process.env.MAX_SHELL_OUTPUT_BYTES ?? "1048576", 10),
  // Maximum number of tool executions allowed to run concurrently (0 = unlimited)
  maxConcurrentTools: parseInt(process.env.MAX_CONCURRENT_TOOLS ?? "10", 10),
  // Comma-separated allowlist of domains/IPs permitted for network tool requests (empty = allow all)
  networkAllowedDomains: asStringArray(process.env.NETWORK_ALLOWED_DOMAINS),
  // Execution sandboxing (Task 4.4): "none" runs code on the host; "docker" isolates it in a container
  sandboxMode: (process.env.SANDBOX_MODE ?? "none") as "none" | "docker",
  // Docker image used when SANDBOX_MODE=docker (must contain the required interpreter)
  sandboxDockerImage: process.env.SANDBOX_DOCKER_IMAGE ?? "node:20-alpine",
  // Streaming response support (Task 4.2): print tokens as they arrive in the CLI
  streamingEnabled: asBoolean(process.env.STREAMING_ENABLED, false),
  // Instruction files root directory (Task 5.1); defaults to WORKSPACE_ROOT
  instructionsRoot: process.env.INSTRUCTIONS_ROOT || process.env.WORKSPACE_ROOT || process.cwd(),
  // Prompt templates directory (Task 5.2); loaded into PromptRegistry on startup
  promptTemplatesDir: process.env.PROMPT_TEMPLATES_DIR ?? "",
  // Prompt version history store (Task 5.3); persists all registered prompt versions across restarts
  promptHistoryFile: process.env.PROMPT_HISTORY_FILE ?? "",
  // Dynamic context injection TTL (Task 5.4): ms before context is re-built (0 = every call)
  promptContextRefreshMs: parseInt(process.env.PROMPT_CONTEXT_REFRESH_MS ?? "5000", 10),
  // LLM response recording/replay (Task 5.3)
  // Set to true to record real LLM responses as fixture files for later replay in tests
  recordLlmResponses: asBoolean(process.env.RECORD_LLM_RESPONSES, false),
  // Directory where recorded fixture files are stored (also used by MockChatModel.fromFixture)
  llmFixtureDir: process.env.LLM_FIXTURE_DIR ?? "tests/fixtures/llm-responses",
  // DuckDuckGo search tool: maximum number of results to return per query (default: 5)
  duckduckgoMaxResults: parseInt(process.env.DUCKDUCKGO_MAX_RESULTS ?? "5", 10),
  // DuckDuckGo search reliability controls
  // Minimum delay in milliseconds between outbound DuckDuckGo requests (0 = no delay)
  duckduckgoMinDelayMs: parseInt(process.env.DUCKDUCKGO_MIN_DELAY_MS ?? "1000", 10),
  // Maximum number of retries for transient DuckDuckGo failures
  duckduckgoRetryMax: parseInt(process.env.DUCKDUCKGO_RETRY_MAX ?? "2", 10),
  // Base delay in milliseconds for exponential retry back-off
  duckduckgoRetryBaseDelayMs: parseInt(process.env.DUCKDUCKGO_RETRY_BASE_DELAY_MS ?? "400", 10),
  // Extra delay in milliseconds for rate-limit responses (HTTP 429)
  duckduckgoRateLimitPenaltyMs: parseInt(process.env.DUCKDUCKGO_RATE_LIMIT_PENALTY_MS ?? "1000", 10),
  // In-memory query cache TTL in milliseconds (0 = disabled)
  duckduckgoCacheTtlMs: parseInt(process.env.DUCKDUCKGO_CACHE_TTL_MS ?? "300000", 10),
  // Maximum in-memory cache entries (0 = disabled)
  duckduckgoCacheMaxEntries: parseInt(process.env.DUCKDUCKGO_CACHE_MAX_ENTRIES ?? "128", 10),
  // Serve stale cached search results when upstream fails
  duckduckgoServeStaleOnError: asBoolean(process.env.DUCKDUCKGO_SERVE_STALE_ON_ERROR, true),
  // Web fetch tool (Task 2.9a): URL security and content extraction settings
  webDomainBlocklist: asStringArray(process.env.WEB_DOMAIN_BLOCKLIST),
  webDomainAllowlist: asStringArray(process.env.WEB_DOMAIN_ALLOWLIST),
  webAllowHttp: asBoolean(process.env.WEB_ALLOW_HTTP, false),
  webMaxResponseBytes: parseInt(process.env.WEB_MAX_RESPONSE_BYTES ?? "5242880", 10),
  webMaxContentChars: parseInt(process.env.WEB_MAX_CONTENT_CHARS ?? "20000", 10),
  webUserAgent: process.env.WEB_USER_AGENT ?? "AgentLoop/1.0",
  webFetchTimeoutMs: parseInt(process.env.WEB_FETCH_TIMEOUT_MS ?? "15000", 10),
  // Runtime context injection: when enabled, injects current date/time, OS platform, and Node.js
  // version into the system prompt as a synthetic instruction block (default: true)
  runtimeContextEnabled: asBoolean(process.env.RUNTIME_CONTEXT_ENABLED, true),
  // User interface mode for interactive runs: "cli" (readline) or "tui" (Ink)
  uiMode: (process.env.UI_MODE ?? "cli").toLowerCase(),
  // Skills directory (Task 6.1); auto-loaded on startup
  skillsDir: process.env.SKILLS_DIR ?? "",
  // Agent profiles directory (Task 7.1); auto-loaded on startup
  agentProfilesDir: process.env.AGENT_PROFILES_DIR ?? "",
  // Observability & Tracing (Task 4.1)
  tracingEnabled: asBoolean(process.env.TRACING_ENABLED, false),
  // Directory where per-invocation trace JSON files are written
  traceOutputDir: process.env.TRACE_OUTPUT_DIR ?? "./traces",
  // USD cost per input (prompt) token — used for cost estimation (0 = disabled)
  tracingCostPerInputTokenUsd: parseFloat(process.env.TRACING_COST_PER_INPUT_TOKEN_USD ?? "0") || 0,
  // USD cost per output (completion) token — used for cost estimation (0 = disabled)
  tracingCostPerOutputTokenUsd: parseFloat(process.env.TRACING_COST_PER_OUTPUT_TOKEN_USD ?? "0") || 0,
  logger: {
    level: process.env.LOG_LEVEL ?? "info",
    enabled: asBoolean(process.env.LOG_ENABLED, true),
    destination: process.env.LOG_DESTINATION ?? "stdout",
    // When set, all log output is written to this file path instead of stdout/stderr.
    file: process.env.LOG_FILE ?? "",
    name: process.env.LOG_NAME ?? "agentloop",
    timestamp: asBoolean(process.env.LOG_TIMESTAMP, true),
  },
};
