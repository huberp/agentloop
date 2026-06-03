import * as dotenv from "dotenv";
import { loadConfig } from "./config/load";
import type { AgentLoopConfig } from "./config/schema";

dotenv.config({ quiet: true });

// ---------------------------------------------------------------------------
// --api-key CLI override — single encapsulation point
//
// All logic related to the --api-key command-line flag lives here:
//   1. Early argv scan: runs before appConfig is built so every start mode
//      (cli, tui, oneshot, direct index) picks up the key automatically.
//      Exits with an error if --api-key is present but has no value, so
//      the behaviour is the same as stripApiKeyArg() below.
//   2. applyApiKeyOverride(): programmatic override for tests / library use.
//   3. stripApiKeyArg(): removes --api-key <value> from a parsed args array
//      so strict parseArgs() calls (e.g. in start-oneshot.ts) don't reject
//      the flag as unknown. Callers receive a clean array; no other module
//      needs to know about the flag.
// ---------------------------------------------------------------------------
(function applyCliApiKeyOverride() {
  const idx = process.argv.indexOf("--api-key");
  if (idx === -1) return;
  const value = process.argv[idx + 1];
  if (!value || value.startsWith("-")) {
    process.stderr.write("Error: --api-key requires a value\n");
    process.exit(1);
  }
  process.env.MISTRAL_API_KEY = value;
})();

// ---------------------------------------------------------------------------
// Shape of a single entry in the MCP_SERVERS configuration array.
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Load the structured layered configuration
// ---------------------------------------------------------------------------

let _resolvedConfig: AgentLoopConfig | undefined;
try {
  _resolvedConfig = loadConfig();
} catch (err) {
  // Surface config-load errors clearly and exit
  process.stderr.write(`Configuration error: ${(err as Error).message}\n`);
  process.exit(1);
}

// After the try/catch, _resolvedConfig is always assigned (process.exit on error).
// TypeScript can't prove this, so we assert.
const _config = _resolvedConfig!;

// ---------------------------------------------------------------------------
// Derive the flat appConfig from the structured config for backward compat.
//
// Existing code throughout the repo imports `appConfig` and reads flat
// fields. We preserve the exact same shape and field names so no other
// file needs to change.
// ---------------------------------------------------------------------------

const c = _config;

export const appConfig = {
  // Secrets still come from env (not JSON config files)
  mistralApiKey: process.env.MISTRAL_API_KEY ?? "",
  // LLM / agent loop
  maxIterations: c.llm.maxIterations,
  maxTokensBudget: c.llm.maxTokensBudget,
  maxContextTokens: c.llm.maxContextTokens,
  llmRetryMax: c.llm.retryMax,
  llmRetryBaseDelayMs: c.llm.retryBaseDelayMs,
  toolTimeoutMs: c.tools.timeoutMs,
  llmProvider: c.llm.provider,
  llmModel: c.llm.model ?? "",
  llmTemperature: c.llm.temperature,
  systemPromptPath: c.paths.systemPromptPath ?? "",
  autoApproveAll: c.tools.autoApproveAll,
  toolAllowlist: c.tools.allowlist,
  toolBlocklist: c.tools.blocklist,
  shellCommandBlocklist: c.tools.shellCommandBlocklist,
  executionTimeoutMs: c.execution.timeoutMs,
  executionEnvironment: c.execution.environment,
  workspaceRoot: c.paths.workspaceRoot ?? process.cwd(),
  mcpServers: parseMcpServers(process.env.MCP_SERVERS),
  maxFileSizeBytes: c.security.maxFileSizeBytes,
  maxShellOutputBytes: c.security.maxShellOutputBytes,
  maxConcurrentTools: c.tools.maxConcurrent,
  networkAllowedDomains: c.security.networkAllowedDomains,
  sandboxMode: c.execution.sandboxMode,
  sandboxDockerImage: c.execution.dockerImage,
  streamingEnabled: c.llm.streamingEnabled,
  instructionsRoot:
    c.paths.instructionsRoot ??
    c.paths.workspaceRoot ??
    process.cwd(),
  promptTemplatesDir: c.paths.promptTemplatesDir ?? "",
  promptHistoryFile: c.paths.promptHistoryFile ?? "",
  promptContextRefreshMs: c.prompts.contextRefreshMs,
  recordLlmResponses:
    process.env.RECORD_LLM_RESPONSES?.toLowerCase() === "true"
      ? true
      : false,
  llmFixtureDir:
    process.env.LLM_FIXTURE_DIR ?? "tests/fixtures/llm-responses",
  webSearchProvider: c.search.provider as
    | "duckduckgo"
    | "tavily"
    | "langsearch"
    | "none",
  tavilyApiKey: process.env.TAVILY_API_KEY ?? "",
  tavilyMaxResults: c.search.tavilyMaxResults ?? 5,
  langsearchApiKey: process.env.LANGSEARCH_API_KEY ?? "",
  langsearchMaxResults: c.search.langsearchMaxResults ?? 5,
  duckduckgoMaxResults: c.search.duckduckgoMaxResults ?? 5,
  duckduckgoMinDelayMs: c.search.duckduckgoMinDelayMs ?? 1000,
  duckduckgoRetryMax: c.search.duckduckgoRetryMax ?? 2,
  duckduckgoRetryBaseDelayMs: c.search.duckduckgoRetryBaseDelayMs ?? 400,
  duckduckgoRateLimitPenaltyMs:
    c.search.duckduckgoRateLimitPenaltyMs ?? 1000,
  duckduckgoCacheTtlMs: c.search.duckduckgoCacheTtlMs ?? 300000,
  duckduckgoCacheMaxEntries: c.search.duckduckgoCacheMaxEntries ?? 128,
  duckduckgoServeStaleOnError:
    c.search.duckduckgoServeStaleOnError ?? true,
  webDomainBlocklist: c.webFetch.domainBlocklist,
  webDomainAllowlist: c.webFetch.domainAllowlist,
  webAllowHttp: c.webFetch.allowHttp,
  webMaxResponseBytes: c.webFetch.maxResponseBytes,
  webMaxContentChars: c.webFetch.maxContentChars,
  webUserAgent: c.webFetch.userAgent,
  webFetchTimeoutMs: c.webFetch.fetchTimeoutMs,
  runtimeContextEnabled: c.prompts.runtimeContextEnabled,
  uiMode: (process.env.UI_MODE ?? "cli").toLowerCase(),
  skillsDir: c.paths.skillsDir ?? "",
  agentProfilesDir: c.paths.agentProfilesDir ?? "",
  orchestrator: (process.env.ORCHESTRATOR ?? "default").toLowerCase() as
    | "default"
    | "langgraph",
  planOnly:
    process.env.PLAN_ONLY?.toLowerCase() === "true" ? true : false,
  tracingEnabled: c.observability.tracingEnabled,
  traceOutputDir: c.observability.traceOutputDir,
  tracingCostPerInputTokenUsd:
    c.observability.tracingCostPerInputTokenUsd,
  tracingCostPerOutputTokenUsd:
    c.observability.tracingCostPerOutputTokenUsd,
  logger: {
    level: c.observability.logLevel,
    enabled: c.observability.logEnabled,
    destination: c.observability.logDestination,
    file: c.observability.logFile ?? "",
    name: c.observability.logName,
    timestamp: c.observability.logTimestamp,
  },
};

// ---------------------------------------------------------------------------
// Expose the structured config for new code that wants the full typed config
// ---------------------------------------------------------------------------

/** The fully resolved structured config (read-only). */
export const resolvedConfig: Readonly<AgentLoopConfig> = _config;

/**
 * Override the Mistral API key at runtime.
 *
 * Updates both `process.env.MISTRAL_API_KEY` and the live `appConfig` object
 * so the new key is used by any code that reads either. Useful in tests and
 * for programmatic library usage.
 */
export function applyApiKeyOverride(apiKey: string): void {
  process.env.MISTRAL_API_KEY = apiKey;
  appConfig.mistralApiKey = apiKey;
}

/**
 * Override the logger destination at runtime.
 *
 * Keeps `process.env` and the live `appConfig` object in sync so code that reads
 * either source observes the same destination.
 */
export function setLoggerDestination(destination: "stdout" | "stderr"): void {
  process.env.LOG_DESTINATION = destination;
  appConfig.logger.destination = destination;
}

/**
 * Remove `--api-key <value>` from `args` and return the cleaned array.
 *
 * Call this in entry points that use `parseArgs({ strict: true })` so the
 * global flag is not rejected as an unknown option. The actual key override
 * has already been applied by the early argv scan above; this function only
 * handles the presentational concern of cleaning the arg list.
 *
 * Exits with an error message if `--api-key` is present but has no value.
 */
export function stripApiKeyArg(args: string[]): string[] {
  const idx = args.indexOf("--api-key");
  if (idx === -1) return args;
  const value = args[idx + 1];
  if (!value || value.startsWith("-")) {
    process.stderr.write("Error: --api-key requires a value\n");
    process.exit(1);
  }
  const cleaned = args.slice();
  cleaned.splice(idx, 2);
  return cleaned;
}
