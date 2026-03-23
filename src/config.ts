import * as dotenv from "dotenv";

dotenv.config({ quiet: true });

function asBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) {
    return defaultValue;
  }

  return value.toLowerCase() === "true";
}

export const appConfig = {
  mistralApiKey: process.env.MISTRAL_API_KEY ?? "",
  // Maximum number of agentic iterations before aborting with a warning
  maxIterations: parseInt(process.env.MAX_ITERATIONS ?? "20", 10),
  // Token budget reserved for future context-window management (0 = disabled)
  maxTokensBudget: parseInt(process.env.MAX_TOKENS_BUDGET ?? "0", 10),
  // LLM provider selection and model settings
  llmProvider: process.env.LLM_PROVIDER ?? "mistral",
  llmModel: process.env.LLM_MODEL ?? "",
  llmTemperature: parseFloat(process.env.LLM_TEMPERATURE ?? "0.7"),
  // Optional path to a .txt or .md file that overrides the generated system prompt
  systemPromptPath: process.env.SYSTEM_PROMPT_PATH ?? "",
  logger: {
    level: process.env.LOG_LEVEL ?? "info",
    enabled: asBoolean(process.env.LOG_ENABLED, true),
    destination: process.env.LOG_DESTINATION ?? "stdout",
    name: process.env.LOG_NAME ?? "agentloop",
    timestamp: asBoolean(process.env.LOG_TIMESTAMP, true),
  },
};
