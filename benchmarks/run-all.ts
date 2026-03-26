/**
 * AgentLoop Benchmark Runner
 *
 * Executes all benchmark suites and prints a formatted results table.
 * Exits with code 1 if any benchmark fails its embedded acceptance criteria.
 *
 * Usage:
 *   npx tsx benchmarks/run-all.ts
 */
import { performance } from "node:perf_hooks";

export interface BenchmarkResult {
  name: string;
  durationMs: number;
  iterations: number;
  opsPerSec: number;
}

interface RunRecord {
  label: string;
  result: BenchmarkResult | null;
  status: "PASS" | "FAIL";
  errorMessage: string;
  wallMs: number;
}

const BENCHMARKS: Array<{ label: string; module: string }> = [
  { label: "Tool Registry Lookup", module: "./tool-registry.bench" },
  { label: "Context Trimming",     module: "./context-trim.bench"  },
  { label: "Code Search",          module: "./code-search.bench"   },
  { label: "Workspace Analysis",   module: "./workspace-analysis.bench" },
];

// ---------------------------------------------------------------------------
// Table renderer
// ---------------------------------------------------------------------------

function renderTable(records: RunRecord[]): void {
  const headers = ["Benchmark", "Duration (ms)", "Iterations", "Ops/sec", "Status"];

  const rows = records.map((r) => [
    r.result?.name ?? r.label,
    r.result ? r.result.durationMs.toFixed(2) : "—",
    r.result ? r.result.iterations.toLocaleString() : "—",
    r.result ? r.result.opsPerSec.toLocaleString() : "—",
    r.status === "PASS" ? "PASS" : `FAIL: ${r.errorMessage}`,
  ]);

  const colWidths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((row) => row[i].length))
  );

  const sep = "+" + colWidths.map((w) => "-".repeat(w + 2)).join("+") + "+";
  const fmtRow = (cells: string[]) =>
    "| " + cells.map((c, i) => c.padEnd(colWidths[i])).join(" | ") + " |";

  console.log(sep);
  console.log(fmtRow(headers));
  console.log(sep);
  for (const row of rows) {
    console.log(fmtRow(row));
  }
  console.log(sep);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("=".repeat(60));
  console.log("  AgentLoop Performance Benchmarks");
  console.log(`  ${new Date().toISOString()}`);
  console.log("=".repeat(60));
  console.log();

  const records: RunRecord[] = [];
  let anyFailed = false;

  for (const { label, module } of BENCHMARKS) {
    process.stdout.write(`  Running: ${label.padEnd(25)} `);
    const t0 = performance.now();

    try {
      // Dynamic import so each benchmark's module is loaded just-in-time
      const mod = (await import(module)) as { run(): Promise<BenchmarkResult> };
      const result = await mod.run();
      const wallMs = performance.now() - t0;

      process.stdout.write(`✓  (${wallMs.toFixed(0)}ms)\n`);
      records.push({ label, result, status: "PASS", errorMessage: "", wallMs });
    } catch (err: unknown) {
      const wallMs = performance.now() - t0;
      const errorMessage = err instanceof Error ? err.message : String(err);

      process.stdout.write(`✗  (${wallMs.toFixed(0)}ms)\n`);
      console.error(`    ${errorMessage}\n`);
      records.push({ label, result: null, status: "FAIL", errorMessage, wallMs });
      anyFailed = true;
    }
  }

  console.log();
  console.log("Results");
  console.log("-".repeat(60));
  renderTable(records);

  console.log();
  console.log("Acceptance Criteria");
  console.log("-".repeat(60));
  console.log("  • Tool registry lookup: avg < 1ms per lookup (100 tools, 10k iterations)");
  console.log("  • Context trimming:     total < 100ms for 1000 messages");
  console.log();

  const passed = records.filter((r) => r.status === "PASS").length;
  const total  = records.length;
  console.log(`  ${passed}/${total} benchmarks passed`);
  console.log();

  if (anyFailed) {
    console.error("One or more benchmarks failed their acceptance criteria.");
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error("\nBenchmark runner crashed:", err);
  process.exit(1);
});
