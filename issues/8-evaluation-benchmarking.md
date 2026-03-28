# Agent Evaluation & Benchmarking Framework

**Labels:** `enhancement`, `observability`, `testing`, `reliability`
**Milestone:** Phase 9 — Production Reliability

---

## Problem Statement

`agentloop` has no way to measure whether an agent actually completed a task
correctly. The existing `FileTracer` in `src/observability.ts` records *how* an
agent ran (token counts, tool call durations, USD cost) but records nothing about
*whether the output was right*. There is no concept of a ground-truth expected
answer, no pass/fail verdict per invocation, no aggregate success-rate metric,
and no repeatable benchmark suite against which agent profiles or model upgrades
can be compared.

The concrete gaps today:

| Gap | Impact |
|-----|--------|
| `InvocationTrace` has no `outcome` or `success` field | No machine-readable pass/fail signal; CI cannot gate on quality |
| No `EvalCase` / `EvalSuite` abstractions | Every developer must hand-roll their own eval harness |
| No built-in benchmark tasks (coding, tool-use, reasoning) | Cannot verify a model swap does not regress the agent |
| No A/B comparison path across `AgentProfile` configurations | Cannot quantify the effect of changing temperature, skills, or tool allowlists |
| No aggregate metrics (task-completion rate, mean tool calls, mean latency, mean cost) | Cannot track quality over time or across releases |
| `benchmarks/run-all.ts` contains only performance microbenchmarks | Latency benchmarks say nothing about correctness |

---

## Motivation

### BMW Agents Paper Context

The BMW Agents paper (which motivates the multi-agent design of `agentloop`)
identifies evaluation as the *primary open challenge* for industrial multi-agent
deployment:

> "Evaluating complex multi-step agent behaviour remains an open research problem.
> Classical unit tests are insufficient; correctness depends on the emergent sequence
> of tool calls and intermediate reasoning steps, not just the final text output."

Specific reliability requirements the paper highlights that are not addressable
today in `agentloop`:

- **Regression gating**: a model or prompt change must be verifiable to not reduce
  task-completion rate before deployment.
- **Profile certification**: a new `AgentProfile` (e.g. `security-auditor.agent.json`)
  must be benchmarked against a representative task set before being marked `built-in`.
- **Cost/quality trade-off analysis**: enterprise buyers need to compare a cheaper
  model at higher temperature vs. a premium model to choose the right configuration.

### Industry Benchmarks and Frameworks

| Reference | What it contributes to this design |
|-----------|-------------------------------------|
| **AgentBench** | Structured `EvalCase` with `input`, `expected`, `judge` triad; aggregate pass-rate across a named suite |
| **GAIA** | Multi-step tasks that require several tool calls to complete; verifiable final answers |
| **SWE-Bench** | Code-modification tasks with automated test-suite verification as the judge |
| **HumanEval** | Function-completion tasks with execution-based judging; no subjective LLM-as-judge required |
| **LangSmith** | Datasets as first-class objects; reproducible re-runs against the same dataset; online evals via callbacks |

The design below borrows the `(input, expected, judge)` triad from AgentBench,
the execution-based judge concept from HumanEval/SWE-Bench, and the pluggable
dataset format from LangSmith — while staying entirely within the existing
`agentloop` abstractions (`ToolRegistry`, `AgentProfile`, `InvocationTrace`,
`MockChatModel`).

---

## Proposed Solution

Add a self-contained `src/evaluation/` module that integrates with `src/observability.ts`
and the existing `src/testing/` helpers to provide:

1. **Typed `EvalCase` / `EvalSuite`** — declarative task definitions with
   ground-truth expectations and a pluggable judge function.
2. **`EvalRunner`** — executes a suite against a live or mocked agent, collects
   `InvocationTrace`s, applies judges, and emits structured `EvalReport`s.
3. **Built-in judges** — exact-string match, regex match, substring containment,
   JSON schema validation, tool-call sequence match, and an optional
   LLM-as-judge fallback.
4. **`BenchmarkSuite` definitions** — three starter suites: `tool-use`, `coding`,
   and `reasoning`, each with at least five deterministic eval cases backed by
   fixture files so CI can run them without a real LLM key.
5. **`bench:eval` npm script** — a CLI entry point (`benchmarks/run-eval.ts`)
   that runs all registered suites, prints a summary table, writes a JSON report,
   and exits non-zero on regression (configurable pass-rate threshold).
6. **`InvocationTrace` outcome extension** — extend the existing interface in
   `src/observability.ts` with an optional `outcome` field so trace files
   produced during evals carry the verdict alongside cost/latency data.
7. **A/B comparison helper** — `compareProfiles()` in
   `src/evaluation/compare.ts` runs the same suite against two `AgentProfile`
   configs and produces a side-by-side delta report.

---

## Implementation Steps

### Step 1 — Extend `InvocationTrace` with outcome data

**File:** `src/observability.ts`

Add an `EvalOutcome` sub-interface and an optional `outcome` field to
`InvocationTrace`. The field is populated only when the tracer is driven by the
eval runner; ordinary runs leave it `undefined` so there is no breaking change.

```ts
/** Verdict attached to an invocation when it is run as part of an eval suite. */
export interface EvalOutcome {
  /** Name of the eval case that produced this invocation. */
  caseName: string;
  /** Name of the suite the case belongs to. */
  suiteName: string;
  /** Whether the judge approved the agent output. */
  passed: boolean;
  /** Human-readable verdict message from the judge. */
  verdict: string;
  /** The expected value supplied by the eval case. */
  expected: unknown;
  /** The actual output produced by the agent. */
  actual: string;
}
```

Add `outcome?: EvalOutcome` to `InvocationTrace` (after `estimatedCostUsd`).
No other changes to `FileTracer` are needed — the eval runner sets
`trace.outcome` after `endInvocation` resolves, before writing the
suite report.

---

### Step 2 — Create `src/evaluation/types.ts`

Define the core eval primitives:

```ts
/** A single evaluation task with its ground-truth expectation. */
export interface EvalCase {
  /** Unique, human-readable identifier within the suite. */
  name: string;
  /** Natural-language description of what is being tested. */
  description: string;
  /** The human turn passed to the agent (the task prompt). */
  input: string;
  /**
   * The ground-truth value the judge receives alongside the agent output.
   * Shape depends on the judge: a string for exact/regex match, a JSON
   * Schema object for schema validation, a ToolCallSequence for tool-use
   * benchmarks, etc.
   */
  expected: unknown;
  /**
   * Optional: name of an `AgentProfile` to activate for this specific case.
   * Overrides the suite-level profile.
   */
  agentProfile?: string;
  /**
   * Optional: LLM fixture file path (relative to `LLM_FIXTURE_DIR`) to use
   * instead of a real LLM call.  Enables fully deterministic CI runs.
   */
  fixturePath?: string;
  /** Optional metadata tags (e.g. "tool-use", "multi-step", "file-write"). */
  tags?: string[];
}

/** Function that decides whether an agent output satisfies an eval case. */
export type JudgeFn = (
  actual: string,
  expected: unknown,
  trace: InvocationTrace,
) => JudgeResult | Promise<JudgeResult>;

export interface JudgeResult {
  passed: boolean;
  verdict: string;
}

/** A collection of eval cases that share a judge and optional agent profile. */
export interface EvalSuite {
  name: string;
  description: string;
  /** Default judge applied to all cases unless a case overrides it. */
  judge: JudgeFn;
  cases: EvalCase[];
  /** Optional: name of an `AgentProfile` to activate for all cases in this suite. */
  agentProfile?: string;
}

/** Per-case result produced by `EvalRunner`. */
export interface CaseResult {
  caseName: string;
  suiteName: string;
  passed: boolean;
  verdict: string;
  durationMs: number;
  totalTokens: number;
  estimatedCostUsd: number;
  toolCallCount: number;
  llmCallCount: number;
  error?: string;
}

/** Aggregate report for a full suite run. */
export interface EvalReport {
  suiteName: string;
  runAt: number;
  /** Pass rate: passCount / total (0–1). */
  passRate: number;
  passCount: number;
  failCount: number;
  total: number;
  /** Mean wall-clock duration across all cases in ms. */
  meanDurationMs: number;
  /** Mean total token usage across all cases. */
  meanTotalTokens: number;
  /** Mean estimated USD cost across all cases. */
  meanEstimatedCostUsd: number;
  caseResults: CaseResult[];
}
```

Import `InvocationTrace` from `../observability`.

---

### Step 3 — Create `src/evaluation/judges.ts`

Implement the built-in judge factory functions. Each returns a `JudgeFn`:

| Export | Behaviour |
|--------|-----------|
| `exactMatch()` | `passed = actual.trim() === String(expected).trim()` |
| `substringMatch()` | `passed = actual.includes(String(expected))` |
| `regexMatch(flags?)` | Treats `expected` as a regex pattern string |
| `jsonSchemaMatch(schema)` | Validates `JSON.parse(actual)` against a JSON Schema (via a lightweight validator, no new dependencies — use hand-rolled subset or `ajv` if already transitive) |
| `toolCallSequenceMatch()` | `expected` is `Array<{name, argsContains?}>`. Checks that `trace.toolExecutions` contains the named tools in order |
| `toolCallCountMatch(op, n)` | Asserts `trace.toolExecutions.length op n` where `op` is `"eq"/"lte"/"gte"` |
| `allToolCallsSucceeded()` | `passed = trace.toolExecutions.every(t => t.success)` |
| `compositeAnd(...judges)` | Runs all judges; passes only when all pass |
| `compositeOr(...judges)` | Passes when any judge passes |

No external dependencies needed for the first seven. `jsonSchemaMatch` should
validate only `type`, `required`, and `properties` to avoid pulling in `ajv`.
A comment in the code should note where to upgrade to full JSON Schema validation
if needed.

---

### Step 4 — Create `src/evaluation/runner.ts`

`EvalRunner` is the orchestrating class:

```ts
export interface EvalRunnerOptions {
  /**
   * When true, each case runs with a `MockChatModel` loaded from the case's
   * `fixturePath` (or the suite default).  Requires all cases to have
   * a `fixturePath`.  Default: false (uses the real LLM from `createLLM()`).
   */
  useMocks?: boolean;
  /** Abort the suite after this many consecutive failures. Default: no limit. */
  maxConsecutiveFailures?: number;
  /** Override the agent profile registry used during the run. */
  agentProfileRegistry?: AgentProfileRegistry;
  /** Tracer to record invocations. Defaults to a NoopTracer. */
  tracer?: Tracer;
  /** Called after each case completes. Useful for streaming live progress. */
  onCaseComplete?: (result: CaseResult) => void;
}

export class EvalRunner {
  constructor(private readonly options: EvalRunnerOptions = {}) {}

  async runSuite(suite: EvalSuite): Promise<EvalReport>;
  async runCase(suite: EvalSuite, c: EvalCase): Promise<CaseResult>;
}
```

`runCase` implementation outline:
1. Resolve the `AgentProfile` from `c.agentProfile ?? suite.agentProfile`.
2. If `useMocks`, load `MockChatModel.fromFixture(c.fixturePath)`.
3. Call `start()` / `agentExecutor` (from `src/index.ts`) with the case `input`.
4. Capture the `InvocationTrace` via the injected tracer.
5. Call `suite.judge(actual, c.expected, trace)`.
6. Assemble and return a `CaseResult`.

`runSuite` calls `runCase` for each case in order, aggregates results into an
`EvalReport`, and calls `options.onCaseComplete` after each.

---

### Step 5 — Create `src/evaluation/compare.ts`

```ts
export interface ComparisonReport {
  suiteNames: string[];
  profileA: string;
  profileB: string;
  reportA: EvalReport[];
  reportB: EvalReport[];
  /** Per-suite delta: reportB.passRate - reportA.passRate. */
  passRateDelta: Record<string, number>;
  /** Per-suite delta in mean token usage. */
  meanTokensDelta: Record<string, number>;
  /** Per-suite delta in mean estimated cost. */
  meanCostDelta: Record<string, number>;
}

/**
 * Run the same suites against two different AgentProfile configurations
 * and return a side-by-side delta report.
 */
export async function compareProfiles(
  suites: EvalSuite[],
  profileA: string,
  profileB: string,
  options?: EvalRunnerOptions,
): Promise<ComparisonReport>;
```

The comparison runner creates two `EvalRunner` instances, one per profile,
and runs them sequentially (or in parallel with `Promise.all` when mocks are
used, since there is no shared mutable state).

---

### Step 6 — Create `src/evaluation/report.ts`

Rendering helpers for terminal and JSON output:

```ts
/** Format an EvalReport as a human-readable terminal table (no colour deps). */
export function formatReport(report: EvalReport): string;

/** Format a ComparisonReport as a two-column terminal table. */
export function formatComparison(report: ComparisonReport): string;

/** Write one or more EvalReports to a JSON file (pretty-printed). */
export async function writeReports(
  reports: EvalReport[],
  outputPath: string,
): Promise<void>;
```

---

### Step 7 — Create built-in benchmark suites

**Directory:** `src/evaluation/suites/`

#### `src/evaluation/suites/tool-use.suite.ts`
Five cases covering the core tool-calling loop:
- `single-file-read`: Ask the agent to read a fixture file; judge with `substringMatch`.
- `multi-tool-chain`: Ask for file contents + a calculation; judge with `toolCallSequenceMatch`.
- `tool-blocked-graceful`: Request a tool in the blocklist; judge that the response
  acknowledges the restriction (`substringMatch`) and no tool execution succeeded
  (`allToolCallsSucceeded` is intentionally `false` → invert with a custom judge).
- `shell-execution`: Ask the agent to run `echo hello`; judge output contains `"hello"`.
- `tool-call-count-ceiling`: A task solvable in one tool call; assert
  `toolCallCountMatch("lte", 2)` to guard against runaway loops.

Each case has a corresponding fixture file at
`tests/fixtures/eval/tool-use/<case-name>.json` generated with
`RecordingChatModel` (from `src/testing/recorder.ts`).

#### `src/evaluation/suites/coding.suite.ts`
Five cases:
- `write-typescript-function`: Ask for a TypeScript function; judge with `regexMatch`.
- `fix-syntax-error`: Provide broken JS; judge the response contains a corrected snippet.
- `explain-code`: Ask what a function does; judge with `substringMatch` on key terms.
- `add-unit-test`: Ask for a Jest test; judge with `substringMatch("describe(")`.
- `diff-patch-apply`: Provide a unified diff; ask the agent to apply it; judge with
  `toolCallSequenceMatch([{name:"patch"}])`.

#### `src/evaluation/suites/reasoning.suite.ts`
Five cases:
- `arithmetic`: "What is 17 × 23?" → judge `exactMatch("391")`.
- `multi-step-math`: Two-step word problem solved with the `calculate` tool.
- `conditional-logic`: "If X, then do A, else do B" task; judge on correct branch.
- `plan-step-count`: Multi-step plan task; judge with `toolCallCountMatch("gte", 3)`.
- `self-correction`: Provide a flawed intermediate answer; judge that the final
  response corrects it.

All suites export a default `EvalSuite` object and are auto-discovered by the
benchmark runner (same glob pattern as `ToolRegistry.loadFromDirectory`).

---

### Step 8 — Create benchmark CLI entry point

**File:** `benchmarks/run-eval.ts`

```ts
#!/usr/bin/env tsx
/**
 * Evaluation benchmark runner.
 * Usage:  npx tsx benchmarks/run-eval.ts [--suite <name>] [--mock] [--threshold 0.8]
 *
 * Exits 0 when all suites meet the pass-rate threshold, 1 otherwise.
 */
```

Behaviour:
1. Parse CLI flags: `--suite` (filter by name), `--mock` (use fixture files),
   `--threshold` (min pass rate, default from `EVAL_PASS_THRESHOLD` env var).
2. Auto-discover all `*.suite.ts` files under `src/evaluation/suites/`.
3. Create an `EvalRunner` and call `runSuite` for each.
4. Print a summary table via `formatReport`.
5. Write `EVAL_REPORT_DIR/<timestamp>-eval-report.json` via `writeReports`.
6. Exit 1 if any suite's `passRate` < threshold.

---

### Step 9 — Wire up `AgentProfileRegistry` in the eval runner

The `EvalRunner` needs to activate profiles by name. Extend
`src/agents/registry.ts` (no new file) to export a `getGlobalRegistry()`
singleton that is pre-populated during `ensureInitialized()` in `src/index.ts`,
so the eval runner can access it without re-loading profile files.

---

### Step 10 — Add unit tests for the evaluation framework

**New test files under `src/__tests__/`:**

| File | What it tests |
|------|---------------|
| `evaluation-judges.test.ts` | All built-in judges with boundary inputs |
| `evaluation-runner.test.ts` | `EvalRunner` with `MockChatModel` fixtures; asserts `CaseResult` shape |
| `evaluation-report.test.ts` | `formatReport` and `writeReports` output correctness |
| `evaluation-compare.test.ts` | `compareProfiles` delta calculation |
| `evaluation-suites.test.ts` | Smoke-test each built-in suite with fixture mocks; asserts `passRate === 1` |

All tests use `MockChatModel` and do not require a real LLM key.

---

## Files to Create

```
src/evaluation/
  types.ts                          # EvalCase, EvalSuite, JudgeFn, CaseResult, EvalReport
  judges.ts                         # Built-in judge factory functions
  runner.ts                         # EvalRunner class
  compare.ts                        # compareProfiles() A/B helper
  report.ts                         # formatReport(), formatComparison(), writeReports()
  index.ts                          # Re-exports all public symbols
  suites/
    tool-use.suite.ts               # 5 tool-use eval cases
    coding.suite.ts                 # 5 coding eval cases
    reasoning.suite.ts              # 5 reasoning eval cases

benchmarks/run-eval.ts              # CLI entry point for benchmark runs

tests/fixtures/eval/
  tool-use/
    single-file-read.json           # MockChatModel fixture
    multi-tool-chain.json
    tool-blocked-graceful.json
    shell-execution.json
    tool-call-count-ceiling.json
  coding/
    write-typescript-function.json
    fix-syntax-error.json
    explain-code.json
    add-unit-test.json
    diff-patch-apply.json
  reasoning/
    arithmetic.json
    multi-step-math.json
    conditional-logic.json
    plan-step-count.json
    self-correction.json

src/__tests__/
  evaluation-judges.test.ts
  evaluation-runner.test.ts
  evaluation-report.test.ts
  evaluation-compare.test.ts
  evaluation-suites.test.ts
```

---

## Files to Modify

| File | Change |
|------|--------|
| `src/observability.ts` | Add `EvalOutcome` interface; add `outcome?: EvalOutcome` to `InvocationTrace` |
| `src/agents/registry.ts` | Export `getGlobalRegistry()` singleton accessor |
| `src/index.ts` | Populate global `AgentProfileRegistry` during `ensureInitialized()`; export `setTracer` remains unchanged |
| `src/config.ts` | Add `evalPassThreshold`, `evalReportDir`, `evalUseMocks` config keys |
| `.env.example` | Add corresponding env vars with inline comments |
| `package.json` | Add `"bench:eval": "npx tsx benchmarks/run-eval.ts"` script |
| `README.md` | Add "Evaluation & Benchmarking" section documenting the new `bench:eval` command, env vars, and suite authoring guide |

---

## Config Changes

Add to `src/config.ts` (in the `appConfig` object):

```ts
// Evaluation & Benchmarking (Issue #8)
// Minimum pass rate (0–1) below which bench:eval exits non-zero (default: 0.8 = 80%)
evalPassThreshold: parseFloat(process.env.EVAL_PASS_THRESHOLD ?? "0.8"),
// Directory where evaluation report JSON files are written (default: ./eval-reports)
evalReportDir: process.env.EVAL_REPORT_DIR ?? "./eval-reports",
// When true, bench:eval uses MockChatModel fixtures instead of a real LLM
evalUseMocks: asBoolean(process.env.EVAL_USE_MOCKS, true),
// Comma-separated list of suite names to include (empty = run all suites)
evalSuiteFilter: asStringArray(process.env.EVAL_SUITE_FILTER),
```

Add to `.env.example`:

```dotenv
# Evaluation & Benchmarking (Issue #8)
# Minimum pass rate (0.0–1.0) required for bench:eval to exit 0 (default: 0.8)
EVAL_PASS_THRESHOLD=0.8
# Directory where evaluation JSON report files are written
EVAL_REPORT_DIR=./eval-reports
# When true, the eval runner replays LLM fixture files instead of calling a real LLM
EVAL_USE_MOCKS=true
# Comma-separated list of suite names to run (empty = all suites)
EVAL_SUITE_FILTER=
```

---

## Testing Approach

### Unit tests (`npx jest`)

- **Judge correctness**: Each `judges.ts` export is tested against truthy and
  falsy inputs, including edge cases (empty string, `null` expected, malformed JSON).
- **Runner mechanics**: `EvalRunner` is constructed with `useMocks: true` and a
  hand-crafted `MockChatModel` sequence. Assert that `CaseResult.passed`,
  `.totalTokens`, and `.toolCallCount` are populated correctly.
- **Trace integration**: Verify that a `CaseResult` produced from a run via
  `FileTracer` results in a trace file whose `outcome.passed` matches the
  `CaseResult.passed` field.
- **Compare delta**: Two synthetic `EvalReport` objects with known pass rates are
  fed to `compareProfiles`; assert delta values are correct to three decimal places.

### Fixture-driven suite smoke tests (`npx jest --testPathPatterns evaluation-suites`)

- Each built-in suite is run with `EvalRunner({ useMocks: true })`.
- Assert `report.passRate === 1` (all fixture-backed cases must pass deterministically).
- Assert `report.total === 5` for each suite.
- These tests run in CI without any API keys.

### Benchmark CLI integration test (`npx jest --testPathPatterns start-oneshot`)

- Spawn `benchmarks/run-eval.ts --mock --threshold 0.0` in a child process.
- Assert exit code is `0`.
- Assert an `eval-reports/` JSON file is written and is valid JSON.

### Manual / CI regression check

```bash
# Run all suites against a real model (requires MISTRAL_API_KEY)
npm run bench:eval

# Run only the tool-use suite with mocks (no API key needed)
EVAL_SUITE_FILTER=tool-use npm run bench:eval -- --mock

# A/B compare coder vs. reviewer profile on the coding suite
EVAL_SUITE_FILTER=coding npx tsx benchmarks/run-eval.ts --profileA coder --profileB reviewer
```

---

## Acceptance Criteria

- [ ] `src/evaluation/types.ts` is merged with `EvalCase`, `EvalSuite`, `JudgeFn`,
      `CaseResult`, and `EvalReport` exported.
- [ ] `src/evaluation/judges.ts` exports all eight judge factories listed in Step 3
      with passing unit tests.
- [ ] `src/evaluation/runner.ts` exports `EvalRunner`; `runSuite` returns an
      `EvalReport` with correct `passRate`, `passCount`, and `failCount`.
- [ ] `src/evaluation/compare.ts` exports `compareProfiles` and returns a
      `ComparisonReport` with accurate delta values.
- [ ] All three built-in suites (`tool-use`, `coding`, `reasoning`) contain exactly
      five cases each, backed by fixture files, and achieve `passRate === 1` in CI.
- [ ] `npm run bench:eval -- --mock` exits `0` and writes a valid JSON report to
      `EVAL_REPORT_DIR`.
- [ ] `npm run bench:eval -- --mock --threshold 1.0` exits `0` (all fixture cases pass).
- [ ] `InvocationTrace` in `src/observability.ts` has an optional `outcome` field;
      existing tests in `src/__tests__/observability.test.ts` continue to pass without
      modification.
- [ ] `src/config.ts` and `.env.example` are updated with all four new config keys.
- [ ] `README.md` documents `bench:eval`, the new env vars, and how to author a
      custom `EvalSuite`.
- [ ] All new and modified unit tests pass under `npx jest` with zero regressions.
- [ ] TypeScript compiles without errors (`npm run build`).
