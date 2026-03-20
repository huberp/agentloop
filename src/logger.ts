import pino from "pino";
import { appConfig } from "./config";

const destination =
  appConfig.logger.destination.toLowerCase() === "stderr"
    ? pino.destination(2)
    : pino.destination(1);

export const logger = pino(
  {
    name: appConfig.logger.name,
    level: appConfig.logger.enabled ? appConfig.logger.level : "silent",
    base: undefined,
    timestamp: appConfig.logger.timestamp ? pino.stdTimeFunctions.isoTime : false,
  },
  destination
);
