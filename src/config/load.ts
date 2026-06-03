/**
 * Config file discovery, loading, parsing, and validation.
 *
 * Loads config from:
 *   1. Built-in defaults
 *   2. User-level: ~/.agentloop/config.json
 *   3. Repo-level: <cwd>/.agentloop/config.json
 *   4. Environment variables (overlay)
 *   5. CLI overrides (handled externally, e.g. --api-key)
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import type {
  AgentLoopConfig,
  PartialAgentLoopConfig,
  ModelConfig,
  LlmConfig,
  ToolsConfig,
  ExecutionConfig,
  PathsConfig,
  PromptsConfig,
  SearchConfig,
  ObservabilityConfig,
  SecurityConfig,
  WebFetchConfig,
} from "./schema";
import { mergeConfigs } from "./merge";

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const CONFIG_DEFAULTS: AgentLoopConfig = {
  llm: {
    provider: "mistral",
    temperature: 0.7,
    model: "",
    maxIterations: 20,
    maxTokensBudget: 0,
    maxContextTokens: 28000,
    retryMax: 3,
    retryBaseDelayMs: 500,
    streamingEnabled: false,
  },
  models: [],
  tools: {
    timeoutMs: 30000,
    allowlist: [],
    blocklist: [],
    maxConcurrent: 10,
    shellCommandBlocklist: [],
    autoApproveAll: false,
  },
  execution: {
    timeoutMs: 60000,
    environment: "local",
    sandboxMode: "none",
    dockerImage: "node:20-alpine",
  },
  paths: {
    workspaceRoot: undefined,
    instructionsRoot: undefined,
    promptTemplatesDir: "",
    promptHistoryFile: "",
    skillsDir: "",
    agentProfilesDir: "",
    systemPromptPath: "",
  },
  prompts: {
    contextRefreshMs: 5000,
    runtimeContextEnabled: true,
  },
  search: {
    provider: "duckduckgo",
    tavilyMaxResults: 5,
    langsearchMaxResults: 5,
    duckduckgoMaxResults: 5,
    duckduckgoMinDelayMs: 1000,
    duckduckgoRetryMax: 2,
    duckduckgoRetryBaseDelayMs: 400,
    duckduckgoRateLimitPenaltyMs: 1000,
    duckduckgoCacheTtlMs: 300000,
    duckduckgoCacheMaxEntries: 128,
    duckduckgoServeStaleOnError: true,
  },
  observability: {
    tracingEnabled: false,
    traceOutputDir: "./traces",
    tracingCostPerInputTokenUsd: 0,
    tracingCostPerOutputTokenUsd: 0,
    logLevel: "info",
    logEnabled: true,
    logDestination: "stdout",
    logFile: "",
    logName: "agentloop",
    logTimestamp: true,
  },
  security: {
    maxFileSizeBytes: 10485760,
    maxShellOutputBytes: 1048576,
    networkAllowedDomains: [],
  },
  webFetch: {
    domainBlocklist: [],
    domainAllowlist: [],
    allowHttp: false,
    maxResponseBytes: 5242880,
    maxContentChars: 20000,
    userAgent: "AgentLoop/1.0",
    fetchTimeoutMs: 15000,
  },
};

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

/** Resolve the user-level config path: ~/.agentloop/config.json */
export function getUserConfigPath(): string {
  return path.join(os.homedir(), ".agentloop", "config.json");
}

/** Resolve the repo-level config path: <cwd>/.agentloop/config.json */
export function getRepoConfigPath(cwd?: string): string {
  return path.join(cwd ?? process.cwd(), ".agentloop", "config.json");
}

// ---------------------------------------------------------------------------
// JSON parsing + validation
// ---------------------------------------------------------------------------

export class ConfigLoadError extends Error {
  constructor(
    message: string,
    public readonly filePath: string,
  ) {
    super(message);
    this.name = "ConfigLoadError";
  }
}

/**
 * Read and parse a JSON config file. Returns undefined if the file does not
 * exist. Throws ConfigLoadError on parse or validation failure.
 */
export function readConfigFile(
  filePath: string,
): PartialAgentLoopConfig | undefined {
  if (!fs.existsSync(filePath)) return undefined;

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch (err) {
    throw new ConfigLoadError(
      `Cannot read config file: ${(err as Error).message}`,
      filePath,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ConfigLoadError(
      `Invalid JSON in config file: ${(err as Error).message}`,
      filePath,
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ConfigLoadError(
      `Config file must contain a JSON object, got ${Array.isArray(parsed) ? "array" : typeof parsed}`,
      filePath,
    );
  }

  // Validate known top-level keys
  const validKeys = new Set([
    "llm",
    "models",
    "tools",
    "execution",
    "paths",
    "prompts",
    "search",
    "observability",
    "security",
    "webFetch",
  ]);
  const obj = parsed as Record<string, unknown>;
  const unknownKeys = Object.keys(obj).filter((k) => !validKeys.has(k));
  if (unknownKeys.length > 0) {
    throw new ConfigLoadError(
      `Unknown config keys: ${unknownKeys.join(", ")}. Valid keys: ${[...validKeys].join(", ")}`,
      filePath,
    );
  }

  // Validate models array if present
  if (obj.models !== undefined) {
    if (!Array.isArray(obj.models)) {
      throw new ConfigLoadError(
        `"models" must be an array, got ${typeof obj.models}`,
        filePath,
      );
    }
    for (let i = 0; i < obj.models.length; i++) {
      const m = obj.models[i] as Record<string, unknown>;
      if (typeof m !== "object" || m === null || Array.isArray(m)) {
        throw new ConfigLoadError(
          `models[${i}] must be an object`,
          filePath,
        );
      }
      if (typeof m.id !== "string" || !m.id) {
        throw new ConfigLoadError(
          `models[${i}].id must be a non-empty string`,
          filePath,
        );
      }
      if (typeof m.provider !== "string" || !m.provider) {
        throw new ConfigLoadError(
          `models[${i}].provider must be a non-empty string`,
          filePath,
        );
      }
      if (typeof m.model !== "string" || !m.model) {
        throw new ConfigLoadError(
          `models[${i}].model must be a non-empty string`,
          filePath,
        );
      }
    }
  }

  // Validate section types
  const sectionKeys = [
    "llm",
    "tools",
    "execution",
    "paths",
    "prompts",
    "search",
    "observability",
    "security",
    "webFetch",
  ];
  for (const key of sectionKeys) {
    if (obj[key] !== undefined) {
      if (
        typeof obj[key] !== "object" ||
        obj[key] === null ||
        Array.isArray(obj[key])
      ) {
        throw new ConfigLoadError(
          `"${key}" must be an object, got ${Array.isArray(obj[key]) ? "array" : typeof obj[key]}`,
          filePath,
        );
      }
    }
  }

  return parsed as PartialAgentLoopConfig;
}

// ---------------------------------------------------------------------------
// Environment variable overlay
// ---------------------------------------------------------------------------

function envStr(key: string): string | undefined {
  return process.env[key];
}

function envInt(key: string): number | undefined {
  const v = envStr(key);
  if (v === undefined) return undefined;
  const n = parseInt(v, 10);
  return isNaN(n) ? undefined : n;
}

function envFloat(key: string): number | undefined {
  const v = envStr(key);
  if (v === undefined) return undefined;
  const n = parseFloat(v);
  return isNaN(n) ? undefined : n;
}

function envBool(key: string): boolean | undefined {
  const v = envStr(key);
  if (v === undefined) return undefined;
  return v.toLowerCase() === "true";
}

function envStringArray(key: string): string[] | undefined {
  const v = envStr(key);
  if (v === undefined) return undefined;
  if (!v) return [];
  return v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

type WebSearchProvider = "duckduckgo" | "tavily" | "langsearch" | "none";
const WEB_SEARCH_PROVIDERS: ReadonlySet<string> = new Set<WebSearchProvider>([
  "duckduckgo",
  "tavily",
  "langsearch",
  "none",
]);

function envWebSearchProvider(): string | undefined {
  const v = envStr("WEB_SEARCH_PROVIDER");
  if (v === undefined) return undefined;
  const lower = v.toLowerCase();
  return WEB_SEARCH_PROVIDERS.has(lower) ? lower : "duckduckgo";
}

/**
 * Build a partial config from environment variables. Only keys that are
 * actually set in the environment are included, so they only override
 * JSON-file values when explicitly set.
 */
export function buildEnvOverlay(): PartialAgentLoopConfig {
  const overlay: PartialAgentLoopConfig = {};

  // --- llm ---
  const llm: Partial<LlmConfig> = {};
  const llmProvider = envStr("LLM_PROVIDER");
  if (llmProvider !== undefined) llm.provider = llmProvider;
  const llmModel = envStr("LLM_MODEL");
  if (llmModel !== undefined) llm.model = llmModel;
  const llmTemp = envFloat("LLM_TEMPERATURE");
  if (llmTemp !== undefined) llm.temperature = llmTemp;
  const maxIter = envInt("MAX_ITERATIONS");
  if (maxIter !== undefined) llm.maxIterations = maxIter;
  const maxBudget = envInt("MAX_TOKENS_BUDGET");
  if (maxBudget !== undefined) llm.maxTokensBudget = maxBudget;
  const maxCtx = envInt("MAX_CONTEXT_TOKENS");
  if (maxCtx !== undefined) llm.maxContextTokens = maxCtx;
  const retryMax = envInt("LLM_RETRY_MAX");
  if (retryMax !== undefined) llm.retryMax = retryMax;
  const retryDelay = envInt("LLM_RETRY_BASE_DELAY_MS");
  if (retryDelay !== undefined) llm.retryBaseDelayMs = retryDelay;
  const streaming = envBool("STREAMING_ENABLED");
  if (streaming !== undefined) llm.streamingEnabled = streaming;
  if (Object.keys(llm).length > 0) overlay.llm = llm;

  // --- tools ---
  const tools: Partial<ToolsConfig> = {};
  const toolTimeout = envInt("TOOL_TIMEOUT_MS");
  if (toolTimeout !== undefined) tools.timeoutMs = toolTimeout;
  const toolAllow = envStringArray("TOOL_ALLOWLIST");
  if (toolAllow !== undefined) tools.allowlist = toolAllow;
  const toolBlock = envStringArray("TOOL_BLOCKLIST");
  if (toolBlock !== undefined) tools.blocklist = toolBlock;
  const maxConc = envInt("MAX_CONCURRENT_TOOLS");
  if (maxConc !== undefined) tools.maxConcurrent = maxConc;
  const shellBlock = envStringArray("SHELL_COMMAND_BLOCKLIST");
  if (shellBlock !== undefined) tools.shellCommandBlocklist = shellBlock;
  const autoApprove = envBool("AUTO_APPROVE_ALL");
  if (autoApprove !== undefined) tools.autoApproveAll = autoApprove;
  if (Object.keys(tools).length > 0)
    overlay.tools = tools;

  // --- execution ---
  const exec: Partial<ExecutionConfig> = {};
  const execTimeout = envInt("EXECUTION_TIMEOUT_MS");
  if (execTimeout !== undefined) exec.timeoutMs = execTimeout;
  const execEnv = envStr("EXECUTION_ENVIRONMENT");
  if (execEnv !== undefined) exec.environment = execEnv;
  const sandboxMode = envStr("SANDBOX_MODE");
  if (sandboxMode !== undefined) {
    if (sandboxMode === "none" || sandboxMode === "docker") {
      exec.sandboxMode = sandboxMode;
    }
    // Invalid values are silently ignored (defaults remain)
  }
  const dockerImage = envStr("SANDBOX_DOCKER_IMAGE");
  if (dockerImage !== undefined) exec.dockerImage = dockerImage;
  if (Object.keys(exec).length > 0)
    overlay.execution = exec;

  // --- paths ---
  const paths: Partial<PathsConfig> = {};
  const wsRoot = envStr("WORKSPACE_ROOT");
  if (wsRoot !== undefined) paths.workspaceRoot = wsRoot;
  const instrRoot = envStr("INSTRUCTIONS_ROOT");
  if (instrRoot !== undefined) paths.instructionsRoot = instrRoot;
  const ptDir = envStr("PROMPT_TEMPLATES_DIR");
  if (ptDir !== undefined) paths.promptTemplatesDir = ptDir;
  const phFile = envStr("PROMPT_HISTORY_FILE");
  if (phFile !== undefined) paths.promptHistoryFile = phFile;
  const skillsDir = envStr("SKILLS_DIR");
  if (skillsDir !== undefined) paths.skillsDir = skillsDir;
  const agentDir = envStr("AGENT_PROFILES_DIR");
  if (agentDir !== undefined) paths.agentProfilesDir = agentDir;
  const sysPrmpt = envStr("SYSTEM_PROMPT_PATH");
  if (sysPrmpt !== undefined) paths.systemPromptPath = sysPrmpt;
  if (Object.keys(paths).length > 0)
    overlay.paths = paths;

  // --- prompts ---
  const prompts: Partial<PromptsConfig> = {};
  const ctxRefresh = envInt("PROMPT_CONTEXT_REFRESH_MS");
  if (ctxRefresh !== undefined) prompts.contextRefreshMs = ctxRefresh;
  const rtCtx = envBool("RUNTIME_CONTEXT_ENABLED");
  if (rtCtx !== undefined) prompts.runtimeContextEnabled = rtCtx;
  if (Object.keys(prompts).length > 0)
    overlay.prompts = prompts;

  // --- search ---
  const search: Partial<SearchConfig> = {};
  const searchProv = envWebSearchProvider();
  if (searchProv !== undefined) search.provider = searchProv;
  const tavilyMax = envInt("TAVILY_MAX_RESULTS");
  if (tavilyMax !== undefined) search.tavilyMaxResults = tavilyMax;
  const lsMax = envInt("LANGSEARCH_MAX_RESULTS");
  if (lsMax !== undefined) search.langsearchMaxResults = lsMax;
  const ddgMax = envInt("DUCKDUCKGO_MAX_RESULTS");
  if (ddgMax !== undefined) search.duckduckgoMaxResults = ddgMax;
  const ddgDelay = envInt("DUCKDUCKGO_MIN_DELAY_MS");
  if (ddgDelay !== undefined) search.duckduckgoMinDelayMs = ddgDelay;
  const ddgRetry = envInt("DUCKDUCKGO_RETRY_MAX");
  if (ddgRetry !== undefined) search.duckduckgoRetryMax = ddgRetry;
  const ddgRetryDelay = envInt("DUCKDUCKGO_RETRY_BASE_DELAY_MS");
  if (ddgRetryDelay !== undefined)
    search.duckduckgoRetryBaseDelayMs = ddgRetryDelay;
  const ddgRateLimit = envInt("DUCKDUCKGO_RATE_LIMIT_PENALTY_MS");
  if (ddgRateLimit !== undefined)
    search.duckduckgoRateLimitPenaltyMs = ddgRateLimit;
  const ddgCacheTtl = envInt("DUCKDUCKGO_CACHE_TTL_MS");
  if (ddgCacheTtl !== undefined) search.duckduckgoCacheTtlMs = ddgCacheTtl;
  const ddgCacheMax = envInt("DUCKDUCKGO_CACHE_MAX_ENTRIES");
  if (ddgCacheMax !== undefined)
    search.duckduckgoCacheMaxEntries = ddgCacheMax;
  const ddgStale = envBool("DUCKDUCKGO_SERVE_STALE_ON_ERROR");
  if (ddgStale !== undefined) search.duckduckgoServeStaleOnError = ddgStale;
  if (Object.keys(search).length > 0)
    overlay.search = search;

  // --- observability ---
  const obs: Partial<ObservabilityConfig> = {};
  const tracing = envBool("TRACING_ENABLED");
  if (tracing !== undefined) obs.tracingEnabled = tracing;
  const traceDir = envStr("TRACE_OUTPUT_DIR");
  if (traceDir !== undefined) obs.traceOutputDir = traceDir;
  const costIn = envFloat("TRACING_COST_PER_INPUT_TOKEN_USD");
  if (costIn !== undefined) obs.tracingCostPerInputTokenUsd = costIn;
  const costOut = envFloat("TRACING_COST_PER_OUTPUT_TOKEN_USD");
  if (costOut !== undefined) obs.tracingCostPerOutputTokenUsd = costOut;
  const logLevel = envStr("LOG_LEVEL");
  if (logLevel !== undefined) obs.logLevel = logLevel;
  const logEnabled = envBool("LOG_ENABLED");
  if (logEnabled !== undefined) obs.logEnabled = logEnabled;
  const logDest = envStr("LOG_DESTINATION");
  if (logDest !== undefined) obs.logDestination = logDest;
  const logFile = envStr("LOG_FILE");
  if (logFile !== undefined) obs.logFile = logFile;
  const logName = envStr("LOG_NAME");
  if (logName !== undefined) obs.logName = logName;
  const logTs = envBool("LOG_TIMESTAMP");
  if (logTs !== undefined) obs.logTimestamp = logTs;
  if (Object.keys(obs).length > 0)
    overlay.observability = obs;

  // --- security ---
  const sec: Partial<SecurityConfig> = {};
  const maxFileSize = envInt("MAX_FILE_SIZE_BYTES");
  if (maxFileSize !== undefined) sec.maxFileSizeBytes = maxFileSize;
  const maxShell = envInt("MAX_SHELL_OUTPUT_BYTES");
  if (maxShell !== undefined) sec.maxShellOutputBytes = maxShell;
  const netDomains = envStringArray("NETWORK_ALLOWED_DOMAINS");
  if (netDomains !== undefined) sec.networkAllowedDomains = netDomains;
  if (Object.keys(sec).length > 0)
    overlay.security = sec;

  // --- webFetch ---
  const wf: Partial<WebFetchConfig> = {};
  const wfBlock = envStringArray("WEB_DOMAIN_BLOCKLIST");
  if (wfBlock !== undefined) wf.domainBlocklist = wfBlock;
  const wfAllow = envStringArray("WEB_DOMAIN_ALLOWLIST");
  if (wfAllow !== undefined) wf.domainAllowlist = wfAllow;
  const wfHttp = envBool("WEB_ALLOW_HTTP");
  if (wfHttp !== undefined) wf.allowHttp = wfHttp;
  const wfMaxResp = envInt("WEB_MAX_RESPONSE_BYTES");
  if (wfMaxResp !== undefined) wf.maxResponseBytes = wfMaxResp;
  const wfMaxChars = envInt("WEB_MAX_CONTENT_CHARS");
  if (wfMaxChars !== undefined) wf.maxContentChars = wfMaxChars;
  const wfUa = envStr("WEB_USER_AGENT");
  if (wfUa !== undefined) wf.userAgent = wfUa;
  const wfTimeout = envInt("WEB_FETCH_TIMEOUT_MS");
  if (wfTimeout !== undefined) wf.fetchTimeoutMs = wfTimeout;
  if (Object.keys(wf).length > 0)
    overlay.webFetch = wf;

  return overlay;
}

// ---------------------------------------------------------------------------
// Main loader
// ---------------------------------------------------------------------------

export interface LoadConfigOptions {
  /** Override user config path (for testing). */
  userConfigPath?: string;
  /** Override repo config path (for testing). */
  repoConfigPath?: string;
  /** Skip environment variable overlay (for testing). */
  skipEnv?: boolean;
}

/**
 * Load and resolve the full layered configuration.
 *
 * Precedence: defaults < user JSON < repo JSON < env vars
 * CLI overrides (e.g. --api-key) are applied externally after this returns.
 */
export function loadConfig(
  options: LoadConfigOptions = {},
): AgentLoopConfig {
  const layers: PartialAgentLoopConfig[] = [];

  // Layer 1: defaults
  layers.push(CONFIG_DEFAULTS);

  // Layer 2: user config
  const userPath = options.userConfigPath ?? getUserConfigPath();
  const userConfig = readConfigFile(userPath);
  if (userConfig) layers.push(userConfig);

  // Layer 3: repo config
  const repoPath = options.repoConfigPath ?? getRepoConfigPath();
  const repoConfig = readConfigFile(repoPath);
  if (repoConfig) layers.push(repoConfig);

  // Layer 4: env overlay
  if (!options.skipEnv) {
    layers.push(buildEnvOverlay());
  }

  return mergeConfigs(...layers) as AgentLoopConfig;
}
