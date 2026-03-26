/**
 * Benchmark: Context Trimming
 *
 * Builds a 1000-message history and trims it to a restricted token budget.
 * Acceptance criterion: total trimMessages() call completes in < 100ms.
 */
import { performance } from "node:perf_hooks";
import { HumanMessage, AIMessage, SystemMessage } from "@langchain/core/messages";
import { trimMessages } from "../src/context";

export interface BenchmarkResult {
  name: string;
  durationMs: number;
  iterations: number;
  opsPerSec: number;
}

const MESSAGE_COUNT = 1000;

/** Build a realistic 1000-message conversation history. */
function buildHistory(): ReturnType<typeof Array.from<HumanMessage | AIMessage | SystemMessage>> {
  const messages: Array<HumanMessage | AIMessage | SystemMessage> = [
    new SystemMessage(
      "You are a helpful AI assistant with expertise in software engineering. " +
        "Provide accurate, concise answers and working code examples when requested."
    ),
  ];

  for (let i = 1; i < MESSAGE_COUNT; i++) {
    if (i % 2 === 1) {
      messages.push(
        new HumanMessage(
          `Question ${i}: Can you explain how ${["closures", "promises", "generators", "proxies", "decorators"][i % 5]} work in TypeScript? ` +
            `Also, what are the best practices for using them in production code?`
        )
      );
    } else {
      messages.push(
        new AIMessage(
          `Answer ${i}: In TypeScript, ${["closures", "promises", "generators", "proxies", "decorators"][(i - 1) % 5]} ` +
            `are a fundamental concept. Here is a concise example: ` +
            `function example${i}() { return (x: number) => x * ${i}; } ` +
            `The best practice is to use them judiciously and with proper typing.`
        )
      );
    }
  }

  return messages;
}

export async function run(): Promise<BenchmarkResult> {
  const messages = buildHistory();

  // Trim to ~10% of the estimated token budget to force heavy trimming
  const MAX_TOKENS = 500;

  // Warm up to ensure the tiktoken WASM module is fully initialised
  trimMessages(messages.slice(0, 10), MAX_TOKENS);

  const start = performance.now();
  const result = trimMessages(messages, MAX_TOKENS);
  const durationMs = performance.now() - start;

  if (durationMs >= 100) {
    throw new Error(
      `Context trimming too slow: ${durationMs.toFixed(2)}ms (threshold: < 100ms for ${MESSAGE_COUNT} messages)`
    );
  }

  return {
    name: `Context Trimming (${MESSAGE_COUNT} messages → ${result.length} kept, budget: ${MAX_TOKENS} tokens)`,
    durationMs,
    iterations: 1,
    opsPerSec: Math.round(1000 / durationMs),
  };
}
