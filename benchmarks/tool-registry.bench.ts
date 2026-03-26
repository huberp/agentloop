/**
 * Benchmark: Tool Registry Lookup
 *
 * Registers 100 tools and performs 10,000 random lookups.
 * Acceptance criterion: average per-lookup time < 1ms.
 */
import { performance } from "node:perf_hooks";
import { z } from "zod";
import { ToolRegistry } from "../src/tools/registry";

export interface BenchmarkResult {
  name: string;
  durationMs: number;
  iterations: number;
  opsPerSec: number;
}

const TOOL_COUNT = 100;
const LOOKUP_ITERATIONS = 10_000;

export async function run(): Promise<BenchmarkResult> {
  const registry = new ToolRegistry();

  // Register 100 dummy tools
  for (let i = 0; i < TOOL_COUNT; i++) {
    registry.register({
      name: `bench-tool-${i}`,
      description: `Dummy tool ${i} for benchmarking registry lookup performance`,
      schema: z.object({ input: z.string().describe("Input value") }),
      execute: async ({ input }: { input: string }) => `result-${i}: ${input}`,
    });
  }

  // Warm up: prime the Map's internal hot path
  for (let i = 0; i < 200; i++) {
    registry.get(`bench-tool-${i % TOOL_COUNT}`);
  }

  const start = performance.now();

  for (let j = 0; j < LOOKUP_ITERATIONS; j++) {
    registry.get(`bench-tool-${j % TOOL_COUNT}`);
  }

  const durationMs = performance.now() - start;
  const avgLookupMs = durationMs / LOOKUP_ITERATIONS;

  if (avgLookupMs >= 1) {
    throw new Error(
      `Tool registry lookup too slow: avg ${avgLookupMs.toFixed(4)}ms per lookup (threshold: < 1ms)`
    );
  }

  return {
    name: `Tool Registry Lookup (${TOOL_COUNT} tools, ${LOOKUP_ITERATIONS.toLocaleString()} iterations)`,
    durationMs,
    iterations: LOOKUP_ITERATIONS,
    opsPerSec: Math.round((LOOKUP_ITERATIONS / durationMs) * 1000),
  };
}
