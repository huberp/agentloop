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
  logger: {
    level: process.env.LOG_LEVEL ?? "info",
    enabled: asBoolean(process.env.LOG_ENABLED, true),
    destination: process.env.LOG_DESTINATION ?? "stdout",
    name: process.env.LOG_NAME ?? "agentloop",
    timestamp: asBoolean(process.env.LOG_TIMESTAMP, true),
  },
};
