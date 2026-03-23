/** Custom error types for the agent loop. */

/** Thrown when the LLM API call fails after all retries are exhausted. */
export class LLMAPIError extends Error {
  constructor(message: string, public readonly cause?: Error) {
    super(message);
    this.name = "LLMAPIError";
  }
}

/** Thrown (or injected as ToolMessage) when a tool invocation fails or times out. */
export class ToolExecutionError extends Error {
  constructor(
    public readonly toolName: string,
    message: string,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = "ToolExecutionError";
  }
}

/** Thrown when the agent loop hits the configured MAX_ITERATIONS guard. */
export class MaxIterationsError extends Error {
  constructor(public readonly iterations: number) {
    super(`Agent loop exceeded the maximum of ${iterations} iterations`);
    this.name = "MaxIterationsError";
  }
}

/** Thrown when a message list exceeds the allowed context-token budget. */
export class ContextOverflowError extends Error {
  constructor(public readonly tokens: number, public readonly limit: number) {
    super(`Context size ${tokens} tokens exceeds the configured limit of ${limit}`);
    this.name = "ContextOverflowError";
  }
}
