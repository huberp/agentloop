
# Persistent Memory & State Management

## Problem Statement

`agentloop` is entirely **stateless between invocations**. Every call to `agentExecutor.invoke()` starts from a clean slate:

- `chatHistory` in `src/index.ts` (line 131) is a module-level `InMemoryChatMessageHistory` that **accumulates messages only for the lifetime of the process**. If the process restarts, or a second CLI session begins, all conversation history is lost.
- `runSubagent()` in `src/subagents/runner.ts` (line 64) constructs a brand-new `InMemoryChatMessageHistory` for every subagent call. Subagents have zero memory of prior runs.
- `InMemoryCheckpointStore` in `src/orchestrator.ts` (line 53) persists plan checkpoints only in RAM; they evaporate with the process.
- There is no concept of a `sessionId` or `threadId` anywhere in the codebase — no mechanism to distinguish or resume separate conversations.
- `trimMessages()` in `src/context.ts` silently drops the oldest middle messages when the context window fills; the dropped content is gone permanently with no archival.

This means users cannot resume tasks after interruption, agents cannot learn from prior interactions, and long-running workflows lose continuity.

---

## Motivation

### BMW Agents Paper

The *BMW Agents* paper identifies three memory tiers essential for capable agents:

| Tier | Scope | Currently in agentloop |
|---|---|---|
| **Short-term (in-context)** | Current task window | ✅ `InMemoryChatMessageHistory` |
| **Episodic (cross-task)** | Prior runs, experiences | ❌ Missing |
| **Semantic (knowledge base)** | Facts, embeddings | ❌ Out of scope for this issue |

Episodic memory enables **cumulative learning**: an agent working on a multi-session refactor can recall what files it changed yesterday, what errors it encountered, and what solutions worked. Without it, every session wastes time re-discovering context.

### Real-World Use Cases

- **Interrupted tasks**: A user starts a large refactor, closes the terminal, and resumes the next day. Today the agent must remember which files are done.
- **Iterative development**: An agent pair-programming over multiple sessions must remember what it already explained, what the user rejected, and what conventions were agreed upon.
- **Subagent pipelines**: The orchestrator runs a subagent plan; if step 4 of 10 fails, the next run should not repeat steps 1–3.
- **Cross-session coaching**: A coding agent that remembers "this user prefers functional style" can avoid repeating rejected suggestions.

### Validated by the Ecosystem

- **AutoGen**: supports `ConversationHistory` with persistent backends.
- **mem0**: dedicated memory layer for AI agents (Redis, SQLite, Postgres, vector stores).
- **LangChain**: `RedisChatMessageHistory`, `PostgresChatMessageHistory`, `FileChatMessageHistory` all share the same `BaseChatMessageHistory` interface that `InMemoryChatMessageHistory` already implements — a drop-in substitution path exists.

---

## Proposed Design

### Three-Layer Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    agentExecutor.invoke()                │
│                                                         │
│  ┌─────────────────────┐   ┌───────────────────────┐   │
│  │  Session Memory      │   │  Episodic Memory       │   │
│  │  (per conversation)  │   │  (cross-session log)   │   │
│  │                     │   │                        │   │
│  │  BaseChatMessage     │   │  EpisodicStore         │   │
│  │  History (pluggable) │   │  (JSONL / SQLite)      │   │
│  └─────────────────────┘   └───────────────────────┘   │
│                                                         │
│  ┌──────────────────────────────────────────────────┐   │
│  │  Orchestrator CheckpointStore (pluggable)         │   │
│  │  FileCheckpointStore / RedisCheckpointStore       │   │
│  └──────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

### Layer 1 — Session Memory (pluggable `BaseChatMessageHistory`)

Replace the hardcoded `new InMemoryChatMessageHistory()` in `src/index.ts` with a factory that produces a backend-appropriate history object keyed by `sessionId`. The public `BaseChatMessageHistory` interface that `InMemoryChatMessageHistory` already satisfies is the integration point — no changes to the agent loop itself.

**Backends (v1):**
- `InMemoryChatMessageHistory` — current default, unchanged behaviour.
- `FileChatMessageHistory` — JSONL file per `sessionId`, zero new dependencies.
- `RedisChatMessageHistory` — optional, requires `@langchain/redis` peer dep.

### Layer 2 — Episodic Memory (cross-session log)

A lightweight append-only store of **episode records**: structured summaries written at the end of each invocation. Episodes are injected as a read-only context block in the system prompt (similar to how `sharedContext` is injected in `src/subagents/runner.ts` lines 14–21).

Each episode record:
```ts
interface EpisodeRecord {
  sessionId: string;
  timestamp: string;        // ISO-8601
  summary: string;          // LLM-generated or last AI message
  filesModified: string[];  // from tool call tracking
  toolsUsed: string[];
  iterationCount: number;
  outcome: "success" | "interrupted" | "error";
}
```

**Backends (v1):** JSONL file (default, zero deps). Interface-driven for future vector store extension.

### Layer 3 — Persistent Orchestrator Checkpoints

A `FileCheckpointStore` implementation of the existing `CheckpointStore` interface (`src/orchestrator.ts` lines 47–52). Persists plan step results to a JSON file so `executePlan()` can resume after process death via the existing `resumeFrom` option.

---

## Implementation Steps

### Step 1 — Introduce `sessionId` and memory configuration in `src/config.ts`

Add the following to `appConfig`:

```ts
// Memory & session persistence
memoryBackend: (process.env.MEMORY_BACKEND ?? "none") as "none" | "file" | "redis",
memorySessionId: process.env.MEMORY_SESSION_ID ?? "",
memoryDir: process.env.MEMORY_DIR ?? ".agentloop/sessions",
episodicMemoryEnabled: asBoolean(process.env.EPISODIC_MEMORY_ENABLED, false),
episodicMemoryFile: process.env.EPISODIC_MEMORY_FILE ?? ".agentloop/episodes.jsonl",
episodicMemoryMaxEntries: parseInt(process.env.EPISODIC_MEMORY_MAX_ENTRIES ?? "50", 10),
redisUrl: process.env.REDIS_URL ?? "",
```

`MEMORY_SESSION_ID` defaults to `""`, which causes the memory layer to auto-generate a UUID per process startup (same semantics as today, but now trackable).

### Step 2 — Create `src/memory/` module

**New files:**

#### `src/memory/types.ts`
```ts
export interface EpisodeRecord {
  sessionId: string;
  timestamp: string;
  summary: string;
  filesModified: string[];
  toolsUsed: string[];
  iterationCount: number;
  outcome: "success" | "interrupted" | "error";
}

export interface EpisodicStore {
  append(episode: EpisodeRecord): Promise<void>;
  loadRecent(limit: number): Promise<EpisodeRecord[]>;
  clear(): Promise<void>;
}
```

#### `src/memory/session.ts`
Factory function that returns the correct `BaseChatMessageHistory` based on `appConfig.memoryBackend`:

```ts
import { InMemoryChatMessageHistory } from "@langchain/core/chat_history";
import type { BaseChatMessageHistory } from "@langchain/core/chat_history";
import { appConfig } from "../config";
import { FileChatMessageHistory } from "./file-history";

export function createChatHistory(sessionId: string): BaseChatMessageHistory {
  switch (appConfig.memoryBackend) {
    case "file":
      return new FileChatMessageHistory(sessionId, appConfig.memoryDir);
    case "redis":
      // Dynamically required to avoid hard dep when Redis is not configured.
      // Wrap in try/catch to surface a clear error if @langchain/redis is not installed.
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { RedisChatMessageHistory } = require("@langchain/redis");
        if (!appConfig.redisUrl) {
          throw new Error("MEMORY_BACKEND=redis requires REDIS_URL to be set");
        }
        return new RedisChatMessageHistory({ sessionId, url: appConfig.redisUrl });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("Cannot find module")) {
          throw new Error(
            "MEMORY_BACKEND=redis requires @langchain/redis to be installed: " +
            "run `npm install @langchain/redis`"
          );
        }
        throw err;
      }
    default:
      return new InMemoryChatMessageHistory();
  }
}
```

#### `src/memory/file-history.ts`
Implements `BaseChatMessageHistory` by serialising/deserialising messages to a JSONL file at `<memoryDir>/<sessionId>.jsonl`. Uses `@langchain/core`'s `mapChatMessagesToStoredMessages` / `mapStoredMessagesToChatMessages` for portable serialisation (no extra deps).

Key methods:
- `getMessages()` — reads and deserialises the JSONL file; returns `[]` on ENOENT.
- `addMessage(message)` — appends one serialised message to the file.
- `addMessages(messages)` — batches multiple appends in a single `fs.appendFile` call.
- `clear()` — deletes the file.

#### `src/memory/episodic.ts`
`FileEpisodicStore` implementing `EpisodicStore`:
- `append(episode)` — appends one JSON line to `appConfig.episodicMemoryFile`; creates the directory if absent.
- `loadRecent(limit)` — reads the last `limit` lines from the file (tail-read to avoid loading the full history).
- `clear()` — truncates the file.

#### `src/memory/index.ts`
Re-exports `createChatHistory`, `EpisodicStore`, `EpisodeRecord`, `FileEpisodicStore`, and a singleton `episodicStore` (created lazily from config).

### Step 3 — Refactor `src/index.ts` to use pluggable session history

**Current (line 131):**
```ts
const chatHistory = new InMemoryChatMessageHistory();
```

**Change to:**
```ts
import { createChatHistory } from "./memory/session";
import { resolveSessionId } from "./memory/session";

// Resolved once at module load; stable for the lifetime of the process
const _sessionId = resolveSessionId(appConfig.memorySessionId);
const chatHistory = createChatHistory(_sessionId);
```

`resolveSessionId()` returns `appConfig.memorySessionId` when set, or generates and caches a UUID (using `crypto.randomUUID()` from Node's built-in `crypto` module — no extra dep).

Export `_sessionId` as `currentSessionId` for use in episodic writes and tests:
```ts
export function getCurrentSessionId(): string { return _sessionId; }
```

No other changes to the agent loop body in `src/index.ts` — the `BaseChatMessageHistory` interface is identical.

### Step 4 — Add episodic memory injection in the system prompt path

In `src/index.ts` inside `executeWithTools()`, after `getSystemPrompt()` is called, append an episodic memory block when `appConfig.episodicMemoryEnabled` is true:

```ts
// Episodic memory: inject recent episode summaries as read-only context
if (appConfig.episodicMemoryEnabled) {
  const recentEpisodes = await episodicStore.loadRecent(appConfig.episodicMemoryMaxEntries);
  if (recentEpisodes.length > 0) {
    systemMessageText += formatEpisodicContext(recentEpisodes);
  }
}
```

`formatEpisodicContext()` lives in `src/memory/episodic.ts` and renders the episodes as a fenced markdown block (similar to `formatSharedContext()` in `src/subagents/runner.ts` lines 14–21).

After the loop exits (agent returns final response), write an episode record:

```ts
if (appConfig.episodicMemoryEnabled) {
  await episodicStore.append({
    sessionId: _sessionId,
    timestamp: new Date().toISOString(),
    summary: finalResponse,   // last AI message text
    filesModified: [...],     // collected from tool calls (same pattern as runSubagent)
    toolsUsed: [...],
    iterationCount: iteration,
    outcome: "success",
  });
}
```

Track `filesModified` and `toolsUsed` arrays alongside `iteration` in the loop body (mirroring the tracking already done in `src/subagents/runner.ts` lines 103–108).

### Step 5 — Refactor `src/subagents/runner.ts` to support session-scoped history

`runSubagent()` currently creates `new InMemoryChatMessageHistory()` unconditionally (line 64). Subagents are intentionally isolated, so the default stays `InMemory`, but add an optional `chatHistory` parameter to `SubagentDefinition` (in `src/subagents/types.ts`) to allow callers to inject a persistent history when needed:

```ts
// src/subagents/types.ts
import type { BaseChatMessageHistory } from "@langchain/core/chat_history";

export interface SubagentDefinition {
  // ... existing fields ...
  /** Optional pre-populated chat history. Defaults to a fresh InMemoryChatMessageHistory. */
  chatHistory?: BaseChatMessageHistory;
}
```

In `src/subagents/runner.ts`:
```ts
const chatHistory = definition.chatHistory ?? new InMemoryChatMessageHistory();
```

This is a purely additive, backward-compatible change.

### Step 6 — Create `FileCheckpointStore` in `src/orchestrator.ts`

Add a new exported class alongside the existing `InMemoryCheckpointStore`:

```ts
export class FileCheckpointStore implements CheckpointStore {
  constructor(private readonly filePath: string) {}

  async save(checkpoint: Checkpoint): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(checkpoint, null, 2), "utf-8");
  }

  async load(): Promise<Checkpoint | null> {
    try {
      const raw = await fs.readFile(this.filePath, "utf-8");
      return JSON.parse(raw) as Checkpoint;
    } catch {
      return null;
    }
  }
}
```

Add config key `checkpointDir` to `src/config.ts`:
```ts
checkpointDir: process.env.CHECKPOINT_DIR ?? ".agentloop/checkpoints",
```

The `executePlan()` caller (in `src/agents/coordinator.ts` or the CLI) can opt in by passing a `FileCheckpointStore` instance. No change to existing `executePlan()` signature.

### Step 7 — Update `trimMessages()` in `src/context.ts` to archive dropped messages

Currently, dropped messages are silently discarded. When session persistence is active, dropped messages should be written to the episodic store as an "archived" episode before being removed:

```ts
export async function trimMessagesWithArchive(
  messages: BaseMessage[],
  maxTokens: number,
  onDropped?: (dropped: BaseMessage[]) => Promise<void>
): Promise<BaseMessage[]> {
  // existing trim logic...
  const dropped = middle.slice(0, i);
  if (dropped.length > 0 && onDropped) {
    await onDropped(dropped);
  }
  return [first, ...middle.slice(i), last];
}
```

The callback in `src/index.ts` serialises dropped messages to the episodic log so no context is permanently lost.

### Step 8 — Update `.env.example`

Add a new section to `.env.example`:

```dotenv
# ─────────────────────────────────────────────
# Persistent Memory & Session State
# ─────────────────────────────────────────────

# Session history backend: "none" (in-memory, default), "file", or "redis"
MEMORY_BACKEND=none

# Stable session identifier — reuse across restarts to resume a conversation.
# Leave blank to auto-generate a UUID per process startup.
MEMORY_SESSION_ID=

# Directory where per-session JSONL history files are stored (MEMORY_BACKEND=file)
MEMORY_DIR=.agentloop/sessions

# Redis connection URL (MEMORY_BACKEND=redis), e.g. redis://localhost:6379
REDIS_URL=

# Episodic (cross-session) memory
# When true, episode summaries from past runs are injected into the system prompt
EPISODIC_MEMORY_ENABLED=false
# JSONL file where episode records are appended
EPISODIC_MEMORY_FILE=.agentloop/episodes.jsonl
# Maximum number of recent episodes injected into the context window
EPISODIC_MEMORY_MAX_ENTRIES=50

# Persistent orchestrator checkpoints
# Directory where plan checkpoint JSON files are written (for FileCheckpointStore)
CHECKPOINT_DIR=.agentloop/checkpoints
```

### Step 9 — Update `README.md`

Add a **"Persistent Memory"** section under the configuration reference documenting:
- The three backends and when to choose each.
- How `MEMORY_SESSION_ID` enables conversation resumption.
- How episodic memory injection works and the `EPISODIC_MEMORY_MAX_ENTRIES` cap.
- How to use `FileCheckpointStore` in custom orchestrator calls.

---

## Files to Create

| Path | Purpose |
|---|---|
| `src/memory/types.ts` | `EpisodeRecord`, `EpisodicStore` interface |
| `src/memory/session.ts` | `createChatHistory()` factory, `resolveSessionId()` |
| `src/memory/file-history.ts` | `FileChatMessageHistory` — JSONL-backed `BaseChatMessageHistory` |
| `src/memory/episodic.ts` | `FileEpisodicStore`, `formatEpisodicContext()` |
| `src/memory/index.ts` | Re-exports, singleton `episodicStore` |
| `src/__tests__/memory/file-history.test.ts` | Unit tests for `FileChatMessageHistory` |
| `src/__tests__/memory/episodic.test.ts` | Unit tests for `FileEpisodicStore` |
| `src/__tests__/memory/session.test.ts` | Unit tests for factory and `resolveSessionId()` |

## Files to Modify

| Path | Change |
|---|---|
| `src/config.ts` | Add 7 new config keys: `memoryBackend`, `memorySessionId`, `memoryDir`, `episodicMemoryEnabled`, `episodicMemoryFile`, `episodicMemoryMaxEntries`, `redisUrl`, `checkpointDir` |
| `src/index.ts` | Replace hardcoded `InMemoryChatMessageHistory` with `createChatHistory()`; add episodic write after loop; export `getCurrentSessionId()` |
| `src/subagents/runner.ts` | Accept optional `chatHistory` from `SubagentDefinition`; track `toolsUsed` for episodic records |
| `src/subagents/types.ts` | Add optional `chatHistory?: BaseChatMessageHistory` field to `SubagentDefinition` |
| `src/orchestrator.ts` | Add `FileCheckpointStore` class; add `fs` import |
| `src/context.ts` | Add `trimMessagesWithArchive()` alongside existing `trimMessages()` (non-breaking) |
| `.env.example` | Add memory & session config block |
| `README.md` | Add "Persistent Memory" section |

---

## Configuration Changes

| Variable | Type | Default | Description |
|---|---|---|---|
| `MEMORY_BACKEND` | `"none"\|"file"\|"redis"` | `"none"` | Session history storage backend |
| `MEMORY_SESSION_ID` | `string` | `""` (auto UUID) | Stable ID to resume a session across restarts |
| `MEMORY_DIR` | `string` | `.agentloop/sessions` | Root dir for `FileChatMessageHistory` JSONL files |
| `REDIS_URL` | `string` | `""` | Redis connection URL for `RedisChatMessageHistory` |
| `EPISODIC_MEMORY_ENABLED` | `boolean` | `false` | Inject past-episode summaries into system prompt |
| `EPISODIC_MEMORY_FILE` | `string` | `.agentloop/episodes.jsonl` | Path to episodic JSONL log |
| `EPISODIC_MEMORY_MAX_ENTRIES` | `number` | `50` | Max episodes injected per invocation |
| `CHECKPOINT_DIR` | `string` | `.agentloop/checkpoints` | Dir for `FileCheckpointStore` JSON files |

`REDIS_URL` is gated behind `MEMORY_BACKEND=redis`; `@langchain/redis` is a **peer dependency** (not added to `package.json` `dependencies`) to avoid forcing it on all users.

---

## Testing Approach

### Unit Tests

**`src/__tests__/memory/file-history.test.ts`**
- `addMessage()` + `getMessages()` round-trip with `HumanMessage`, `AIMessage`, `ToolMessage`.
- `clear()` removes the file and subsequent `getMessages()` returns `[]`.
- `getMessages()` returns `[]` when file does not exist (ENOENT).
- Concurrent `addMessage()` calls do not corrupt the file (sequential append).
- Uses `jest.spyOn(fs, 'appendFile')` and a real temp file in the project tree (not `/tmp`).

**`src/__tests__/memory/episodic.test.ts`**
- `append()` + `loadRecent()` round-trip.
- `loadRecent(n)` returns at most `n` records (newest first).
- `clear()` truncates the store.
- `formatEpisodicContext()` snapshot test.

**`src/__tests__/memory/session.test.ts`**
- `createChatHistory("none")` returns `InMemoryChatMessageHistory`.
- `createChatHistory("file")` returns `FileChatMessageHistory`.
- `resolveSessionId("")` returns a UUID string matching `/^[0-9a-f-]{36}$/`.
- `resolveSessionId("my-session")` returns `"my-session"` unchanged.

### Integration Tests

**`src/__tests__/index.test.ts`** — extend existing test suite:
- Inject a mock `BaseChatMessageHistory` via module-level override (same pattern as `setTracer()`) to verify that `executeWithTools()` calls `chatHistory.addMessage()` with the correct message sequence.
- Verify `getCurrentSessionId()` returns the configured `MEMORY_SESSION_ID`.

**`src/__tests__/orchestrator.test.ts`** — extend existing tests:
- `FileCheckpointStore.save()` + `load()` round-trip with a project-relative test file.
- `executePlan()` with a `FileCheckpointStore` resumes correctly from step 3 when steps 1–2 are pre-populated in the store.

### Snapshot / Regression Tests

- `trimMessagesWithArchive()` — verify the `onDropped` callback receives the correct messages; verify the returned array is identical to `trimMessages()` output.
- Test that `MEMORY_BACKEND=none` produces identical behaviour to the current baseline (no regression).

---

## Acceptance Criteria

- [ ] `MEMORY_BACKEND=file` + `MEMORY_SESSION_ID=my-session`: killing and restarting the process resumes the same conversation; `chatHistory.getMessages()` returns messages from the previous run.
- [ ] `MEMORY_BACKEND=none` (default): behaviour is **byte-for-byte identical** to the current implementation; all existing tests pass without modification.
- [ ] `EPISODIC_MEMORY_ENABLED=true`: episode records appear in `EPISODIC_MEMORY_FILE` after each `agentExecutor.invoke()` call; the next invocation's system prompt contains a fenced `--- Recent Episodes ---` block.
- [ ] `FileCheckpointStore` persists plan steps to `CHECKPOINT_DIR/<planId>.json`; a plan re-run with `resumeFrom: 3` skips steps 1 and 2 without re-executing them.
- [ ] `FileChatMessageHistory` correctly serialises and deserialises all LangChain message types (`HumanMessage`, `AIMessage`, `SystemMessage`, `ToolMessage`) without data loss.
- [ ] `trimMessagesWithArchive()` fires the `onDropped` callback with exactly the messages that would be removed, and the returned list matches `trimMessages()` exactly.
- [ ] `resolveSessionId("")` produces a valid UUID v4 that is stable for the lifetime of the process (same UUID returned on repeated calls within the same process).
- [ ] `@langchain/redis` is **not** a hard dependency; `MEMORY_BACKEND=redis` with `@langchain/redis` absent throws a clear `Error` with an actionable message ("Install @langchain/redis to use the Redis memory backend").
- [ ] All new code paths are covered by unit tests; `npx jest` passes with no regressions.
- [ ] `.env.example` and `README.md` document all eight new configuration keys.