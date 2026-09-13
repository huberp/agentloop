# Human-in-the-Loop (HITL) Workflow

**Labels:** `enhancement`, `agent-ux`, `security`
**Milestone:** Phase 8 — Human Oversight

---

## Problem Statement

The current HITL capability in `agentloop` is limited to a single, binary confirmation
prompt wired into the security layer: when a tool carries `permissions: "dangerous"`,
`ToolPermissionManager.checkPermission()` in `src/security.ts` calls
`CliConfirmationHandler.confirm()`, which opens a raw readline prompt and asks
`"Allow dangerous tool … ? (y/N)"`.

This design has five concrete gaps:

| Gap | Impact |
|-----|--------|
| **Only dangerous tools trigger human contact.** Safe and cautious tools — including file writes, shell executions, and web fetches — never pause for review. | Silent data loss / unintended side-effects |
| **The agent cannot ask the user a question.** Once a task is started there is no channel for the LLM to request clarification. | Cascading errors from ambiguous intent |
| **No structured approval payload.** The approval is a bare `y/N` string; there is no way to pass corrective context ("approve but change X to Y"). | Human cannot steer mid-task |
| **No interrupt/redirect path.** Running tasks can only be killed, not redirected. | Loss of partial work |
| **`CliConfirmationHandler` is tightly coupled to `process.stdin`.** It cannot be swapped for TUI (`src/ui/tui.ts`), API, or test doubles without changing `src/security.ts`. | Hard to test; blocks non-CLI deployments |

---

## Motivation

### BMW Agents Paper Context

Industrial agent deployments (cf. the BMW Agents paper, which motivates several
`agentloop` design decisions) require _supervised autonomy_: agents must act
independently most of the time, but escalate to a human operator when they reach
decision points that exceed their confidence threshold or their authorisation scope.
Current `agentloop` has no mechanism for this escalation path.

Specific industrial failure modes the paper highlights that are not addressed today:

- Agent selects an irreversible action (e.g., `git push --force`, `file-delete`) and
  cannot pause for confirmation without a dangerous-permission override on every tool.
- Agent receives an ambiguous task description and proceeds with a wrong assumption
  instead of pausing to ask.
- Operator realises the agent is heading in the wrong direction but has no way to
  inject a course correction without killing and restarting the session.

### Validation from Related Frameworks

| Framework | Pattern | Analogue for agentloop |
|-----------|---------|------------------------|
| **LangGraph** | `interrupt()` / `Command` | Agent loop pauses at a well-defined yield point; resumes with human-provided state |
| **AutoGen** | `HumanProxyAgent` | A dedicated tool the LLM calls when it needs human input; returns the human response as a tool result |
| **OpenAI Assistants API** | `requires_action` run status | Agent loop enters a waiting state; caller resolves it asynchronously |

The AutoGen pattern fits `agentloop`'s existing tool architecture most naturally:
a tool called `ask_human` is registered in `ToolRegistry`, the LLM invokes it like any
other tool, and the response is injected back as a `ToolMessage` so the loop
continues without architectural changes to the core while loop in `executeWithTools`.

---

## Proposed Solution

Three complementary additions, each independently mergeable:

### 1. `ask_human` Tool — LLM-initiated clarification

A new built-in tool `src/tools/ask-human.ts` that exports a `toolDefinition` following
the existing `ToolDefinition` interface.  When the LLM is uncertain it calls this tool
with a `question` string; the runtime suspends, collects the human's text response via
a pluggable `HumanInputProvider`, and returns the answer as a `ToolMessage` so the loop
resumes normally.

No changes are needed to the core agent loop (`src/index.ts`): the tool call / tool
result round-trip already handles this transparently.

### 2. `HumanInputProvider` Interface — decoupled input abstraction

A new interface in `src/hitl.ts` that abstracts how human input is collected.
`CliConfirmationHandler` is refactored to implement this interface; a `TuiInputProvider`
wraps the Ink TUI; a `SilentInputProvider` is provided for tests and non-interactive
contexts.

This replaces the current readline hard-coding in `src/security.ts` and gives the TUI
(`src/ui/tui.ts`) a clean seam to inject its own input channel.

### 3. Structured Approval Hook — human-steered step approval

An optional `onHitlRequest` callback on `AgentRunOptions` (defined in `src/index.ts`)
that the agent loop invokes when any registered HITL trigger fires.  The callback
receives a typed `HitlRequest` payload (question, context, suggested action) and must
resolve with a `HitlResponse` (approve / reject / redirect with amended instruction).
A redirect response injects a new `HumanMessage` into the chat history so the agent
immediately reprioritises.

---

## Implementation Steps

### Step 1 — Define core HITL types (`src/hitl.ts`) — NEW FILE

Create `src/hitl.ts` with the following exports:

```typescript
/** The kind of HITL interaction requested by the agent. */
export type HitlRequestKind = "clarification" | "approval" | "redirect";

/**
 * Payload emitted by the agent when it needs human input.
 * Passed to the registered HumanInputProvider or onHitlRequest callback.
 */
export interface HitlRequest {
  kind: HitlRequestKind;
  /** Tool name that triggered this request, if any. */
  toolName?: string;
  /** The question or description the agent wants the human to answer. */
  question: string;
  /** Optional JSON-serialisable context the agent provides for informed decisions. */
  context?: unknown;
}

/**
 * Human response returned to the agent loop.
 * "approve"  — continue with the original plan.
 * "reject"   — abort the pending action (ToolBlockedError is injected).
 * "redirect" — inject amendedInstruction as a new HumanMessage and re-invoke the LLM.
 */
export interface HitlResponse {
  decision: "approve" | "reject" | "redirect";
  /** Free-text answer or amended instruction (required when decision is "redirect"). */
  amendedInstruction?: string;
}

/**
 * Abstraction over the human input channel.
 * Implementations: CliHumanInputProvider, TuiHumanInputProvider, SilentHumanInputProvider.
 */
export interface HumanInputProvider {
  requestInput(req: HitlRequest): Promise<HitlResponse>;
}

/**
 * Default CLI implementation.
 * Renders the question to stdout and reads a single line from stdin.
 * Interprets empty / "y" / "yes" as "approve"; "n" / "no" as "reject";
 * anything else as a redirect with the typed text as the amended instruction.
 */
export class CliHumanInputProvider implements HumanInputProvider {
  async requestInput(req: HitlRequest): Promise<HitlResponse> { /* ... readline impl ... */ }
}

/**
 * Non-blocking stub for tests and non-interactive contexts.
 * Always resolves with the configured default decision (defaults to "approve").
 */
export class SilentHumanInputProvider implements HumanInputProvider {
  constructor(private readonly defaultDecision: HitlResponse["decision"] = "approve") {}
  async requestInput(_req: HitlRequest): Promise<HitlResponse> {
    return { decision: this.defaultDecision };
  }
}
```

**Export** `HumanInputProvider`, `HitlRequest`, `HitlResponse`, `HitlRequestKind`,
`CliHumanInputProvider`, `SilentHumanInputProvider` from the module.

---

### Step 2 — Create `ask_human` built-in tool (`src/tools/ask-human.ts`) — NEW FILE

```typescript
import { z } from "zod";
import type { ToolDefinition } from "./registry";
import { getHumanInputProvider } from "../hitl";   // module-level provider singleton

export const toolDefinition: ToolDefinition = {
  name: "ask_human",
  description:
    "Ask the human operator a clarifying question when you are uncertain about the user's intent, " +
    "need to resolve ambiguity before proceeding, or require approval for a consequential action. " +
    "Returns the human's free-text answer. Use sparingly — only when genuinely stuck.",
  schema: z.object({
    question: z.string().describe("The question to present to the human operator."),
    context: z
      .string()
      .optional()
      .describe("Optional JSON-serialised context to show alongside the question."),
  }),
  permissions: "safe",       // asking a question is always safe
  execute: async ({ question, context }) => {
    const provider = getHumanInputProvider();
    const response = await provider.requestInput({
      kind: "clarification",
      question,
      context: context ? JSON.parse(context) : undefined,
    });
    if (response.decision === "reject") {
      return "Human declined to answer. Do not proceed with the uncertain action.";
    }
    if (response.decision === "redirect") {
      return `Human redirected: ${response.amendedInstruction}`;
    }
    // "approve" with optional amended instruction used as the answer
    return response.amendedInstruction ?? "Human approved. Continue.";
  },
};
```

Because `ToolRegistry.loadFromDirectory()` auto-discovers any `.ts` file that exports
`toolDefinition`, **no other file needs to be edited** to register the tool.

---

### Step 3 — Module-level provider singleton and `setHumanInputProvider()` (`src/hitl.ts`)

Add to `src/hitl.ts`:

```typescript
let _provider: HumanInputProvider = new CliHumanInputProvider();

/** Return the active HumanInputProvider (defaults to CliHumanInputProvider). */
export function getHumanInputProvider(): HumanInputProvider {
  return _provider;
}

/**
 * Replace the active HumanInputProvider.
 * Call this in tests (SilentHumanInputProvider) or from the TUI bootstrap
 * (TuiHumanInputProvider) before the first agent invocation.
 */
export function setHumanInputProvider(provider: HumanInputProvider): void {
  _provider = provider;
}
```

This mirrors the existing `setTracer()` pattern in `src/index.ts`.

---

### Step 4 — Refactor `CliConfirmationHandler` onto `HumanInputProvider` (`src/security.ts`)

- Import `HumanInputProvider`, `CliHumanInputProvider`, `SilentHumanInputProvider` from
  `./hitl`.
- Delete the inline `readline` import that is currently used only by
  `CliConfirmationHandler`.
- Rewrite `CliConfirmationHandler.confirm()` to delegate to a
  `CliHumanInputProvider` for the actual I/O, keeping the existing `ConfirmationHandler`
  interface intact so downstream callers (`ToolPermissionManager`) are unaffected:

```typescript
export class CliConfirmationHandler implements ConfirmationHandler {
  private readonly provider = new CliHumanInputProvider();

  async confirm(toolName: string, args: unknown): Promise<boolean> {
    const response = await this.provider.requestInput({
      kind: "approval",
      toolName,
      question: `Allow dangerous tool "${toolName}" with args ${JSON.stringify(args)}?`,
      context: args,
    });
    return response.decision === "approve";
  }
}
```

This eliminates duplicated readline wiring and unifies all human I/O through
`HumanInputProvider`.

---

### Step 5 — `onHitlRequest` hook on `AgentRunOptions` (`src/index.ts`)

Extend the existing `AgentRunOptions` interface:

```typescript
import type { HitlRequest, HitlResponse } from "./hitl";

export interface AgentRunOptions {
  systemPromptOverride?: string;
  /**
   * Optional callback invoked when the agent loop needs human input
   * (e.g. when the agent calls ask_human or when a structured approval is triggered).
   * When absent the module-level HumanInputProvider singleton is used.
   */
  onHitlRequest?: (req: HitlRequest) => Promise<HitlResponse>;
}
```

In `executeWithTools`, before the tool execution block, when `call.name === "ask_human"`:

- If `runOptions?.onHitlRequest` is defined, call it instead of the tool's own `execute`
  method, and inject the response directly as a `ToolMessage`.
- If `response.decision === "redirect"` and an `amendedInstruction` is provided, push a
  `HumanMessage` into `chatHistory` _before_ the `ToolMessage` so the LLM sees the
  redirected goal immediately in the next iteration.

This intercept-before-execute pattern mirrors how `permissionManager.checkPermission`
currently intercepts tool execution.

---

### Step 6 — TUI input provider (`src/ui/tui.ts`)

Create `TuiHumanInputProvider` inside `src/ui/tui.ts` (or a companion
`src/ui/tui-hitl.ts` if the file grows too large):

```typescript
export class TuiHumanInputProvider implements HumanInputProvider {
  /**
   * Suspends the Ink render loop, renders a focused HITL panel (question + input box),
   * and resolves when the user submits their response.
   */
  async requestInput(req: HitlRequest): Promise<HitlResponse> { /* Ink implementation */ }
}
```

In `runInkTui()` (already called from `src/index.ts` `main()` when
`appConfig.uiMode === "tui"`), call `setHumanInputProvider(new TuiHumanInputProvider())`
before starting the executor loop.

---

### Step 7 — Propagate HITL provider into `streamWithTools` (`src/streaming.ts`)

Add `humanInputProvider?: HumanInputProvider` to the existing `StreamingDeps` interface.
In `streamWithTools`, intercept `ask_human` calls the same way as Step 5 (check call
name, delegate to provider, inject `ToolMessage` / `HumanMessage`).

This ensures streaming mode has identical HITL behaviour to the non-streaming path.

---

### Step 8 — Config keys (`src/config.ts` + `.env.example`)

Add two new keys to `appConfig`:

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `HITL_ENABLED` | boolean | `true` | When `false`, `ask_human` tool is not loaded and HITL callbacks are never invoked. Set to `false` for fully-autonomous batch runs. |
| `HITL_TIMEOUT_MS` | number | `300000` (5 min) | Milliseconds to wait for a human response before timing out with a `HitlTimeoutError`. |

In `ensureInitialized()`, skip loading `ask-human.ts` (or unregister it immediately
after load) when `appConfig.hitlEnabled === false`.

---

### Step 9 — New error type (`src/errors.ts`)

```typescript
/** Thrown when the human does not respond within HITL_TIMEOUT_MS. */
export class HitlTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`Human-in-the-loop request timed out after ${timeoutMs}ms`);
    this.name = "HitlTimeoutError";
  }
}
```

Catch this in the `ask_human` tool's `execute` function and return a safe fallback
string (`"No human response received within timeout. Proceed cautiously."`) rather than
crashing the agent loop.

---

## Files to Modify / Create

| File | Action | Summary of changes |
|------|--------|--------------------|
| `src/hitl.ts` | **Create** | Core types (`HitlRequest`, `HitlResponse`, `HumanInputProvider`), `CliHumanInputProvider`, `SilentHumanInputProvider`, provider singleton + `getHumanInputProvider` / `setHumanInputProvider` |
| `src/tools/ask-human.ts` | **Create** | `ask_human` built-in tool; auto-discovered by `ToolRegistry.loadFromDirectory` |
| `src/errors.ts` | **Modify** | Add `HitlTimeoutError` |
| `src/security.ts` | **Modify** | Refactor `CliConfirmationHandler` to delegate I/O to `CliHumanInputProvider`; remove direct `readline` import |
| `src/index.ts` | **Modify** | Extend `AgentRunOptions` with `onHitlRequest`; add `ask_human` intercept in `executeWithTools`; respect `hitlEnabled` config in `ensureInitialized` |
| `src/streaming.ts` | **Modify** | Add `humanInputProvider?: HumanInputProvider` to `StreamingDeps`; mirror `ask_human` intercept |
| `src/ui/tui.ts` | **Modify** | Add `TuiHumanInputProvider`; call `setHumanInputProvider` in `runInkTui` |
| `src/config.ts` | **Modify** | Add `hitlEnabled` and `hitlTimeoutMs` |
| `.env.example` | **Modify** | Document `HITL_ENABLED` and `HITL_TIMEOUT_MS` |

No changes are required in `src/tools/registry.ts` — `ask-human.ts` is
auto-discovered.

---

## Config Changes

### `src/config.ts`

```typescript
// Human-in-the-Loop controls
hitlEnabled: asBoolean(process.env.HITL_ENABLED, true),
hitlTimeoutMs: parseInt(process.env.HITL_TIMEOUT_MS ?? "300000", 10),
```

### `.env.example` additions

```dotenv
# ── Human-in-the-Loop ──────────────────────────────────────────────────────
# Set to false to disable ask_human tool and all HITL callbacks (batch/CI use)
HITL_ENABLED=true
# Milliseconds to wait for a human response before the agent continues alone (default: 5 min)
HITL_TIMEOUT_MS=300000
```

---

## Testing Approach

### Unit tests (`src/__tests__/hitl.test.ts`) — NEW FILE

- `SilentHumanInputProvider` always resolves with the configured decision.
- `CliHumanInputProvider` can be tested by monkey-patching `readline.createInterface`.
- `getHumanInputProvider()` returns the default `CliHumanInputProvider` on first call.
- `setHumanInputProvider()` replaces the singleton; subsequent `getHumanInputProvider()`
  returns the new instance.
- `HitlTimeoutError` message contains the configured timeout value.

### Unit tests (`src/__tests__/ask-human.tool.test.ts`) — NEW FILE

Use `SilentHumanInputProvider` injected via `setHumanInputProvider`:

- `approve` decision → returns `"Human approved. Continue."`.
- `approve` with `amendedInstruction` → returns the instruction string.
- `reject` decision → returns the do-not-proceed message.
- `redirect` decision with instruction → returns the redirect message.
- Timeout scenario → catches `HitlTimeoutError`, returns fallback string.

### Integration tests (`src/__tests__/index.test.ts`) — MODIFY EXISTING

Following the existing pattern of using `MockChatModel.fromFixture`:

- **No HITL path** (`HITL_ENABLED=false`): verify `ask_human` tool is absent from the
  tool registry and is never called.
- **Clarification path**: fixture LLM response calls `ask_human`; inject
  `SilentHumanInputProvider` that returns `{ decision: "approve", amendedInstruction: "Use UTC timezone" }`;
  assert final response incorporates the amended instruction.
- **Redirect path**: `SilentHumanInputProvider` returns `{ decision: "redirect", amendedInstruction: "..." }`;
  assert a `HumanMessage` was added to `chatHistory` before the `ToolMessage`.
- **Reject path**: provider returns `{ decision: "reject" }`; assert agent does not
  proceed with the action and outputs a safe fallback.
- **`onHitlRequest` override**: pass `onHitlRequest` in `AgentRunOptions`; verify the
  callback is invoked instead of the provider singleton.

### Streaming tests (`src/__tests__/streaming.test.ts`) — MODIFY EXISTING

Mirror the integration test scenarios above but via `agentExecutor.stream` to confirm
`streamWithTools` has identical HITL behaviour.

### Security regression tests (`src/__tests__/security.test.ts`) — MODIFY EXISTING

- Confirm `CliConfirmationHandler.confirm()` still returns `true` for "y" input and
  `false` for "n" input after the refactor to `CliHumanInputProvider`.
- Confirm `ToolPermissionManager` behaviour is unchanged (blocklist, allowlist,
  auto-approve-all).

---

## Acceptance Criteria

- [ ] **`ask_human` is a registered built-in tool** visible in `toolRegistry.list()` when
  `HITL_ENABLED=true`.
- [ ] **LLM can call `ask_human` during an active task** and the loop suspends until the
  human responds, then continues normally with the answer injected as a `ToolMessage`.
- [ ] **`redirect` response injects a `HumanMessage`** into the chat history and the LLM
  produces a response informed by the redirected instruction in the next iteration.
- [ ] **`reject` response returns a safe fallback string** and does not throw an
  unhandled exception.
- [ ] **`HITL_ENABLED=false` disables the tool entirely** — `ask_human` is absent from
  the registry and no human I/O is attempted.
- [ ] **`HITL_TIMEOUT_MS`** causes a `HitlTimeoutError` when exceeded; the tool catches
  it and returns a safe fallback message so the agent loop does not crash.
- [ ] **`CliConfirmationHandler` behaves identically** to the current implementation
  (all existing security tests continue to pass after the refactor).
- [ ] **`SilentHumanInputProvider` is used in all tests** — no test opens stdin.
- [ ] **`onHitlRequest` callback on `AgentRunOptions`** receives a well-typed
  `HitlRequest` and its response is used instead of the singleton provider.
- [ ] **Streaming path** (`streamWithTools`) handles `ask_human` identically to the
  non-streaming path.
- [ ] **TUI path** (`uiMode=tui`) registers `TuiHumanInputProvider` before the first
  agent invocation.
- [ ] **`.env.example` is updated** with `HITL_ENABLED` and `HITL_TIMEOUT_MS`.
- [ ] **All existing tests pass** without modification (except the security test update
  in Step 4 and the integration test additions in the Testing section).

---

## Open Questions

1. **Approval granularity**: Should a future iteration allow the human to approve a
   _specific tool call_ mid-loop (not just answer a free-text question)? This would
   require surfacing the pending `ToolCall` object in `HitlRequest`.  Deferred to a
   follow-up issue.

2. **Async / API mode**: For headless deployments the `onHitlRequest` callback on
   `AgentRunOptions` already provides the hook.  A future issue could expose this over
   HTTP (long-poll or WebSocket) for web-based oversight UIs.

3. **Audit log**: Every HITL interaction should be recorded in the tracer
   (`src/observability.ts`) alongside tool execution spans.  This can be added in a
   follow-up without blocking the core implementation.
