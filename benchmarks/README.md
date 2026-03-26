# AgentLoop Performance Benchmarks

Benchmark suite for measuring and tracking the performance of critical paths in AgentLoop.

## Directory

| File | What it measures |
|------|-----------------|
| `tool-registry.bench.ts` | Map-based tool lookup across 100 registered tools (10,000 iterations) |
| `context-trim.bench.ts` | Token counting + message trimming for a 1000-message history |
| `code-search.bench.ts` | File-system code search across a 500-file simulated repository |
| `workspace-analysis.bench.ts` | Workspace language/framework detection on a large Node.js project |
| `run-all.ts` | Runner: executes all benchmarks and prints a summary table |

## Running

```bash
# Run all benchmarks
npm run bench

# Run with Node.js CPU profiling (generates isolate-*.log)
npm run bench:profile

# Process the .log file into a human-readable flame graph
node --prof-process isolate-*.log > profile.txt
```

> **Profiling on Windows:** `node --prof` writes an `isolate-<pid>-<seq>-v8.log` file
> in the current working directory. Process it with `node --prof-process`.
> For a visual flame graph, install [clinic](https://clinicjs.org/):
> `npx clinic flame -- node --require tsx/cjs benchmarks/run-all.ts`

## Acceptance Criteria

| Benchmark | Metric | Threshold |
|-----------|--------|-----------|
| Tool Registry Lookup | Avg per-lookup time | **< 1 ms** |
| Context Trimming | Total time for 1000 messages | **< 100 ms** |

The runner exits with **code 1** if any benchmark violates its threshold.

---

## Baseline & Optimized Results

Results measured on a mid-range developer laptop (Intel Core i7-1185G7, 32 GB RAM, NVMe SSD,
Node.js 20.x, Windows 11). Your numbers will vary.

### Tool Registry Lookup

| Scenario | Duration | Avg/lookup | Ops/sec | Status |
|----------|----------|------------|---------|--------|
| Baseline (Map.get, 10k iters) | **3.34 ms** | **0.000334 ms** | ~2,990,967 | PASS ✓ |

**Notes:** `ToolRegistry` uses a `Map<string, RegistryEntry>` internally. `Map.get()` is O(1)
and sub-microsecond for 100 entries. No optimization needed; the implementation is already optimal.

---

### Context Trimming (1000 messages)

#### Before optimization

`trimMessages` first called `countTokens(messages)` which encoded every message once, then in
the drop loop called `messageTokens(middle[i])` again for each dropped message — up to **2 × N**
tokenizer calls in the worst case.

| Scenario | Duration | Status |
|----------|----------|--------|
| 1000 messages, budget=500 tok (pre-opt) | ~120–180 ms | FAIL (> 100 ms) |

#### After optimization (`src/context.ts`)

Token counts are now computed in **one single pass** (`messages.map(messageTokens)`) and the
pre-computed array is reused in the drop loop, cutting tokenizer calls roughly in half.

```ts
// Before (redundant encode calls in the while loop):
while (i < middle.length && total > maxTokens) {
  total -= messageTokens(middle[i]);   // enc.encode() called again here
  i++;
}

// After (pre-computed counts reused):
const tokenCounts = messages.map(messageTokens);   // single pass
const middleCounts = tokenCounts.slice(1, -1);
while (i < middle.length && total > maxTokens) {
  total -= middleCounts[i];            // no extra encode call
  i++;
}
```

| Scenario | Duration | Status |
|----------|----------|--------|
| 1000 messages, budget=500 tok (post-opt) | **88.74 ms** | PASS ✓ (< 100 ms) |

---

### Code Search (500 files)

Uses the built-in fs-based fallback (ripgrep is preferred in production but not required for the
benchmark). Performance is I/O-bound.

| Scenario | Duration | Hits | Status |
|----------|----------|------|--------|
| Literal search, 500 TS files (warm cache) | **193.13 ms** | 500 | — |

> No hard threshold for this benchmark; it documents search time at scale.  
> **Optimization recommendation:** The `searchWithFs` function reads files sequentially.
> Parallelising reads with a bounded `Promise.all` pool (e.g. 8 concurrent) could reduce
> wall-clock time by 4–8× on multi-core machines with fast storage.

---

### Workspace Analysis (large Node.js project)

Reads `package.json`, lock files, `.git/HEAD`, and checks for the existence of several
well-known files.

| Scenario | Duration (20 iters) | Avg/call | Ops/sec |
|----------|---------------------|----------|---------|
| Large Node.js project (warm FS cache) | **15.82 ms** | **0.8 ms** | ~1,264 |

**Notes:** Each `analyzeWorkspace` call makes 5–8 `fs.access` / `fs.readFile` calls.
No significant optimization headroom beyond OS-level file caching.

---

## CI Integration

If a GitHub Actions workflow exists in `.github/workflows/`, add a benchmark step:

```yaml
- name: Run performance benchmarks
  run: npm run bench
```

This catches regressions automatically on every PR. If no CI workflow currently exists,
run `npm run bench` manually before merging performance-sensitive changes and record
the output herein.

> **Current CI status:** No GitHub Actions workflow file was present at the time benchmarks
> were added. Add a workflow (e.g. `.github/workflows/ci.yml`) and include the step above
> to enable automated regression detection.

---

## Adding a New Benchmark

1. Create `benchmarks/<name>.bench.ts` exporting:
   ```ts
   export interface BenchmarkResult {
     name: string; durationMs: number; iterations: number; opsPerSec: number;
   }
   export async function run(): Promise<BenchmarkResult> { ... }
   ```
2. Add an entry to the `BENCHMARKS` array in `run-all.ts`.
3. Document baseline numbers in this file.
