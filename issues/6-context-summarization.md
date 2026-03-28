# Context Summarization & Intelligent Context Management

**Issue type:** Enhancement  
**Affected files:** `src/context.ts`, `src/config.ts`, `.env.example`, new `src/memory/summarizer.ts`  
**Related:** BMW Agents working-memory model, LangChain `ConversationSummaryBufferMemory`, MemGPT hierarchical memory

---

## 1. Problem Statement

`src/context.ts` implements a single context-management strategy: **destructive oldest-first trimming**.

```
trimMessages()
  ├── always keep messages[0]  (system prompt)
  ├── always keep messages[-1] (most-recent user turn)
  └── drop oldest middle messages one-by-one until total ≤ MAX_CONTEXT_TOKENS
```

This has two concrete failure modes in long-running sessions:

1. **Silent information loss.** Tool results, user constraints, and decisions from early in a conversation are permanently deleted. The agent has no record they ever existed.
2. **No graceful degradation.** The moment the window fills, the entire oldest message is evicted at once. There is no intermediate step that compresses rather than destroys.

The `trimMessages()` function is called in `src/index.ts` before every LLM invocation. It returns a new array; the `InMemoryChatMessageHistory` history object is unaware of the trim and continues to grow unboundedly. The two objects drift apart over time — history grows, but the LLM sees a shrinking, increasingly amnesiac window.

---

## 2. Motivation

### 2a. BMW Agents working-memory model
The BMW Agents paper defines *working memory* as the short-term context an agent maintains for the current task. It explicitly identifies three failure modes that map directly onto agentloop's current behavior:
- Forgetting prior tool results when context overflows
- Losing task constraints established at conversation start
- Being unable to complete long-horizon tasks because early planning context is evicted

### 2b. Validated industry approaches
| Approach | Source | Key idea |
|---|---|---|
| `ConversationSummaryBufferMemory` | LangChain | Maintain a rolling LLM-generated summary of old turns; keep recent turns verbatim |
| Context summarization | Anthropic Claude | Prompt the same LLM to compress its own context before window exhaustion |
| Hierarchical memory (MemGPT/Letta) | Park et al. | Hot (verbatim) + warm (summary) + cold (retrieval) tiers |

This issue implements the **rolling summary** tier from LangChain and Claude's approach: the simplest tier that yields the highest benefit with minimal architectural change.

---

## 3. Proposed Solution

### High-level architecture

```
┌──────────────────────────────────────────────────────────────┐
│  executeWithTools()  (src/index.ts)                          │
│                                                              │
│  history.getMessages()                                       │
│       │                                                      │
│       ▼                                                      │
│  prepareContext(messages, llm, config)  ◄── new helper       │
│       │                                                      │
│       ├─ if total tokens ≤ SUMMARIZE_THRESHOLD → return as-is│
│       │                                                      │
│       ├─ else → summarizeOldMessages(middle, llm)            │
│       │         └─ returns a single SummaryMessage           │
│       │                                                      │
│       └─ [system, SummaryMessage, ...recent, lastUser]       │
│                           │                                  │
│                           ▼                                  │
│  trimMessages() (existing — safety net only)                 │
│                           │                                  │
│                           ▼                                  │
│  llm.invoke()                                                │
└──────────────────────────────────────────────────────────────┘
```

### Rolling summary strategy

When `countTokens(messages) > SUMMARIZE_THRESHOLD`:

1. Split messages into three groups:
   - `[0]` — system prompt (always verbatim)
   - `[1 … -RECENT_MESSAGES_KEEP]` — *compressible window* (candidates for summarization)
   - `[-RECENT_MESSAGES_KEEP … -1]` + `[-1]` — *recent verbatim window* + last user message (always verbatim)
2. Invoke the LLM with a dedicated summarization prompt over the compressible window.
3. Replace the compressible window with a single `SystemMessage` (or `AIMessage`) tagged with a sentinel prefix so it is recognisable in traces and tests.
4. Prepend the summary to the recent verbatim window.
5. Pass the resulting condensed list to the existing `trimMessages()` as a final safety net.

The summary is **not persisted to `InMemoryChatMessageHistory`** — it is computed on each call where the threshold is crossed. This keeps the history pristine for potential future retrieval-based approaches while giving the LLM a useful condensed view immediately.

---

## 4. Implementation Steps

### Step 1 — New file: `src/memory/summarizer.ts`

Create the directory `src/memory/` and implement `summarizeMessages()`:

```typescript
// src/memory/summarizer.ts

import { BaseMessage, SystemMessage } from "@langchain/core/messages";
import type { Runnable } from "@langchain/core/runnables";
import type { BaseLanguageModelInput } from "@langchain/core/language_models/base";
import type { AIMessageChunk } from "@langchain/core/messages";
import { logger } from "../logger";

export const SUMMARY_SENTINEL = "[CONTEXT SUMMARY]";

/**
 * Summarize a slice of message history using the provided LLM.
 *
 * Returns a single SystemMessage whose content begins with SUMMARY_SENTINEL
 * followed by a compressed representation of the original messages.
 */
export async function summarizeMessages(
  messages: BaseMessage[],
  llm: Runnable<BaseLanguageModelInput, AIMessageChunk>
): Promise<SystemMessage> { ... }
```

The summarization prompt should:
- Instruct the LLM to produce a dense factual summary (not a conversation retelling)
- Preserve: tool names and their outputs, user decisions, key facts established, any constraints or goals
- Omit: pleasantries, repeated content, step-by-step narration
- Mark the output clearly with the sentinel so downstream code and tests can identify it

### Step 2 — New export from `src/context.ts`: `prepareContext()`

Add `prepareContext()` alongside (not replacing) `trimMessages()`:

```typescript
// src/context.ts additions

export interface ContextManagerOptions {
  maxTokens: number;              // existing MAX_CONTEXT_TOKENS
  summarizeThreshold: number;     // new: trigger summarization at this token count
  recentMessagesKeep: number;     // new: verbatim recent turns to always preserve
  summarizationEnabled: boolean;  // new: feature flag
}

/**
 * Prepare a context window for an LLM call.
 *
 * If summarization is enabled and total tokens exceed summarizeThreshold,
 * the compressible (older) portion of the middle messages is replaced with
 * an LLM-generated summary before falling through to trimMessages().
 *
 * When summarization is disabled or the threshold is not reached, this
 * function is a transparent pass-through to trimMessages().
 */
export async function prepareContext(
  messages: BaseMessage[],
  llm: Runnable<BaseLanguageModelInput, AIMessageChunk> | null,
  options: ContextManagerOptions
): Promise<BaseMessage[]> { ... }
```

`trimMessages()` is kept unchanged — it remains the hard safety-net trim. `prepareContext()` calls it at the end.

### Step 3 — Wire into `src/index.ts`

In the `executeWithTools()` agent loop, replace the synchronous `trimMessages()` call with `await prepareContext()`:

```typescript
// Before (src/index.ts, inside executeWithTools)
const contextMessages = trimMessages(msgs, appConfig.maxContextTokens);

// After
const contextMessages = await prepareContext(msgs, _llmWithTools, {
  maxTokens: runtimeConfig.maxContextTokens ?? appConfig.maxContextTokens,
  summarizeThreshold: appConfig.summarizeThreshold,
  recentMessagesKeep: appConfig.recentMessagesKeep,
  summarizationEnabled: appConfig.summarizationEnabled,
});
```

The LLM reference (`_llmWithTools`) is already available in the same scope and is safe to pass; the summarizer uses it as a stateless one-shot call, not as part of the agent loop.

### Step 4 — Config keys in `src/config.ts`

Add to `appConfig`:

```typescript
// Context summarization (Issue #6)
// Enable LLM-based rolling summarization instead of hard-drop trimming
summarizationEnabled: asBoolean(process.env.SUMMARIZATION_ENABLED, false),
// Token count that triggers summarization (must be < MAX_CONTEXT_TOKENS)
summarizeThreshold: parseInt(process.env.SUMMARIZE_THRESHOLD ?? "20000", 10),
// Number of most-recent messages always kept verbatim (never summarized)
recentMessagesKeep: parseInt(process.env.RECENT_MESSAGES_KEEP ?? "6", 10),
```

`SUMMARIZATION_ENABLED` defaults to `false` to preserve existing behavior for all current users. Operators opt in explicitly.

### Step 5 — `.env.example` additions

```dotenv
# Context Summarization (Issue #6)
# Set to true to enable LLM-based rolling summarization before hard trimming
SUMMARIZATION_ENABLED=false
# Token threshold at which summarization is triggered (must be less than MAX_CONTEXT_TOKENS)
SUMMARIZE_THRESHOLD=20000
# Number of most-recent messages to keep verbatim when summarizing (not compressed)
RECENT_MESSAGES_KEEP=6
```

---

## 5. Files to Modify / Create

| File | Action | Description |
|---|---|---|
| `src/memory/summarizer.ts` | **Create** | `summarizeMessages()`, `SUMMARY_SENTINEL`, summarization prompt |
| `src/context.ts` | **Modify** | Add `prepareContext()`, `ContextManagerOptions` interface; keep `trimMessages()` unchanged |
| `src/index.ts` | **Modify** | Replace `trimMessages()` call with `await prepareContext()` |
| `src/config.ts` | **Modify** | Add `summarizationEnabled`, `summarizeThreshold`, `recentMessagesKeep` |
| `.env.example` | **Modify** | Document the three new keys |
| `src/__tests__/context.test.ts` | **Modify** | Add `prepareContext()` test cases (see §7) |
| `src/__tests__/summarizer.test.ts` | **Create** | Unit tests for `summarizeMessages()` (see §7) |

---

## 6. Config Changes Summary

| Key | Default | Description |
|---|---|---|
| `SUMMARIZATION_ENABLED` | `false` | Master feature flag. `false` = existing hard-drop behavior. |
| `SUMMARIZE_THRESHOLD` | `20000` | Token count that triggers a summarization pass. Must be ≤ `MAX_CONTEXT_TOKENS - response_headroom`. |
| `RECENT_MESSAGES_KEEP` | `6` | How many of the most-recent middle messages are always kept verbatim and never compressed. |

**Invariants to enforce at startup:**
- `SUMMARIZE_THRESHOLD` must be strictly less than `MAX_CONTEXT_TOKENS`; log a warning and clamp to `MAX_CONTEXT_TOKENS * 0.75` if violated.
- `RECENT_MESSAGES_KEEP` must be ≥ 1; clamp to 1 if zero or negative.

---

## 7. Testing Approach

### 7a. Unit tests for `summarizeMessages()` — `src/__tests__/summarizer.test.ts`

Use the existing `MockChatModel` pattern from `src/testing/` to avoid live LLM calls:

```
describe("summarizeMessages")
  ✓ returns a SystemMessage starting with SUMMARY_SENTINEL
  ✓ result token count is less than total token count of input messages
  ✓ does not throw on an empty message array (returns empty summary)
  ✓ calls the LLM exactly once regardless of input length
  ✓ propagates LLM errors as SummarizationError
```

### 7b. Unit tests for `prepareContext()` — additions to `src/__tests__/context.test.ts`

```
describe("prepareContext")
  ✓ acts as a pass-through when summarization is disabled (returns trimMessages result)
  ✓ acts as a pass-through when token count ≤ summarizeThreshold
  ✓ calls summarizeMessages() when token count > summarizeThreshold
  ✓ result always contains system prompt at index 0
  ✓ result always contains last user message at last index
  ✓ result contains exactly one SUMMARY_SENTINEL message when summarization fires
  ✓ result token count ≤ maxTokens after summarization + trim
  ✓ verbatim recent messages (last RECENT_MESSAGES_KEEP) appear after the summary
  ✓ original history array is not mutated
  ✓ falls back to trimMessages() when llm is null (graceful degradation)
```

### 7c. Integration smoke test

Add one test to `src/__tests__/index.test.ts` that verifies `executeWithTools()` does not throw when `SUMMARIZATION_ENABLED=true` and the mock history is large enough to cross the threshold. Use `MockChatModel` with a fixture response for the summarization call.

### 7d. Baseline preservation

All existing `context.test.ts` tests must continue to pass without modification — `trimMessages()` is not changed.

---

## 8. Acceptance Criteria

- [ ] `SUMMARIZATION_ENABLED=false` (default): behavior is **byte-for-byte identical** to the current `trimMessages()` implementation — all existing `context.test.ts` tests pass unmodified.
- [ ] `SUMMARIZATION_ENABLED=true`: when `countTokens(messages) > SUMMARIZE_THRESHOLD`, `prepareContext()` produces a context window where:
  - `messages[0]` is the original system prompt (unchanged)
  - exactly one message in the result contains `SUMMARY_SENTINEL`
  - the last `RECENT_MESSAGES_KEEP` middle messages appear verbatim after the summary
  - `messages[-1]` is the original last user message (unchanged)
  - `countTokens(result) ≤ MAX_CONTEXT_TOKENS`
- [ ] `SUMMARIZATION_ENABLED=true` but LLM call fails: `prepareContext()` catches the error, logs a `warn`-level structured log entry, and falls back to `trimMessages()` — no exception propagates to the agent loop.
- [ ] `SUMMARIZATION_ENABLED=true` but `llm` is `null`: same graceful fallback as above.
- [ ] The three new config keys appear in `.env.example` with explanatory comments.
- [ ] `npx jest` passes with no regressions.
- [ ] No `eval` or dynamic code execution in `src/memory/summarizer.ts`.
- [ ] Summarization LLM calls are logged at `debug` level with structured fields (`tool: "summarizer"`, `inputMessages`, `outputTokens`) consistent with the logging guidelines in `src/logger.ts`.

---

## 9. Out of Scope (Future Issues)

- **Persistence of summaries** across process restarts (requires a `CheckpointStore` integration).
- **Retrieval-augmented context** (MemGPT cold-tier): storing evicted messages in a vector store and retrieving on semantic similarity.
- **Per-agent-profile summarization config**: agent profiles in `src/agents/builtin/` could override `summarizeThreshold` and `recentMessagesKeep` — straightforward extension once the base feature is in place.
- **Token-accurate summarization headroom**: currently the system prompt token budget is not subtracted from `SUMMARIZE_THRESHOLD`; a future pass should account for it.
