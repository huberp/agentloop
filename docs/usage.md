# Usage Examples

This guide explains the two layers of AgentLoop and gives concrete examples for each.

For installation and first-run instructions see [getting-started.md](getting-started.md).

---

## The Two Layers

```
┌─────────────────────────────────────────────────────┐
│  Layer 1 — Agent Loop (CLI / agentExecutor)         │
│  Natural-language prompt → LLM → built-in tools     │
│  Triggered by: typing a prompt or calling invoke()  │
└─────────────────────────────────────────────────────┘
          ↕  programmatic call from your code
┌─────────────────────────────────────────────────────┐
│  Layer 2 — Planner / Subagents / Orchestrator       │
│  Structured APIs: generatePlan, runSubagent,        │
│  executePlan — NOT invoked by the LLM directly      │
└─────────────────────────────────────────────────────┘
```

> **Important:** `generatePlan()`, `runSubagent()`, and `executePlan()` are **programmatic APIs**.
> The main agent loop does _not_ call them automatically in response to a prompt.
> The way to activate focused behaviour from a prompt is via **agent profiles** (see [Layer 1 — Activating an Agent Profile](#layer-1--activating-an-agent-profile))
> or by exposing them as a custom tool (see [Bridging the Two Layers](#bridging-the-two-layers)).

---

## Layer 1 — Prompts That Drive the Agent Loop

Start the CLI with `npm run start` and type a prompt. The LLM decides which built-in tools to call.

### File operations

```
User: Show me the contents of src/index.ts
```
→ calls `file-read`

```
User: List all TypeScript files under src/tools
```
→ calls `file-list`

```
User: Create a file called notes.md with the content "TODO: write tests"
```
→ calls `file-write`

```
User: In src/config.ts, replace the string "localhost" with "0.0.0.0"
```
→ calls `file-edit`

### Code search

```
User: Find all places in src/ where MAX_ITERATIONS is referenced
```
→ calls `code-search` (literal match)

```
User: Search for any async function that takes a string parameter
```
→ calls `code-search` (regex)

### Git

```
User: What files have uncommitted changes in this repo?
```
→ calls `git-status`

```
User: Show me the diff for src/orchestrator.ts
```
→ calls `git-diff`

```
User: What were the last five commits?
```
→ calls `git-log`

### Running code

```
User: Run the test suite and tell me if there are failures
```
→ calls `code-run` (runs `npm test`)

```
User: Execute "node -e 'console.log(process.version)'" and tell me the Node version
```
→ calls `shell`

### Multi-step tasks (the loop iterates automatically)

The agent loop continues calling tools until the LLM produces a response with no tool calls —
you don't need to break a task up yourself.

```
User: Find the function called trimMessages, read the file it lives in, then summarise what it does
```
→ `code-search` → `file-read` → final answer  (2 iterations)

```
User: Check git status, show the diff for any changed files, then commit with message "chore: fix typo"
```
→ `git-status` → `git-diff` → `git-commit`  (3 iterations)

---

## Layer 1 — Activating an Agent Profile

Agent profiles restrict the tool set, set a custom temperature, and optionally select a different
model — all applied per-invocation without touching the agent loop itself.

Built-in profiles: `planner`, `coder`, `reviewer`, `devops`, `security-auditor`.

Pass the profile name as the second argument to `agentExecutor.invoke()`:

```ts
import { agentExecutor } from "./src/index";

// "planner" profile — tools: file-read, file-write, file-list, code-search
//                     temperature: 0.7, maxIterations: 10
const result = await agentExecutor.invoke(
  "Break down the task of adding OAuth2 support into actionable steps",
  "planner"
);
console.log(result.output);
```

```ts
// "coder" profile — tools: file-read, file-write, file-edit, code-run, code-search, shell, …
//                   temperature: 0.2  (more deterministic), maxIterations: 20
const result = await agentExecutor.invoke(
  "Add input validation to the createUser function in src/routes/users.ts",
  "coder"
);
```

```ts
// "reviewer" profile — tools: file-read, file-list, code-search, git-diff, git-log, git-status
//                      temperature: 0.3
const result = await agentExecutor.invoke(
  "Review the changes in src/streaming.ts and flag any issues",
  "reviewer"
);
```

The profile limits which tools the LLM can call and how focused it is.
It does **not** change the underlying loop — the LLM still chooses which tools to invoke.

---

## Streaming Responses

Set `STREAMING_ENABLED=true` in `.env`, then use `stream()` to receive tokens as they arrive:

```ts
import { agentExecutor } from "./src/index";

for await (const chunk of agentExecutor.stream("Explain the orchestrator architecture")) {
  process.stdout.write(chunk);
}
```

Profiles work with streaming too:

```ts
for await (const chunk of agentExecutor.stream(
  "Review src/streaming.ts and flag any issues",
  "reviewer"
)) {
  process.stdout.write(chunk);
}
```

---

## Layer 2 — Programmatic: Spin Off a Subagent

Call `runSubagent()` from code when you want an isolated, focused agent loop with a
restricted tool set. The subagent has its own message history, separate from the parent.

```ts
import { runSubagent } from "./src/subagents/runner";
import { toolRegistry } from "./src/index"; // the loaded singleton registry

const result = await runSubagent(
  {
    name: "doc-extractor",
    tools: ["file-read", "code-search"],  // only these tools are accessible
    maxIterations: 5,
  },
  "List all exported function signatures from src/orchestrator.ts",
  toolRegistry
);

console.log(result.output);
// "Exported: executePlan(plan, registry, options?): Promise<ExecutionResult>
//            InMemoryCheckpointStore ..."
console.log("Iterations:", result.iterations);
```

### Injecting shared read-only context

Pass `sharedContext` to surface additional facts inside the subagent's system prompt:

```ts
const result = await runSubagent(
  {
    name: "reviewer",
    tools: ["file-read"],
    maxIterations: 8,
    sharedContext: {
      pullRequestTitle: "Add streaming support",
      targetBranch: "main",
    },
  },
  "Review the changes in src/streaming.ts and summarise risks",
  toolRegistry
);
```

---

## Further Reading

- [architecture.md](architecture.md) — system diagrams for the agent loop, LangGraph engine, and subagent architecture
- [extending.md](extending.md) — add custom tools and subagent definitions
- [configuration.md](configuration.md) — all environment variables (iteration limits, concurrency, tracing, etc.)
- [testing.md](testing.md) — how to test code that uses subagents with `MockChatModel`
