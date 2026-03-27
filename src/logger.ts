import pino from "pino";
import { appConfig } from "./config";

export interface LogEntry {
  level: number;
  message: string;
  timestamp: number;
  payload?: unknown;
}

type LogListener = (entry: LogEntry) => void;

const logListeners = new Set<LogListener>();

/** Subscribe to runtime log events. Returns an unsubscribe function. */
export function addLogListener(listener: LogListener): () => void {
  logListeners.add(listener);
  return () => {
    logListeners.delete(listener);
  };
}

function emitLog(entry: LogEntry): void {
  for (const listener of logListeners) {
    try {
      listener(entry);
    } catch {
      // Never allow listener failures to affect primary logging behavior.
    }
  }
}

function extractMessage(args: unknown[]): string {
  const textArg = args.find((arg) => typeof arg === "string");
  if (typeof textArg === "string") return textArg;
  const first = args[0];
  if (first === undefined) return "";
  if (typeof first === "string") return first;
  if (first instanceof Error) return first.message;
  try {
    return JSON.stringify(first);
  } catch {
    return String(first);
  }
}

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
    hooks: {
      logMethod(args: unknown[], method: (...params: unknown[]) => void, level: number) {
        emitLog({
          level,
          message: extractMessage(args),
          timestamp: Date.now(),
          payload: args.length > 1 ? args[0] : undefined,
        });
        method.apply(this, args);
      },
    },
  },
  buildDestination()
);
