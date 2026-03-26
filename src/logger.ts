import pino from "pino";
import { appConfig } from "./config";

function buildDestination() {
  if (appConfig.logger.file) {
    // Append to the specified file; pino.destination is synchronous-safe for file paths.
    return pino.destination({ dest: appConfig.logger.file, append: true, sync: false });
  }
  return appConfig.logger.destination.toLowerCase() === "stderr"
    ? pino.destination(2)
    : pino.destination(1);
}

export const logger = pino(
  {
    name: appConfig.logger.name,
    level: appConfig.logger.enabled ? appConfig.logger.level : "silent",
    base: undefined,
    timestamp: appConfig.logger.timestamp ? pino.stdTimeFunctions.isoTime : false,
  },
  buildDestination()
);
