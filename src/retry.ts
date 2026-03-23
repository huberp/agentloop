import { logger } from "./logger";
import { LLMAPIError, ToolExecutionError } from "./errors";

/** Options for retry behaviour. */
export interface RetryOptions {
  /** Maximum number of retry attempts (not counting the initial call). */
  maxRetries: number;
  /** Base delay in milliseconds for the exponential back-off formula. */
  baseDelayMs: number;
}

/** Returns true when the error looks like an HTTP 429 rate-limit response. */
export function isRateLimitError(error: unknown): boolean {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    if (msg.includes("429") || msg.includes("rate limit")) return true;
  }
  // HTTP-client libraries typically attach a numeric status code to the error object
  if (typeof error === "object" && error !== null) {
    const e = error as Record<string, unknown>;
    if (e.status === 429 || e.statusCode === 429) return true;
  }
  return false;
}

/**
 * Compute exponential back-off delay: baseDelayMs * 2^attempt, capped at 30 s,
 * with ±10 % random jitter to spread retries across concurrent callers.
 */
export function backoffMs(attempt: number, baseDelayMs: number): number {
  const base = baseDelayMs * Math.pow(2, attempt);
  const jitter = base * 0.1 * (Math.random() * 2 - 1);
  return Math.min(Math.round(base + jitter), 30_000);
}

/**
 * Invoke `fn` with retry + exponential back-off.
 * Rate-limit responses (HTTP 429) incur an additional 1 s penalty on top of the
 * regular back-off to respect server-side throttling.
 *
 * @throws {LLMAPIError} after `maxRetries` failed attempts.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions
): Promise<T> {
  const { maxRetries, baseDelayMs } = options;
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt >= maxRetries) break;

      const rateLimit = isRateLimitError(error);
      const delay = backoffMs(attempt, baseDelayMs) + (rateLimit ? 1_000 : 0);

      logger.warn(
        {
          attempt: attempt + 1,
          maxRetries,
          delayMs: delay,
          rateLimit,
          error: error instanceof Error ? error.message : String(error),
        },
        "LLM call failed; retrying with back-off"
      );

      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  const cause = lastError instanceof Error ? lastError : undefined;
  throw new LLMAPIError(
    `LLM call failed after ${maxRetries} retries: ${cause?.message ?? String(lastError)}`,
    cause
  );
}

/**
 * Race a tool invocation against a hard timeout.
 *
 * @throws {ToolExecutionError} when `timeoutMs` elapses before the tool resolves.
 */
export async function invokeWithTimeout<T>(
  promise: Promise<T>,
  toolName: string,
  timeoutMs: number
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(
      () =>
        reject(
          new ToolExecutionError(toolName, `Tool timed out after ${timeoutMs} ms`)
        ),
      timeoutMs
    );
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timeoutId);
  }
}
