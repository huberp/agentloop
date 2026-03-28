# Plan-Execute-Verify Loop & Dynamic Replanning

## Problem Statement

`executePlan()` in `src/orchestrator.ts` executes plan steps sequentially and handles
failures with a static strategy (`"retry"`, `"skip"`, or `"abort"`), but it never checks
whether a completed step's output is actually **correct** or **sufficient** before moving on.
`refinePlan()` in `src/subagents/planner.ts` exists but is only triggered during upfront plan
validation (unknown tools), not at runtime when a step's output might be semantically wrong or
incomplete.

Specifically, the current system has three gaps:

1. **No verification step.** After `runSubagent()` returns, the orchestrator trusts the output
   unconditionally. A step that finishes without throwing an exception is treated as a success
   even if the output is empty, hallucinated, or does not satisfy the goal.

2. **No dynamic replanning.** When a step's output is unsatisfactory, there is no mechanism to
   revise the remaining plan. The orchestrator continues with the original steps even when
   context has changed (e.g., a file was not created, an API call failed silently, a prior step
   produced unexpected output that invalidates downstream steps).

3. **No self-correction loop.** `runSubagent()` in `src/subagents/runner.ts` loops until
   `maxIterations`, but the loop only asks "did the model call more tools?" — not "is the
   result good enough?". There is no self-reflection checkpoint inside or between steps.

---

## Motivation

### BMW Agents — Plan-Execute-Verify Workflow

The BMW Agents paper introduces a three-phase agentic pattern:

- **Plan**: decompose the task into actionable steps (already implemented via `generatePlan()`).
- **Execute**: carry out each step (already implemented via `executePlan()` / `runSubagent()`).
- **Verify**: run a lightweight verification agent after each step to assert correctness before
  proceeding.

Verification agents act as runtime checkpoints that increase trust in multi-step execution.
When verification fails, the system triggers **dynamic replanning** — the remaining steps are
revised in light of the new information rather than continuing blindly.

### Reflexion (arXiv:2303.11366)

The Reflexion paper demonstrates that self-reflection over completed actions significantly
improves agent task-completion rates. An agent that evaluates its own output and explicitly
reasons about what went wrong is substantially more reliable than one that simply retries on
exception. Reflexion-style feedback — "what did I do, what was expected, what is the gap" —
maps naturally to a post-step verifier that produces structured feedback consumed by the
replanner.

### Supporting Evidence

- **Constitutional AI / self-critique**: structured critique improves output quality without
  requiring external ground truth.
- **AlphaCode**: uses verification and test-execution steps to validate generated code before
  accepting it.

---

## Proposed Solution

### Overview

Introduce a **VerificationAgent** subagent that runs after each step and produces a structured
`VerificationResult`. Wire the verifier into `executePlan()` so that:

- A passing verification advances to the next step (unchanged flow).
- A failing verification with attempts remaining triggers `refinePlan()` on the remaining steps
  and re-executes the current step with the revised context.
- A failing verification that has exhausted its retry budget falls through to the existing
  `onStepFailure` strategy.

The solution is additive: the feature is opt-in via a new `ExecutionOptions` field
(`verificationEnabled`) and a new env var (`VERIFICATION_ENABLED`). Existing behaviour is
unchanged when the feature is disabled.

### Component Diagram

```
executePlan()
  │
  ├─ for each step
  │    ├─ runStep()              ← existing
  │    ├─ verifyStep()           ← NEW: VerificationAgent
  │    │    ├─ pass  → continue
  │    │    └─ fail  → triggerReplan()   ← NEW
  │    │                 ├─ refinePlan() with verifier feedback
  │    │                 └─ re-execute current step
  │    └─ checkpoint.save()      ← existing, extended with VerificationResult
  │
  └─ ExecutionResult             ← extended with verificationResults[]
```

---

## Implementation Steps

### Step 1 — Add `VerificationResult` type to `src/subagents/types.ts`

Add a structured result type produced by the verification agent:

```typescript
/** Outcome of a single verification pass. */
export interface VerificationResult {
  /** 0-based index of the step that was verified. */
  stepIndex: number;
  /** Whether the step output satisfies the step's goal. */
  passed: boolean;
  /**
   * Human-readable explanation. On failure, this becomes the feedback
   * string passed to refinePlan().
   */
  reasoning: string;
  /**
   * Structured list of issues found. Empty on pass.
   * Used by the replanner to understand what specifically needs to change.
   */
  issues: string[];
}
```

### Step 2 — Implement `src/subagents/verifier.ts`

Create a new module that exports `verifyStep()`. The function runs a no-tool subagent whose
only job is to evaluate the output of a completed step against its declared goal.

```typescript
import { runSubagent } from "./runner";
import type { ToolRegistry } from "../tools/registry";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { PlanStep } from "./planner";
import type { VerificationResult } from "./types";

const VERIFIER_SYSTEM_PROMPT = `...` // See below

export async function verifyStep(
  step: PlanStep,
  stepIndex: number,
  output: string,
  registry: ToolRegistry,
  llm?: BaseChatModel
): Promise<VerificationResult>
```

**Verifier system prompt** (stored as a constant in `src/subagents/verifier.ts`):

```
You are a verification agent. Given a plan step and the output produced by an
execution agent, decide whether the output fully satisfies the step's goal.
Respond ONLY with a valid JSON object using this schema:
{
  "passed": boolean,
  "reasoning": "string — concise explanation",
  "issues": ["string", ...]   // empty array when passed is true
}
Rules:
- Be strict: partial output, empty output, or error messages count as failures.
- Do not re-execute any tools. Judge only on the provided output text.
- Produce a non-empty reasoning string regardless of outcome.
```

**Verifier task** built dynamically per step:

```
Step goal: <step.description>
Tools used: <step.toolsNeeded.join(", ") or "(none)">
Estimated complexity: <step.estimatedComplexity>
--- Execution output ---
<output>
--- End output ---
Does this output fully satisfy the step goal?
```

The response is parsed with the same JSON-extraction pattern used by `parsePlanFromText()`.
Malformed verifier output defaults to `{ passed: true, reasoning: "verifier parse error — assuming pass", issues: [] }`
so a broken verifier never blocks progress (fail-open).

### Step 3 — Extend `Checkpoint` and `StepResult` in `src/orchestrator.ts`

```typescript
// In StepResult — add optional verification field
export interface StepResult {
  stepIndex: number;
  description: string;
  output: string;
  status: "success" | "failed" | "skipped";
  error?: string;
  /** Present when verification was enabled for this step. */
  verification?: VerificationResult;
}

// In ExecutionResult — add aggregated verification data
export interface ExecutionResult {
  stepResults: StepResult[];
  success: boolean;
  /** All verification results in step order; empty when verification is disabled. */
  verificationResults: VerificationResult[];
}
```

Checkpoint is already shaped as `{ stepResults: StepResult[] }`, so persisting
`VerificationResult` inside `StepResult.verification` requires no interface change to
`CheckpointStore` or `Checkpoint`.

### Step 4 — Extend `ExecutionOptions` in `src/orchestrator.ts`

```typescript
export interface ExecutionOptions {
  resumeFrom?: number;
  onStepFailure?: FailureStrategy;
  checkpoint?: CheckpointStore;
  progress?: (message: string) => void;
  profileRegistry?: AgentProfileRegistry;

  // ── Verification options (new) ────────────────────────────────────────────
  /**
   * When true, a VerificationAgent runs after every successful step.
   * Reads from VERIFICATION_ENABLED env var when omitted.
   * Defaults to false.
   */
  verificationEnabled?: boolean;
  /**
   * Maximum number of replan+retry cycles allowed per step before falling
   * through to onStepFailure.
   * Reads from VERIFICATION_MAX_RETRIES env var when omitted.
   * Defaults to 1.
   */
  verificationMaxRetries?: number;
  /**
   * Optional override for the LLM used by the VerificationAgent.
   * When omitted, the orchestrator's own LLM is reused.
   */
  verifierLlm?: BaseChatModel;
}
```

### Step 5 — Implement `replanFromStep()` in `src/orchestrator.ts`

A new internal helper that calls `refinePlan()` with the verifier's structured feedback and
replaces only the remaining steps in the plan:

```typescript
/**
 * Trigger dynamic replanning for steps [failedIndex..end].
 * Returns a new Plan where the prefix steps[0..failedIndex-1] are kept
 * as-is and steps[failedIndex..] are replaced with the refined plan's steps.
 */
async function replanFromStep(
  originalPlan: Plan,
  failedStepIndex: number,
  verificationFeedback: string,
  task: string,
  workspaceInfo: WorkspaceInfo,
  registry: ToolRegistry,
  llm?: BaseChatModel
): Promise<Plan>
```

The feedback string passed to `refinePlan()` is constructed as:

```
Step ${failedStepIndex + 1} ("${step.description}") failed verification.
Verifier reasoning: ${verificationResult.reasoning}
Issues: ${verificationResult.issues.join("; ")}
Revise this step and all subsequent steps accordingly.
```

`replanFromStep()` calls the existing `refinePlan()` (from `src/subagents/planner.ts`) — no
changes to `refinePlan()` are required.

### Step 6 — Wire verification into `executePlan()` in `src/orchestrator.ts`

Modify the main step-execution loop to call `verifyStep()` after a successful step result, and
call `replanFromStep()` on verification failure:

```typescript
// Inside executePlan(), after: const result = await executeStep(...)

if (result.status === "success" && verificationEnabled) {
  let verifyAttempt = 0;
  let verification = await verifyStep(step, i, result.output, registry, verifierLlm ?? llm);
  result.verification = verification;

  while (!verification.passed && verifyAttempt < verificationMaxRetries) {
    verifyAttempt++;
    logger.warn(
      { stepIndex: i, attempt: verifyAttempt, issues: verification.issues },
      "Verification failed — replanning"
    );
    options.progress?.(`Step ${stepNumber}/${total}: verification failed, replanning…`);

    // Replan remaining steps and re-execute current step
    plan = await replanFromStep(plan, i, verification.reasoning, task, workspaceInfo, registry, llm);
    const step = plan.steps[i]; // updated step description/tools after replan

    const retryResult = await executeStep(step, i, manager, registry, llm, onStepFailure, options.profileRegistry);
    if (retryResult.status !== "success") {
      result = retryResult;
      break;
    }

    verification = await verifyStep(step, i, retryResult.output, registry, verifierLlm ?? llm);
    retryResult.verification = verification;
    result = retryResult;
  }

  if (!verification.passed) {
    logger.warn({ stepIndex: i, verificationMaxRetries }, "Verification retries exhausted");
    // Fall through to existing onStepFailure logic
  }
}
```

> **Note on `task` and `workspaceInfo` parameters:** `executePlan()` currently does not receive
> the original task string or `WorkspaceInfo`. These need to be added as optional parameters to
> `ExecutionOptions` so `replanFromStep()` can call `refinePlan()`. See Step 7.

### Step 7 — Thread `task` and `workspaceInfo` through `ExecutionOptions`

```typescript
export interface ExecutionOptions {
  // ... existing fields ...

  /**
   * Original task string; required for dynamic replanning.
   * When omitted, replanning is skipped even if verificationEnabled is true.
   */
  task?: string;
  /**
   * Workspace information; required for dynamic replanning.
   */
  workspaceInfo?: WorkspaceInfo;
}
```

`executePlan()` signature stays the same — callers already pass `ExecutionOptions` and the new
fields are optional. The orchestrator logs a warning and skips replanning (but still runs
verification) when `task` or `workspaceInfo` is absent.

### Step 8 — Add configuration to `src/config.ts`

```typescript
// Plan-Execute-Verify loop (verification agent)
verificationEnabled: asBoolean(process.env.VERIFICATION_ENABLED, false),
verificationMaxRetries: parseInt(process.env.VERIFICATION_MAX_RETRIES ?? "1", 10),
```

Read these values in `executePlan()` as the default when `ExecutionOptions` does not override
them:

```typescript
const verificationEnabled = options.verificationEnabled ?? appConfig.verificationEnabled;
const verificationMaxRetries = options.verificationMaxRetries ?? appConfig.verificationMaxRetries;
```

### Step 9 — Update `.env.example`

```dotenv
# Plan-Execute-Verify loop
# Enable VerificationAgent after each orchestrated step (default: false)
VERIFICATION_ENABLED=false
# Maximum replan+retry cycles per step before falling back to onStepFailure (default: 1)
VERIFICATION_MAX_RETRIES=1
```

---

## Files to Create

| Path | Purpose |
|---|---|
| `src/subagents/verifier.ts` | `verifyStep()` implementation and verifier system prompt |
| `src/__tests__/verifier.test.ts` | Unit tests for the verification agent |

---

## Files to Modify

| Path | Change |
|---|---|
| `src/subagents/types.ts` | Add `VerificationResult` interface |
| `src/subagents/planner.ts` | No code changes; `refinePlan()` is reused as-is |
| `src/orchestrator.ts` | Extend `StepResult`, `ExecutionResult`, `ExecutionOptions`; add `replanFromStep()`; wire verification loop into `executePlan()` |
| `src/config.ts` | Add `verificationEnabled` and `verificationMaxRetries` |
| `.env.example` | Document new env vars |
| `src/__tests__/orchestrator.test.ts` | Add verification-path test cases |
| `README.md` | Document Plan-Execute-Verify feature, new env vars, and `ExecutionOptions` fields |

---

## Configuration Changes

| Environment Variable | Type | Default | Description |
|---|---|---|---|
| `VERIFICATION_ENABLED` | boolean | `false` | Enable the VerificationAgent after each orchestrated step |
| `VERIFICATION_MAX_RETRIES` | integer | `1` | Maximum replan+retry cycles per step before falling through to `onStepFailure` |

Both variables are read through `appConfig` in `src/config.ts` and can be overridden
programmatically via `ExecutionOptions.verificationEnabled` and
`ExecutionOptions.verificationMaxRetries`.

---

## Testing Approach

### Unit tests — `src/__tests__/verifier.test.ts`

Follow the existing pattern from `src/__tests__/orchestrator.test.ts`: inject a mock LLM via
`makeMockLlm()` to control verifier responses without real API calls.

1. **Pass case**: mock LLM returns `{ passed: true, reasoning: "output is complete", issues: [] }`
   → `verifyStep()` returns `VerificationResult` with `passed: true`.

2. **Fail case**: mock LLM returns `{ passed: false, reasoning: "file not created", issues: ["expected foo.ts to exist"] }`
   → `verifyStep()` returns `VerificationResult` with `passed: false` and non-empty `issues`.

3. **Malformed verifier output**: mock LLM returns plain text (not JSON)
   → `verifyStep()` returns a default pass result (fail-open behaviour).

4. **Empty step output**: `output = ""`
   → Verifier receives empty output string; verified against step goal normally.

### Unit tests — `src/__tests__/orchestrator.test.ts` (additions)

5. **Verification pass — no replan**: single-step plan, verifier passes → `stepResults[0].verification.passed === true`, `plan` unchanged.

6. **Verification fail + replan + retry succeeds**: mock verifier fails on first call, `refinePlan` mock returns a revised plan, retry succeeds, verifier passes on second call → `stepResults[0].status === "success"`, `stepResults[0].verification.passed === true`, plan was updated.

7. **Verification fail + retries exhausted → `onStepFailure` applied**: verifier fails for all retry attempts → step status follows `onStepFailure` setting (`"failed"` for `"abort"`, `"skipped"` for `"skip"`).

8. **`verificationEnabled: false` — verifier never called**: mock `verifyStep` is never invoked when the option is false.

9. **Missing `task`/`workspaceInfo` in options**: verification runs, but when verifier fails the orchestrator logs a warning and skips replanning instead of throwing.

10. **`verificationResults` in `ExecutionResult`**: after a 3-step plan with verification enabled, `executionResult.verificationResults` contains 3 entries in step order.

### Integration / E2E guidance

The existing E2E tests in `tests/e2e/` run against a real LLM. Add one E2E scenario
(gated by `VERIFICATION_ENABLED=true` in the test environment) that verifies end-to-end that:
- A step that produces clearly wrong output (detectable by the verifier) triggers a replan.
- The final `ExecutionResult.success` is `true` after a successful replan.

---

## Acceptance Criteria

- [ ] `src/subagents/verifier.ts` exports `verifyStep(step, stepIndex, output, registry, llm?): Promise<VerificationResult>`.
- [ ] `VerificationResult` is exported from `src/subagents/types.ts` and includes `stepIndex`, `passed`, `reasoning`, and `issues`.
- [ ] `StepResult.verification?: VerificationResult` is present when verification is enabled.
- [ ] `ExecutionResult.verificationResults: VerificationResult[]` is always present (empty array when disabled).
- [ ] `ExecutionOptions` accepts `verificationEnabled`, `verificationMaxRetries`, `verifierLlm`, `task`, and `workspaceInfo`.
- [ ] When `verificationEnabled` is `false` (the default), `executePlan()` behaviour is byte-for-byte identical to the pre-change implementation.
- [ ] When verification fails and `task`+`workspaceInfo` are provided, `refinePlan()` is called with the verifier's `reasoning` as feedback and the plan's remaining steps are replaced.
- [ ] When verification retries are exhausted, the existing `onStepFailure` strategy is applied unchanged.
- [ ] A malformed verifier response (non-JSON, missing fields) never throws; the verifier fails open (`passed: true`).
- [ ] `VERIFICATION_ENABLED` and `VERIFICATION_MAX_RETRIES` env vars are documented in `.env.example` and read through `appConfig`.
- [ ] All new code paths have unit test coverage in `src/__tests__/verifier.test.ts` and `src/__tests__/orchestrator.test.ts`.
- [ ] `npx jest` passes with no regressions.
- [ ] `README.md` documents the feature, the new env vars, and the new `ExecutionOptions` fields.

---

## References

- BMW Agents paper — Plan-Execute-Verify multi-agent workflow
- Reflexion: Language Agents with Verbal Reinforcement Learning (arXiv:2303.11366)
- Constitutional AI (Anthropic, 2022) — self-critique and revision
- AlphaCode — verification steps for code correctness
- `src/orchestrator.ts` — `executePlan()`, `StepResult`, `ExecutionResult`, `CheckpointStore`
- `src/subagents/planner.ts` — `generatePlan()`, `refinePlan()`, `Plan`, `PlanStep`
- `src/subagents/runner.ts` — `runSubagent()`
- `src/subagents/types.ts` — `SubagentDefinition`, `SubagentResult`
- `src/errors.ts` — `ToolBlockedError`, `MaxIterationsError`
- `src/config.ts` — `appConfig`
