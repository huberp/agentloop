# Issue: Enhanced Multi-Agent Collaboration Patterns

## Summary

Extend `agentloop`'s multi-agent runtime with four new collaboration patterns — **Joint**, **Hierarchical**, **Broadcast**, and **Dynamic Task Decomposition** — to move beyond today's isolated-parallel model toward richly coordinated agent networks.

---

## Problem Statement

`agentloop` currently supports two execution modes:

| Mode | Location | Limitation |
|------|----------|-----------|
| Sequential | `src/orchestrator.ts` (`executePlan` for-loop) | Steps run one-at-a-time; no concurrency at the plan level |
| Parallel-isolated | `src/subagents/manager.ts` (`runParallel`) | Agents fire concurrently but share no state, cannot message each other, and cannot spawn children |

Subagents are completely air-gapped. The only cross-agent signal today is passive conflict detection (multiple agents modified the same file). The `parentCommunication?: boolean` stub in `SubagentDefinition` (see `src/subagents/types.ts`) explicitly marks this gap as a known future work item. `sharedContext` exists but is **read-only** — agents can consume shared context but cannot publish back to it.

This means complex tasks that benefit from mid-flight knowledge sharing, supervisory delegation, or swarm broadcasting are not achievable without significant workarounds.

---

## Motivation

### BMW Agents Paper (Multi-Agent Collaboration Patterns)

The BMW Agents framework taxonomy identifies five fundamental collaboration patterns. `agentloop` currently covers two:

| Pattern | agentloop today | This issue |
|---------|----------------|------------|
| **Independent** | ✅ `runParallel` (isolated) | — |
| **Sequential** | ✅ `executePlan` (for-loop) | — |
| **Joint** | ❌ Missing | ✅ Implement |
| **Hierarchical** | ❌ Missing | ✅ Implement |
| **Broadcast** | ❌ Missing | ✅ Implement |
| **Dynamic decomposition** | ❌ Missing | ✅ Implement |

### Validation from the Ecosystem

- **LangGraph** — multi-agent patterns (supervisor graph, swarm, network) confirm all four patterns are production-viable with LangChain primitives already in use by `agentloop`.
- **Microsoft AutoGen** — group-chat and broadcast patterns demonstrate practical benefits for code review, debate, and consensus tasks.
- **CrewAI** — hierarchical process with a manager LLM delegating to crew workers is a proven pattern for decomposed engineering tasks.

All three frameworks converge on the same four patterns, validating the scope of this issue.

---

## Proposed Design

### 1. Joint Collaboration — `runJoint()`

**Concept:** Multiple agents work concurrently toward a shared goal with a mutable *message board* they can both read from and write to. After each agent loop iteration, each agent publishes a progress snapshot; before the next iteration, it reads the latest snapshots from all peers.

**Core new abstraction — `JointContextStore`** (`src/subagents/joint-context.ts`):

```ts
/** A thread-safe, append-only board for inter-agent messages. */
export interface JointMessage {
  from: string;           // agent name
  timestamp: number;      // Date.now()
  content: string;        // free-form text published by the agent
  tags?: string[];        // optional topic tags for selective reading
}

export interface JointContextStore {
  /** Publish a message to the board. */
  publish(message: JointMessage): void;
  /** Read all messages not yet seen by `readerName`. Advances internal cursor. */
  readNew(readerName: string): JointMessage[];
  /** Snapshot of the full board (for system-prompt injection at agent start). */
  snapshot(): JointMessage[];
}

export class InMemoryJointContextStore implements JointContextStore { ... }
```

**Updated `SubagentDefinition`** (`src/subagents/types.ts`):

```ts
export interface SubagentDefinition {
  // ... existing fields ...
  jointContextStore?: JointContextStore;   // replaces the parentCommunication stub
}
```

**New `runner.ts` behaviour:** When `definition.jointContextStore` is set, the runner:
1. Injects `store.snapshot()` into the system prompt (formatted as a JSON block, similar to today's `sharedContext` formatting in `formatSharedContext()`).
2. After each LLM iteration that produces a text response (not just tool calls), calls `store.publish({ from: definition.name, ... })`.
3. Before each LLM call, prepends a `SystemMessage` update containing `store.readNew(definition.name)` so the agent sees new peer messages mid-flight.

**New `SubagentManager` method:**

```ts
async runJoint(tasks: JointTask[]): Promise<JointResult>
```

```ts
export interface JointTask {
  definition: SubagentDefinition;
  task: string;
}

export interface JointResult {
  results: Array<SubagentResult | { name: string; error: string }>;
  messageBoard: JointMessage[];   // full board at end of run
  conflicts: ConflictInfo[];
}
```

The implementation injects the **same** `InMemoryJointContextStore` instance into every `definition.jointContextStore` before firing `runParallel`-style concurrent execution.

---

### 2. Hierarchical Delegation — `runHierarchical()`

**Concept:** A supervisor agent can call a `delegate_subagent` tool at runtime to spawn child agents. Children can themselves delegate further, up to a configurable depth. The supervisor receives child results as tool outputs and synthesises a final answer.

**New tool** — `src/tools/delegate.ts`:

```ts
export function createDelegateTool(
  manager: SubagentManager,
  registry: ToolRegistry,
  currentDepth: number,
  maxDepth: number
): ToolDefinition
```

The tool's `execute` function:
1. Validates `currentDepth < maxDepth`; rejects with a structured error otherwise.
2. Deserialises the tool arguments (agent name, task, allowed tools, optional system prompt).
3. Calls `manager.run(definition, task)` and returns the `SubagentResult.output` as the tool response.

The tool is **not** added to the global `ToolRegistry`. It is created dynamically and injected into a filtered registry built inside `runHierarchical()`.

**New `SubagentManager` method:**

```ts
async runHierarchical(
  supervisorDefinition: SubagentDefinition,
  task: string,
  maxDepth?: number
): Promise<HierarchicalResult>
```

```ts
export interface HierarchicalResult extends SubagentResult {
  delegations: DelegationRecord[];
}

export interface DelegationRecord {
  parentAgent: string;
  childAgent: string;
  task: string;
  depth: number;
  result: SubagentResult | { error: string };
}
```

The `SubagentManager` instance passed recursively into each child carries a `delegations` collector array so the call tree is captured without needing a global singleton.

**New `HierarchicalSubagentDefinition`** (extends `SubagentDefinition`):

```ts
export interface HierarchicalSubagentDefinition extends SubagentDefinition {
  /** Tools the supervisor is allowed to delegate to child agents. */
  delegatableTools?: string[];
  /** Maximum delegation depth (0 = supervisor only, no delegation). */
  maxDelegationDepth?: number;
}
```

---

### 3. Broadcast — `runBroadcast()`

**Concept:** A *broadcaster* agent (or the orchestrator itself) emits messages to a named channel. All subscriber agents receive the message injected into their next LLM call. This enables swarm-style propagation of discoveries, cancellation signals, and shared directives.

**New abstraction — `MessageBus`** (`src/subagents/message-bus.ts`):

```ts
export interface BroadcastMessage {
  channel: string;
  from: string;
  content: string;
  timestamp: number;
}

export class MessageBus {
  /** Publish a message to a channel; all subscribers are notified. */
  broadcast(message: BroadcastMessage): void;

  /** Subscribe an agent to a channel. Returns an unsubscribe function. */
  subscribe(channel: string, agentName: string, handler: (msg: BroadcastMessage) => void): () => void;

  /** Drain all pending messages for `agentName` across all its subscribed channels. */
  drain(agentName: string): BroadcastMessage[];
}
```

The `MessageBus` is passed into `runner.ts` as an optional parameter. Before each LLM call the runner calls `bus.drain(definition.name)` and injects drained messages as a `SystemMessage` update. This keeps the runner non-blocking — it never awaits the bus.

**New `SubagentDefinition` field:**

```ts
export interface SubagentDefinition {
  // ... existing + jointContextStore ...
  messageBus?: MessageBus;
  messageChannels?: string[];   // channels this agent subscribes to
}
```

**New `SubagentManager` method:**

```ts
async runBroadcast(
  tasks: BroadcastTask[],
  bus?: MessageBus
): Promise<BroadcastResult>
```

```ts
export interface BroadcastTask {
  definition: SubagentDefinition;
  task: string;
  channels?: string[];   // channels to subscribe; defaults to definition.messageChannels
}

export interface BroadcastResult extends ParallelResult {
  broadcastLog: BroadcastMessage[];  // all messages sent during the run
}
```

The `SubagentManager` creates a single shared `MessageBus` instance (or accepts a provided one), injects it into every task definition, and subscribes each agent to its declared channels before firing parallel execution.

---

### 4. Dynamic Task Decomposition

**Concept:** During `executePlan()`, a high-complexity step can spawn new plan sub-steps at runtime using a `decompose_task` tool call. The orchestrator inserts the new steps immediately after the current step and continues execution.

**New tool** — `src/tools/decompose.ts`:

```ts
export function createDecomposeTool(
  stepInserter: (steps: PlanStep[]) => void
): ToolDefinition
```

The tool deserialises a JSON array of `PlanStep` objects from the LLM's tool call arguments, validates them with `validatePlan()`, and calls `stepInserter` to splice them into the live plan.

**Orchestrator changes** (`src/orchestrator.ts`):

`executePlan()` converts the static `plan.steps` array into a mutable `steps` list before the for-loop. The `executeStep` function receives an optional `stepInserter` callback. When a step is running with a `SubagentDefinition` that includes the decompose tool, newly injected steps are appended to the live list and the loop counter stays behind them.

```ts
// Inside executePlan — conceptual delta
const steps = [...plan.steps];  // mutable copy
for (let i = 0; i < steps.length; i++) {   // steps.length re-evaluated each iteration
  // ...
  const stepInserter = (newSteps: PlanStep[]) => {
    steps.splice(i + 1, 0, ...newSteps);
    logger.info({ count: newSteps.length, afterStep: i + 1 }, "Steps dynamically injected");
  };
  const result = await executeStep(step, i, manager, registry, llm, onStepFailure, options.profileRegistry, stepInserter);
  // ...
}
```

**Planner changes** (`src/subagents/planner.ts`):

Add `collaborationPattern` to `PlanStep`:

```ts
export type CollaborationPattern = "sequential" | "parallel" | "joint" | "hierarchical" | "broadcast";

export interface PlanStep {
  description: string;
  toolsNeeded: string[];
  estimatedComplexity: "low" | "medium" | "high";
  agentProfile?: string;
  /** Collaboration pattern for this step; defaults to "sequential". */
  collaborationPattern?: CollaborationPattern;
  /** For "joint" and "broadcast" patterns: named sub-tasks to run concurrently. */
  subTasks?: Array<{ name: string; task: string; tools: string[] }>;
}
```

The orchestrator `executeStep()` inspects `step.collaborationPattern` and routes accordingly:

| Pattern | Executor |
|---------|----------|
| `"sequential"` (default) | existing `runSubagent()` / simple path |
| `"parallel"` | existing `manager.runParallel()` |
| `"joint"` | new `manager.runJoint()` |
| `"hierarchical"` | new `manager.runHierarchical()` |
| `"broadcast"` | new `manager.runBroadcast()` |

---

## Files to Modify

### Modified Files

| File | Changes |
|------|---------|
| `src/subagents/types.ts` | Add `JointMessage`, `JointTask`, `JointResult`, `HierarchicalSubagentDefinition`, `HierarchicalResult`, `DelegationRecord`, `BroadcastTask`, `BroadcastResult`; extend `SubagentDefinition` with `jointContextStore?`, `messageBus?`, `messageChannels?`; remove unused `parentCommunication` stub |
| `src/subagents/manager.ts` | Add `runJoint()`, `runHierarchical()`, `runBroadcast()` methods |
| `src/subagents/runner.ts` | Inject joint context reads/writes per iteration; drain `MessageBus` before each LLM call; remove `parentCommunication` stub handling |
| `src/subagents/planner.ts` | Add `CollaborationPattern` type; add `collaborationPattern` and `subTasks` to `PlanStep`; update `JSON_SCHEMA_HINT` and `PLANNER_SYSTEM_PROMPT` to teach the model about patterns; update `parsePlanFromText` to deserialise new fields |
| `src/orchestrator.ts` | Convert `plan.steps` to a mutable array; pass `stepInserter` into `executeStep`; route per `collaborationPattern`; update `ExecutionOptions` with `maxDelegationDepth?` |
| `src/config.ts` | Add `maxJointAgents`, `hierarchicalMaxDepth`, `broadcastBufferSize`, `dynamicDecompositionEnabled` |
| `.env.example` | Add corresponding env var documentation |

### New Files

| File | Purpose |
|------|---------|
| `src/subagents/joint-context.ts` | `JointMessage`, `JointContextStore` interface, `InMemoryJointContextStore` class |
| `src/subagents/message-bus.ts` | `BroadcastMessage`, `MessageBus` class |
| `src/tools/delegate.ts` | `createDelegateTool()` factory — dynamically constructed, not registered globally |
| `src/tools/decompose.ts` | `createDecomposeTool()` factory — dynamically constructed, not registered globally |
| `src/subagents/__tests__/joint-context.test.ts` | Unit tests for `InMemoryJointContextStore` |
| `src/subagents/__tests__/message-bus.test.ts` | Unit tests for `MessageBus` |
| `src/subagents/__tests__/manager-joint.test.ts` | Integration tests for `runJoint()` |
| `src/subagents/__tests__/manager-hierarchical.test.ts` | Integration tests for `runHierarchical()` |
| `src/subagents/__tests__/manager-broadcast.test.ts` | Integration tests for `runBroadcast()` |
| `src/subagents/__tests__/dynamic-decomposition.test.ts` | Integration tests for step injection in `executePlan()` |

---

## Implementation Steps

### Phase 1 — Infrastructure (no behaviour changes yet)

1. **Add new types to `src/subagents/types.ts`**
   - Add `JointMessage`, `JointTask`, `JointResult`, `HierarchicalSubagentDefinition`, `HierarchicalResult`, `DelegationRecord`, `BroadcastTask`, `BroadcastResult`
   - Extend `SubagentDefinition`: add `jointContextStore?: JointContextStore`, `messageBus?: MessageBus`, `messageChannels?: string[]`
   - Replace `parentCommunication?: boolean` stub with the proper new fields
   - Add `CollaborationPattern` union type

2. **Create `src/subagents/joint-context.ts`**
   - Define `JointMessage` and `JointContextStore` interface
   - Implement `InMemoryJointContextStore` with per-reader cursor tracking (use `Map<string, number>`)

3. **Create `src/subagents/message-bus.ts`**
   - Implement `MessageBus` with `broadcast()`, `subscribe()`, `drain()`
   - Use a `Map<channel, Set<agentName>>` for subscriptions and a `Map<agentName, BroadcastMessage[]>` for pending message queues

4. **Update `src/config.ts` and `.env.example`**
   - Add `MAX_JOINT_AGENTS`, `HIERARCHICAL_MAX_DEPTH`, `BROADCAST_BUFFER_SIZE`, `DYNAMIC_DECOMPOSITION_ENABLED`

### Phase 2 — Runner Instrumentation

5. **Update `src/subagents/runner.ts`**
   - In `buildDefaultSystemPrompt()`, handle joint context initial snapshot formatting (mirror the existing `formatSharedContext()` pattern)
   - At the top of each iteration loop body, drain `definition.messageBus?.drain(definition.name)` and inject a `SystemMessage` update when the drain result is non-empty
   - After each non-tool-call AI response, call `definition.jointContextStore?.publish(...)` with the text output

### Phase 3 — New Manager Methods

6. **Add `runJoint()` to `src/subagents/manager.ts`**
   - Create one `InMemoryJointContextStore` instance
   - Inject the store into all task definitions
   - Delegate to `runParallel()` (reuse concurrency queue)
   - Wrap `ParallelResult` in `JointResult`, including the final `store.snapshot()` as `messageBoard`

7. **Create `src/tools/delegate.ts`**
   - `createDelegateTool(manager, registry, currentDepth, maxDepth)` returns a `ToolDefinition`
   - Tool name: `"delegate_subagent"`
   - Tool args: `{ name: string, task: string, tools: string[], systemPrompt?: string }`
   - Returns stringified `SubagentResult.output` on success, or a structured error message on depth violation

8. **Add `runHierarchical()` to `src/subagents/manager.ts`**
   - Build a `filteredRegistry` that includes the `delegate_subagent` tool created by `createDelegateTool()`
   - The `DelegationRecord[]` collector is passed through a closure shared between the outer call and any recursive `manager.run()` triggered by the delegate tool
   - Returns `HierarchicalResult` with the delegation call tree

9. **Create `src/tools/decompose.ts`**
   - `createDecomposeTool(stepInserter)` returns a `ToolDefinition`
   - Tool name: `"decompose_task"`
   - Tool args: `{ steps: PlanStep[] }`
   - Validates each step object's shape, calls `stepInserter(steps)`, returns confirmation

10. **Add `runBroadcast()` to `src/subagents/manager.ts`**
    - Create (or accept) a `MessageBus`
    - Subscribe each agent to its declared `channels`
    - Inject the bus into all task definitions
    - Delegate to `runParallel()`
    - Return `BroadcastResult` with the full `bus.broadcastLog`

### Phase 4 — Orchestrator & Planner Integration

11. **Update `src/subagents/planner.ts`**
    - Add `CollaborationPattern` union to `PlanStep`
    - Update `JSON_SCHEMA_HINT`:
      ```json
      "collaborationPattern": "sequential" | "parallel" | "joint" | "hierarchical" | "broadcast",
      "subTasks": [{ "name": "string", "task": "string", "tools": ["string"] }]
      ```
    - Update `PLANNER_SYSTEM_PROMPT` with guidance on when to use each pattern
    - Update `parsePlanFromText()` to parse `collaborationPattern` and `subTasks`

12. **Update `src/orchestrator.ts`**
    - In `executePlan()`: convert `plan.steps` to `const steps = [...plan.steps]` and change the loop header to `i < steps.length` so injected steps are naturally picked up
    - Add `stepInserter` parameter to `executeStep()`; wire `createDecomposeTool(stepInserter)` into complex steps when `DYNAMIC_DECOMPOSITION_ENABLED=true`
    - Add a `collaborationPattern` routing switch in `executeStep()`:
      - `"joint"` → `manager.runJoint(step.subTasks.map(...))`
      - `"hierarchical"` → `manager.runHierarchical(supervisorDef, step.description)`
      - `"broadcast"` → `manager.runBroadcast(step.subTasks.map(...))`
      - default → existing sequential/parallel logic
    - Add `maxDelegationDepth?: number` to `ExecutionOptions`

### Phase 5 — Tests

13. **Unit tests** — `joint-context.test.ts`, `message-bus.test.ts`
    - Pure data-structure tests; no LLM mocking needed
    - Cover: publish/read cursor advancement, multi-reader isolation, drain-then-re-drain idempotency, bus broadcast fan-out

14. **Integration tests** — `manager-joint.test.ts`, `manager-hierarchical.test.ts`, `manager-broadcast.test.ts`, `dynamic-decomposition.test.ts`
    - Use `MockChatModel` (pattern established in `tests/` and `src/testing/`) with deterministic fixture responses
    - Joint test: two agents, one publishes a message, assert peer reads it in subsequent iteration context
    - Hierarchical test: supervisor LLM response contains a `delegate_subagent` tool call; assert delegation record captured
    - Broadcast test: bus message injected mid-run; assert agent system prompt update contains it
    - Decomposition test: step LLM response contains `decompose_task` call; assert injected steps appear in `ExecutionResult.stepResults`

---

## Configuration Changes

Add to `src/config.ts`:

```ts
export const appConfig = {
  // ... existing fields ...

  // Multi-agent collaboration
  maxJointAgents: parseInt(process.env.MAX_JOINT_AGENTS ?? "8", 10),
  hierarchicalMaxDepth: parseInt(process.env.HIERARCHICAL_MAX_DEPTH ?? "3", 10),
  broadcastBufferSize: parseInt(process.env.BROADCAST_BUFFER_SIZE ?? "256", 10),
  dynamicDecompositionEnabled: asBoolean(process.env.DYNAMIC_DECOMPOSITION_ENABLED, false),
};
```

Add to `.env.example`:

```dotenv
# Multi-Agent Collaboration Patterns
# Maximum number of agents allowed in a joint collaboration session (default: 8)
MAX_JOINT_AGENTS=8
# Maximum hierarchy depth for supervisor→subordinate delegation chains (default: 3)
HIERARCHICAL_MAX_DEPTH=3
# Maximum number of broadcast messages buffered per agent (default: 256; 0 = unlimited)
BROADCAST_BUFFER_SIZE=256
# When true, complex plan steps may call decompose_task to inject sub-steps at runtime
DYNAMIC_DECOMPOSITION_ENABLED=false
```

---

## Testing Approach

### Unit Tests (no LLM)

| Test file | What it covers |
|-----------|---------------|
| `joint-context.test.ts` | `InMemoryJointContextStore`: publish, readNew per-reader cursor, snapshot, empty-read idempotency |
| `message-bus.test.ts` | `MessageBus`: broadcast fan-out, subscribe/unsubscribe, drain clears queue, multiple channels |

### Integration Tests (MockChatModel)

All integration tests follow the existing pattern: inject `MockChatModel` from `src/testing/` with pre-baked response sequences (tool-call then text, or pure text).

| Test file | Scenario |
|-----------|---------|
| `manager-joint.test.ts` | Two agents; agent-A's second response reads agent-B's first message from the joint store; assert final `messageBoard` contains both agents' messages |
| `manager-hierarchical.test.ts` | Supervisor LLM issues `delegate_subagent` tool call; child LLM returns a text result; assert `HierarchicalResult.delegations` has one record with correct depth |
| `manager-hierarchical.test.ts` | Depth > `maxDelegationDepth` → tool returns error message; no child created |
| `manager-broadcast.test.ts` | Bus broadcasts a message mid-run; next iteration's system prompt includes the broadcast; assert `broadcastLog` non-empty |
| `dynamic-decomposition.test.ts` | Step LLM returns `decompose_task` call with two new steps; `ExecutionResult.stepResults` has original step + two new steps |
| `dynamic-decomposition.test.ts` | `DYNAMIC_DECOMPOSITION_ENABLED=false` → `decompose_task` tool not injected; LLM tool call results in "Tool not found" message |

### Existing Test Compatibility

- `src/__tests__/index.test.ts` — no changes; existing `bindTools` mock is unaffected
- `src/subagents/__tests__/manager.test.ts` — `runParallel` behaviour unchanged; add `runJoint` tests in separate file
- `src/orchestrator.ts` tests — the mutable-steps change must not break existing resumeFrom / checkpoint / retry behaviour; add regression assertions for step count stability when decompose tool is absent

---

## Acceptance Criteria

### Functional

- [ ] `SubagentManager.runJoint(tasks)` executes tasks concurrently with a shared `InMemoryJointContextStore`; messages published by one agent appear in peer agents' subsequent LLM calls
- [ ] `SubagentManager.runHierarchical(def, task)` allows a supervisor agent to call `delegate_subagent`; the call tree is captured in `HierarchicalResult.delegations`
- [ ] Delegation depth > `appConfig.hierarchicalMaxDepth` returns a structured error message as tool output and does not spawn a child agent
- [ ] `SubagentManager.runBroadcast(tasks, bus)` fans out bus messages to all subscribed agents; `BroadcastResult.broadcastLog` contains all sent messages
- [ ] `executePlan()` with a `"joint"` / `"hierarchical"` / `"broadcast"` step routes correctly to the corresponding manager method
- [ ] When `DYNAMIC_DECOMPOSITION_ENABLED=true`, a complex step can call `decompose_task`; the injected steps appear in `ExecutionResult.stepResults` in correct order after the decomposing step
- [ ] All four patterns respect the existing `concurrencyLimit` in `SubagentManager`
- [ ] Existing `runParallel` and sequential `executePlan` behaviour is fully preserved

### Non-Functional

- [ ] `InMemoryJointContextStore` and `MessageBus` are thread-safe within Node.js's single-threaded event loop (no shared mutable state accessed from concurrent microtask callbacks without guard)
- [ ] All new public interfaces are exported from `src/subagents/types.ts` (single import surface)
- [ ] `createDelegateTool` and `createDecomposeTool` are **not** added to `ToolRegistry.loadFromDirectory()` auto-discovery — they are always created programmatically
- [ ] New config keys documented in `.env.example` with units and defaults
- [ ] `npx jest` passes with no regressions
- [ ] All new files pass the existing linter (`npm run lint` or equivalent)

### Documentation

- [ ] `README.md` updated with a "Multi-Agent Collaboration Patterns" section describing all four patterns with minimal usage examples
- [ ] JSDoc on all new public types and methods, matching the existing documentation density in `src/subagents/types.ts` and `src/subagents/manager.ts`

---

## Out of Scope

- Persistent cross-run message boards (e.g. Redis-backed `JointContextStore`) — the interface is designed to be pluggable but only the in-memory implementation ships in this issue
- Network-based agent-to-agent communication — all coordination is in-process
- UI / TUI visualisation of agent collaboration graphs — tracked separately
- LangGraph / LangChain graph-based orchestration — `agentloop` keeps its own imperative runtime; the patterns here are implemented natively without adopting LangGraph's state-machine model
