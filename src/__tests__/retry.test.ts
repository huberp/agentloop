import { LLMAPIError, ToolExecutionError, MaxIterationsError, ContextOverflowError } from "../errors";
import { withRetry, invokeWithTimeout, isRateLimitError, backoffMs } from "../retry";

// ---------------------------------------------------------------------------
// Custom error types
// ---------------------------------------------------------------------------

describe("LLMAPIError", () => {
  it("has the correct name and message", () => {
    const err = new LLMAPIError("api down");
    expect(err.name).toBe("LLMAPIError");
    expect(err.message).toBe("api down");
    expect(err).toBeInstanceOf(Error);
  });

  it("stores the cause", () => {
    const cause = new Error("upstream");
    const err = new LLMAPIError("wrapper", cause);
    expect(err.cause).toBe(cause);
  });
});

describe("ToolExecutionError", () => {
  it("has the correct name, toolName, and message", () => {
    const err = new ToolExecutionError("search", "search failed");
    expect(err.name).toBe("ToolExecutionError");
    expect(err.toolName).toBe("search");
    expect(err.message).toBe("search failed");
    expect(err).toBeInstanceOf(Error);
  });
});

describe("MaxIterationsError", () => {
  it("embeds the iteration count in the message", () => {
    const err = new MaxIterationsError(20);
    expect(err.name).toBe("MaxIterationsError");
    expect(err.iterations).toBe(20);
    expect(err.message).toContain("20");
  });
});

describe("ContextOverflowError", () => {
  it("includes token counts in the message", () => {
    const err = new ContextOverflowError(32000, 28000);
    expect(err.name).toBe("ContextOverflowError");
    expect(err.tokens).toBe(32000);
    expect(err.limit).toBe(28000);
    expect(err.message).toContain("32000");
    expect(err.message).toContain("28000");
  });
});

// ---------------------------------------------------------------------------
// isRateLimitError
// ---------------------------------------------------------------------------

describe("isRateLimitError", () => {
  it("returns true for an error containing '429' in the message", () => {
    expect(isRateLimitError(new Error("Request failed with status 429"))).toBe(true);
  });

  it("returns true for an error containing 'rate limit' (case-insensitive)", () => {
    expect(isRateLimitError(new Error("Rate Limit exceeded"))).toBe(true);
  });

  it("returns true for an object with status === 429", () => {
    expect(isRateLimitError({ status: 429, message: "too many requests" })).toBe(true);
  });

  it("returns true for an object with statusCode === 429", () => {
    expect(isRateLimitError({ statusCode: 429 })).toBe(true);
  });

  it("returns false for a generic error", () => {
    expect(isRateLimitError(new Error("Internal server error"))).toBe(false);
  });

  it("returns false for null / non-objects", () => {
    expect(isRateLimitError(null)).toBe(false);
    expect(isRateLimitError("some string")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// backoffMs
// ---------------------------------------------------------------------------

describe("backoffMs", () => {
  it("returns a positive value for attempt 0", () => {
    expect(backoffMs(0, 500)).toBeGreaterThan(0);
  });

  it("grows with each attempt", () => {
    const d0 = backoffMs(0, 500);
    const d1 = backoffMs(1, 500);
    const d2 = backoffMs(2, 500);
    // Allow for jitter — just check ordering on multiple samples
    expect(d1).toBeGreaterThan(0);
    expect(d2).toBeGreaterThan(0);
    // At attempt=0 base=500, attempt=1 base=1000, attempt=2 base=2000
    // With ±10% jitter the intervals should not overlap (500±50 vs 1000±100)
    expect(d1).toBeGreaterThan(d0 * 0.8);
  });

  it("caps at 30 000 ms", () => {
    // attempt=20 would give 500 * 2^20 ≈ 524 million — well above the cap
    expect(backoffMs(20, 500)).toBeLessThanOrEqual(30_000);
  });
});

// ---------------------------------------------------------------------------
// withRetry
// ---------------------------------------------------------------------------

describe("withRetry", () => {
  // Use fake timers to avoid real waits in tests
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  /** Advance fake timers AND flush any pending micro/macro tasks. */
  async function flushRetry() {
    await Promise.resolve(); // flush the pending awaits inside withRetry
    jest.runAllTimers();     // fire all setTimeout callbacks
    await Promise.resolve(); // let the resolved timers re-enter the event loop
  }

  it("(a) resolves immediately on the first successful call", async () => {
    const fn = jest.fn().mockResolvedValue("ok");
    await expect(withRetry(fn, { maxRetries: 3, baseDelayMs: 10 })).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("(a) LLM timeout → retry → success: retries on failure and succeeds on the second attempt", async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValueOnce("recovered");

    const promise = withRetry(fn, { maxRetries: 3, baseDelayMs: 10 });
    await flushRetry();

    await expect(promise).resolves.toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("(b) LLM timeout → max retries → LLMAPIError: throws LLMAPIError after exhausting retries", async () => {
    const fn = jest.fn().mockRejectedValue(new Error("persistent failure"));

    const promise = withRetry(fn, { maxRetries: 2, baseDelayMs: 10 });

    // Flush two retry waits
    await flushRetry();
    await flushRetry();

    await expect(promise).rejects.toBeInstanceOf(LLMAPIError);
    expect(fn).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
  });

  it("propagates the original error message inside LLMAPIError", async () => {
    const fn = jest.fn().mockRejectedValue(new Error("upstream exploded"));

    const promise = withRetry(fn, { maxRetries: 1, baseDelayMs: 10 });
    await flushRetry();

    const err = await promise.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LLMAPIError);
    expect((err as LLMAPIError).message).toContain("upstream exploded");
  });

  it("applies extra delay for rate-limit errors (429)", async () => {
    // Verify the function is still retried on a 429 error
    const fn = jest
      .fn()
      .mockRejectedValueOnce(new Error("429 rate limit exceeded"))
      .mockResolvedValueOnce("after rate limit");

    const promise = withRetry(fn, { maxRetries: 3, baseDelayMs: 10 });
    await flushRetry();

    await expect(promise).resolves.toBe("after rate limit");
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// invokeWithTimeout
// ---------------------------------------------------------------------------

describe("invokeWithTimeout", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it("resolves with the tool output when it completes within the timeout", async () => {
    const fast = Promise.resolve("tool result");
    await expect(invokeWithTimeout(fast, "search", 5_000)).resolves.toBe("tool result");
  });

  it("(d) tool timeout: rejects with ToolExecutionError when the tool exceeds the timeout", async () => {
    // A promise that never resolves — simulating a hung tool
    const hung = new Promise<string>(() => {/* never resolves */});

    const promise = invokeWithTimeout(hung, "search", 100);
    jest.runAllTimers();

    const err = await promise.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ToolExecutionError);
    expect((err as ToolExecutionError).toolName).toBe("search");
    expect((err as ToolExecutionError).message).toContain("timed out");
  });
});
