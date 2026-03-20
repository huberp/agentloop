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
  logger: {
    level: process.env.LOG_LEVEL ?? "info",
    enabled: asBoolean(process.env.LOG_ENABLED, true),
    destination: process.env.LOG_DESTINATION ?? "stdout",
    name: process.env.LOG_NAME ?? "agentloop",
    timestamp: asBoolean(process.env.LOG_TIMESTAMP, true),
  },
};
