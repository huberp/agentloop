# Issue: Toolbox Refiner — Context-Aware Tool Selection

## Summary

Introduce a `ToolboxRefiner` subsystem that dynamically selects the most relevant subset of
registered tools for each agent invocation, based on the current task context. This replaces the
current "expose every tool to every call" model with a precision-targeted approach that improves
LLM accuracy, reduces token overhead, and eliminates tool-confusion errors.

---

## Problem Statement

Every agent invocation in `agentloop` currently receives the full registered tool set:

| Call site | How tools are selected today |
|-----------|------------------------------|
| `src/index.ts` — `ensureInitialized()` | `llm.bindTools(toolRegistry.toLangChainTools())` — all tools, once at startup |
| `src/agents/activator.ts` — `activateProfile()` | Static intersection of profile's `tools[]` list |
| `src/subagents/runner.ts` — `runSubagent()` | Explicit `definition.tools[]` list (still static) |

There is **no mechanism** to dynamically narrow the exposed tool set based on what the current
task actually needs. Three concrete problems follow:

### 1. Token bloat from tool schema payloads

Every registered tool contributes its full JSON Schema to the LLM function-calling payload.
With 15–20 built-in tools (each with multi-field schemas), this adds hundreds to thousands of
tokens to every request. For a 28 000-token context budget (`MAX_CONTEXT_TOKENS`), this is a
non-trivial fraction consumed by tools the LLM will never call.

### 2. Tool-confusion / distraction errors

Research consistently shows that LLM tool-selection accuracy **degrades as the number of
available tools grows**. When a task only involves reading a file and returning its content,
presenting `git-commit`, `web-fetch`, `shell`, `code-run`, and `plan-and-run` alongside
`file-read` adds noise that causes the model to hallucinate irrelevant tool calls or fail to
pick the correct one.

### 3. Profile `tools[]` lists are brittle and manual

`AgentProfile.tools` is a hard-coded allowlist that a human must maintain as new tools are
added or removed. There is no mechanism to automatically discover which tools are relevant to a
given task context, meaning profiles lag behind the registry.

---

## Motivation

### BMW Agents Paper — Toolbox Refiner

The BMW Agents framework introduces the **Toolbox Refiner** as a first-class architectural
component responsible for dynamically filtering the global toolbox down to a task-relevant
subset before each agent unit receives its action space. The paper identifies three benefits:

1. **Accuracy**: Agents with a smaller, relevant tool set make fewer selection errors.
2. **Efficiency**: Smaller tool payloads reduce prompt length and inference latency.
3. **Safety**: Irrelevant dangerous tools (e.g. `file-delete`, `shell`) are not exposed unless
   the task explicitly requires them — a defence-in-depth complement to the existing
   `ToolPermissionManager`.

### LLM Performance Research

Multiple benchmark studies confirm tool-selection accuracy drops significantly beyond ~10 tools
in context. ToolBench, APIBench, and internal OpenAI analyses all recommend surfacing ≤10 tools
per call for best results. `agentloop`'s current built-in registry already has 16+ tools, with
MCP servers adding more at runtime.

### OpenAI and LangChain Best Practices

OpenAI's function-calling guide explicitly recommends _"providing only the tools relevant to the
current step"_ and notes that too many tools can cause models to _"make suboptimal choices"_.
LangChain documents a tool-filtering pattern in its agent documentation for the same reason.

---

## Proposed Design

### Overview

```
User request
     │
     ▼
ToolboxRefiner.selectTools(query, candidateTools, options)
     │   ├── KeywordMatcher   (fast, zero-cost, always on)
     │   ├── EmbeddingMatcher (semantic, optional, requires embedding model)
     │   └── LlmMatcher       (highest quality, optional, uses extra LLM call)
     │
     ▼
Filtered StructuredToolInterface[]
     │
     ▼
llm.bindTools(filteredTools)  ──▶  agent loop
```

The refiner runs **before** `bindTools` and produces a smaller subset. It does not replace the
existing permission layer — `ToolPermissionManager` still runs at execution time.

---

### New File: `src/tools/refiner.ts`

The central class:

```ts
export type RefinerStrategy = "keyword" | "embedding" | "llm" | "combined";

export interface ToolboxRefinerOptions {
  /** Maximum tools to return. Default: TOOL_REFINER_MAX_TOOLS (env). */
  maxTools?: number;
  /** Scoring strategy. Default: TOOL_REFINER_STRATEGY (env). */
  strategy?: RefinerStrategy;
  /**
   * Tools that must always be included regardless of score.
   * Useful for safety-net tools like `plan` and `calculate`.
   */
  alwaysInclude?: string[];
  /**
   * Tools that must always be excluded (layered on top of ToolPermissionManager).
   * Takes precedence over alwaysInclude.
   */
  alwaysExclude?: string[];
}

export interface ScoredTool {
  name: string;
  description: string;
  score: number;       // 0.0 – 1.0
  reasons: string[];   // human-readable explanation of why this tool was selected
}

export class ToolboxRefiner {
  constructor(private readonly options: ToolboxRefinerOptions = {}) {}

  /**
   * Select the most relevant tools from `candidates` for the given `query`.
   * Returns at most `maxTools` tools, always including `alwaysInclude` entries.
   */
  async selectTools(
    query: string,
    candidates: ToolDefinition[],
    overrides?: Partial<ToolboxRefinerOptions>
  ): Promise<ToolDefinition[]>;

  /** Explain why each candidate tool was or was not selected (for debug/tracing). */
  async explainSelection(
    query: string,
    candidates: ToolDefinition[]
  ): Promise<ScoredTool[]>;
}
```

#### Strategy: `keyword` (always available, zero-cost)

- Tokenises the query into lowercase keywords (stop-words removed).
- Scores each tool by counting keyword hits in `name` + `description`.
- Also matches on tool tags if the `ToolDefinition` schema is extended with an optional
  `tags?: string[]` field (see §Files to Modify).
- O(n) over candidates, no external calls, safe for every invocation.
- Suitable as the default strategy when no embedding model is configured.

#### Strategy: `embedding` (optional, requires embedding endpoint)

- Embeds the query and each tool description using a configurable embedding model
  (`TOOL_REFINER_EMBEDDING_MODEL`, defaults to Mistral's `mistral-embed`).
- Ranks candidates by cosine similarity between query vector and tool-description vector.
- Caches tool embeddings on first load (keyed by `name + description` hash) to avoid
  re-embedding unchanged tools on every call.
- Embedding cache is stored in-memory; optionally persisted to
  `TOOL_REFINER_EMBEDDING_CACHE_FILE` for warm restarts.

#### Strategy: `llm` (highest quality, extra LLM call)

- Sends the query and a compact tool catalogue (name + one-line description per tool) to the
  LLM in a structured prompt requesting a JSON list of selected tool names with rationale.
- Uses a **separate, low-temperature** LLM call (`temperature: 0.1`) to ensure determinism.
- Result is cached by a hash of `(query, toolNames[])` to avoid redundant calls for the same
  context within a session.

#### Strategy: `combined` (default recommendation)

- Runs `keyword` first to eliminate obviously irrelevant tools (score = 0).
- Runs `embedding` on the surviving set to rank by semantic similarity.
- Merges scores: `combined = 0.4 * keyword_normalised + 0.6 * embedding`.
- Falls back to `keyword`-only if the embedding model is not configured.

---

### Integration Point 1: `src/index.ts` — per-request dynamic binding

Replace the one-time `bindTools` in `ensureInitialized()` with per-request tool selection:

**Before:**
```ts
_llmWithTools = llm.bindTools!(toolRegistry.toLangChainTools());
```

**After:**
```ts
// _llmWithTools is no longer set globally at init time.
// executeWithTools() calls selectAndBindTools(query) before each agent loop.
```

New helper inside `src/index.ts`:
```ts
async function selectAndBindTools(
  query: string,
  runtimeConfig?: AgentRuntimeConfig
): Promise<Runnable<BaseLanguageModelInput, AIMessageChunk>> {
  const candidates = runtimeConfig?.activeTools?.length
    ? runtimeConfig.activeTools
        .map((n) => toolRegistry.getDefinition(n))
        .filter((d): d is ToolDefinition => d !== undefined)
    : toolRegistry.getAll().map((t) => toolRegistry.getDefinition(t.name)!);

  const selected = await toolboxRefiner.selectTools(query, candidates);
  return llm.bindTools!(selected.map(defToLangChainTool));
}
```

The `toolboxRefiner` singleton is initialised from env-config during `ensureInitialized()`.

---

### Integration Point 2: `src/agents/activator.ts` — profile-aware pre-filtering

`activateProfile()` currently computes a static `activeTools: string[]`. The refiner will
consume this list as its **candidate set** rather than the full registry, preserving the
existing profile-based restriction while adding dynamic ranking on top.

No change is required to the `AgentRuntimeConfig` interface — `activeTools` retains its
meaning as "allowed tools"; the refiner narrows this further at call time.

---

### Integration Point 3: `src/subagents/runner.ts` — optional auto-selection

`SubagentDefinition.tools` currently requires an explicit list. Add an opt-in flag:

```ts
export interface SubagentDefinition {
  // … existing fields …
  /**
   * When true, the Toolbox Refiner automatically selects tools from the parent
   * registry based on the subagent's task. The explicit `tools` list is used as
   * the candidate set (or the full registry when `tools` is empty).
   */
  autoSelectTools?: boolean;
}
```

In `runSubagent()`, when `autoSelectTools` is true, replace the manual loop that builds
`filteredRegistry` with a `toolboxRefiner.selectTools(task, candidateDefs)` call.

---

### New File: `src/tools/embeddings.ts`

Thin abstraction over embedding generation, to keep `refiner.ts` provider-agnostic:

```ts
export interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>;
}

/** Mistral embedding provider using MistralAI SDK. */
export class MistralEmbeddingProvider implements EmbeddingProvider { … }

/** Returns the configured provider or null when no embedding model is set. */
export function createEmbeddingProvider(config: AppConfig): EmbeddingProvider | null { … }
```

---

### New File: `src/tools/refiner-cache.ts`

```ts
/** In-memory LRU cache for embedding vectors and LLM selection results. */
export class RefinerCache {
  constructor(private readonly maxEntries: number) {}
  getEmbedding(key: string): number[] | undefined;
  setEmbedding(key: string, vector: number[]): void;
  getLlmSelection(key: string): string[] | undefined;
  setLlmSelection(key: string, names: string[]): void;
}
```

---

## Implementation Steps

### Step 1 — Extend `ToolDefinition` with optional metadata

**File:** `src/tools/registry.ts`

Add optional fields to `ToolDefinition`:

```ts
export interface ToolDefinition {
  // … existing fields …
  /**
   * Optional semantic tags for keyword-based tool selection.
   * Example: ["filesystem", "read", "text"]
   */
  tags?: string[];
  /**
   * Short one-line summary used by the LLM-based refiner strategy.
   * Falls back to the first sentence of `description` when absent.
   */
  summary?: string;
}
```

Annotate all existing built-in tools (`src/tools/*.ts`) with `tags` and `summary` fields.

---

### Step 2 — Create `src/tools/embeddings.ts`

Implement `EmbeddingProvider` interface and `MistralEmbeddingProvider`. Wire the factory
function to `appConfig.toolRefinerEmbeddingModel`. Return `null` when the model is not set,
allowing graceful degradation to keyword-only strategy.

---

### Step 3 — Create `src/tools/refiner-cache.ts`

Implement a lightweight LRU map. Max capacity is controlled by `TOOL_REFINER_CACHE_MAX_ENTRIES`
(default: 256). Provides two independent cache namespaces: `embedding` and `llmSelection`.

---

### Step 4 — Create `src/tools/refiner.ts`

Implement `ToolboxRefiner` with all four strategies. Unit-testable — inject a mock
`EmbeddingProvider` and a mock LLM in tests via constructor dependency injection:

```ts
export class ToolboxRefiner {
  constructor(
    private readonly options: ToolboxRefinerOptions,
    private readonly embeddingProvider: EmbeddingProvider | null,
    private readonly llmProvider?: BaseChatModel,
    private readonly cache: RefinerCache = new RefinerCache(256)
  ) {}
}
```

Expose a factory function:
```ts
export function createToolboxRefiner(
  config: AppConfig,
  llm?: BaseChatModel
): ToolboxRefiner { … }
```

---

### Step 5 — Add config keys to `src/config.ts` and `.env.example`

New `appConfig` fields:

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `toolRefinerEnabled` | `boolean` | `false` | Master switch; when false, full tool set is used (backward compat) |
| `toolRefinerStrategy` | `string` | `"combined"` | One of `keyword \| embedding \| llm \| combined` |
| `toolRefinerMaxTools` | `number` | `10` | Maximum tools surfaced per invocation |
| `toolRefinerAlwaysInclude` | `string[]` | `[]` | Comma-separated tool names always included |
| `toolRefinerEmbeddingModel` | `string` | `""` | Embedding model name (empty = disable embedding strategy) |
| `toolRefinerCacheMaxEntries` | `number` | `256` | LRU cache capacity for embedding/LLM results |
| `toolRefinerEmbeddingCacheFile` | `string` | `""` | Optional path for persisting embedding cache across restarts |

---

### Step 6 — Update `src/index.ts`

1. Import `createToolboxRefiner` from `src/tools/refiner.ts`.
2. Initialise the singleton in `ensureInitialized()`:
   ```ts
   const toolboxRefiner = createToolboxRefiner(appConfig, llm);
   ```
3. Replace the single `llm.bindTools(toolRegistry.toLangChainTools())` call with the
   `selectAndBindTools(query, runtimeConfig?)` helper that is called inside each
   `executeWithTools()` invocation.
4. When `appConfig.toolRefinerEnabled === false`, `selectAndBindTools` bypasses the refiner
   and returns the full tool set — exactly current behaviour.
5. Add a structured log line at `debug` level recording which tools were selected and why
   (surfaces `ScoredTool[]` from `explainSelection()`).

---

### Step 7 — Update `src/subagents/runner.ts`

1. Import `ToolboxRefiner` type (injected, not imported as singleton to keep runner testable).
2. Add optional `refiner?: ToolboxRefiner` parameter to `runSubagent()`.
3. When `definition.autoSelectTools === true && refiner !== undefined`, replace the manual
   `filteredRegistry` construction with refiner selection.
4. Fall back to existing behaviour when refiner is absent or `autoSelectTools` is false.

---

### Step 8 — Update `src/agents/activator.ts`

No logic changes. Add a JSDoc comment to `AgentRuntimeConfig.activeTools` clarifying that
this list now serves as the **candidate pool** for the Toolbox Refiner, not the final list:

```ts
/**
 * Tool names the agent is permitted to use.
 * When the Toolbox Refiner is enabled, this list is used as the candidate
 * pool; the refiner further narrows it based on task context.
 * Empty array means all registered tools are candidates.
 */
activeTools: string[];
```

---

### Step 9 — Annotate built-in tools with `tags` and `summary`

For each file in `src/tools/*.ts` (excluding `registry.ts`, `refiner.ts`, etc.), add `tags`
and `summary` to the exported `toolDefinition`. Example:

```ts
// src/tools/file-read.ts
export const toolDefinition: ToolDefinition = {
  name: "file-read",
  summary: "Read the text content of a file.",
  tags: ["filesystem", "read", "text", "file"],
  description: "…full description…",
  // …
};
```

---

### Step 10 — Tests

**New test file: `src/__tests__/toolbox-refiner.test.ts`**

| Test case | What it verifies |
|-----------|-----------------|
| `keyword strategy — selects file tools for file task` | Query "read a file" returns `file-read`, not `git-commit` |
| `keyword strategy — alwaysInclude respected` | Pinned tool present even when score = 0 |
| `keyword strategy — maxTools limit enforced` | Never returns more than `maxTools` tools |
| `embedding strategy — cosine similarity ranking` | Mock provider returns vectors; verifies rank order |
| `embedding strategy — cache hit avoids re-embed` | Provider called once per unique text, not twice |
| `llm strategy — parses JSON tool list` | Mock LLM returns tool names; verifies selection |
| `llm strategy — cache hit avoids extra LLM call` | Same query+tools combo hits cache |
| `combined strategy — merges scores correctly` | Verifies 0.4/0.6 weighting math |
| `combined falls back to keyword with no embedding provider` | No error when provider is null |
| `selectTools returns full set when enabled=false (bypass)` | Backward compat guard |
| `explainSelection returns scored reasons` | Returns `ScoredTool[]` with non-empty `reasons` |

**Update `src/__tests__/index.test.ts`**

- Add a test for the `TOOL_REFINER_ENABLED=true` path that verifies `bindTools` is called with
  a subset and not the full registry.
- Verify the `TOOL_REFINER_ENABLED=false` path continues to use the full set (regression guard).

**Update `src/__tests__/subagent-runner.test.ts`**

- Test `autoSelectTools: true` path: inject a mock refiner, verify the filtered registry
  contains only the refiner-selected tools.
- Test `autoSelectTools: false` (or undefined): verify existing static-list behaviour
  is unchanged.

---

## Files to Create

| File | Purpose |
|------|---------|
| `src/tools/refiner.ts` | `ToolboxRefiner` class + factory function |
| `src/tools/embeddings.ts` | `EmbeddingProvider` interface + `MistralEmbeddingProvider` |
| `src/tools/refiner-cache.ts` | LRU cache for embedding vectors and LLM selections |
| `src/__tests__/toolbox-refiner.test.ts` | Full unit test suite for the refiner |

---

## Files to Modify

| File | Change |
|------|--------|
| `src/tools/registry.ts` | Add `tags?: string[]` and `summary?: string` to `ToolDefinition` |
| `src/tools/*.ts` (all built-in tools) | Add `tags` and `summary` to each `toolDefinition` export |
| `src/config.ts` | Add 7 new config keys listed in Step 5 |
| `.env.example` | Document all new config keys with defaults and comments |
| `src/index.ts` | Replace global `bindTools` with `selectAndBindTools()` per-request helper |
| `src/agents/activator.ts` | Add JSDoc clarifying `activeTools` as candidate pool |
| `src/subagents/runner.ts` | Add optional `refiner` param + `autoSelectTools` branch |
| `src/subagents/types.ts` | Add `autoSelectTools?: boolean` to `SubagentDefinition` |
| `src/__tests__/index.test.ts` | Add refiner-enabled / refiner-disabled test cases |
| `src/__tests__/subagent-runner.test.ts` | Add `autoSelectTools` test cases |
| `README.md` | Document `TOOL_REFINER_*` config section |

---

## Configuration Changes

Add to `.env.example` (new section after `# MCP client integration`):

```dotenv
# Toolbox Refiner — context-aware tool selection (Issue #5)
# When true, only relevant tools are exposed to the LLM per invocation.
# Set to false (default) for backward-compatible behaviour (all tools always exposed).
TOOL_REFINER_ENABLED=false
# Scoring strategy: keyword | embedding | llm | combined (default: combined)
TOOL_REFINER_STRATEGY=combined
# Maximum number of tools to surface per invocation (default: 10)
TOOL_REFINER_MAX_TOOLS=10
# Comma-separated tool names always included regardless of score (e.g. plan,calculate)
TOOL_REFINER_ALWAYS_INCLUDE=
# Embedding model for semantic tool selection (leave empty to disable embedding strategy)
# When using Mistral: mistral-embed
TOOL_REFINER_EMBEDDING_MODEL=
# LRU cache capacity for embedding vectors and LLM selection results (default: 256)
TOOL_REFINER_CACHE_MAX_ENTRIES=256
# Optional file path to persist embedding vectors across restarts (leave empty to disable)
TOOL_REFINER_EMBEDDING_CACHE_FILE=
```

---

## Testing Approach

### Unit Tests (Jest, `ts-jest`, `isolatedModules: true`)

- All three strategy implementations are unit-testable via constructor injection.
- `EmbeddingProvider` is a simple interface — a mock returning fixed vectors replaces the real
  Mistral client, enabling deterministic cosine-similarity tests with no network I/O.
- The LLM-based strategy accepts a `BaseChatModel` — use the project's existing `MockChatModel`
  (or `jest.fn()` returning a pre-built `AIMessage`) to avoid real API calls.
- `RefinerCache` is a pure data structure, tested independently.

### Integration Tests

- Add a test under `tests/` (e2e config in `jest.e2e.config.js`) that starts the agent with
  `TOOL_REFINER_ENABLED=true`, submits a file-only task, and asserts that no git or web tools
  appear in the bound tool list (captured via the `Tracer` event log).

### Regression Guard

- The existing `src/__tests__/index.test.ts` suite must continue to pass unchanged for the
  `TOOL_REFINER_ENABLED=false` path, ensuring no breakage to current consumers.

---

## Acceptance Criteria

- [ ] `ToolboxRefiner` class exists in `src/tools/refiner.ts` and is exported.
- [ ] All four strategies (`keyword`, `embedding`, `llm`, `combined`) are implemented.
- [ ] `combined` strategy correctly degrades to `keyword`-only when no embedding model is configured.
- [ ] `TOOL_REFINER_ENABLED=false` (default) produces **identical** behaviour to the current codebase — no regression.
- [ ] `TOOL_REFINER_ENABLED=true` causes `bindTools` to receive a subset of the full registry on each request.
- [ ] `TOOL_REFINER_MAX_TOOLS` is respected: `bindTools` is never called with more than this many tools.
- [ ] `TOOL_REFINER_ALWAYS_INCLUDE` tools are always present in the output regardless of score.
- [ ] `SubagentDefinition.autoSelectTools: true` delegates tool selection to the refiner.
- [ ] All existing tests pass without modification.
- [ ] New test file achieves ≥ 90% branch coverage on `refiner.ts`.
- [ ] All new config keys are documented in `.env.example` with defaults.
- [ ] `README.md` documents the Toolbox Refiner feature and configuration.
- [ ] Structured `debug` log lines record selected tools and scores per invocation.
- [ ] No circular imports introduced (refiner must not import from `src/index.ts`).

---

## Non-Goals / Out of Scope

- **Persistent cross-session learning**: The refiner does not remember which tools were useful
  in past sessions. This is a future enhancement (online feedback loop).
- **Tool routing across multiple agents**: Selecting _which agent_ handles a task is the
  Coordinator's responsibility (`src/agents/coordinator.ts`) and is out of scope here.
- **Changing the security model**: `ToolPermissionManager` continues to own permission checks;
  the refiner is purely a relevance filter and does not bypass any security layer.
- **Removing tools from the registry**: The refiner never calls `toolRegistry.unregister()`.
  Tools remain registered; they are just not bound to the LLM for a particular invocation.
