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

## Layer 2 — Programmatic: Trigger the Planner

`generatePlan()` runs a specialised planning subagent and returns a structured `Plan` — a
list of steps, each with required tools and a complexity estimate (`low` / `medium` / `high`).

```ts
import { generatePlan, validatePlan } from "./src/subagents/planner";
import { analyzeWorkspace } from "./src/workspace";
import { toolRegistry } from "./src/index";

const workspaceInfo = await analyzeWorkspace(".");

const plan = await generatePlan(
  "Add a REST endpoint that returns recent git log as JSON",
  workspaceInfo,
  toolRegistry
);

// plan.steps: Array<{ description, toolsNeeded, estimatedComplexity }>
plan.steps.forEach((step, i) => {
  console.log(`${i + 1}. [${step.estimatedComplexity}] ${step.description}`);
  console.log("   tools:", step.toolsNeeded.join(", "));
});
```

Example output:
```
1. [low]    Read the existing routes file to understand the current structure
   tools: file-read
2. [medium] Search for the git-log tool usage pattern
   tools: code-search
3. [medium] Write the new endpoint handler
   tools: file-edit
4. [low]    Run the test suite to verify nothing is broken
   tools: code-run
```

Validate before executing to catch references to unregistered tools:

```ts
const validation = validatePlan(plan, toolRegistry);
if (!validation.valid) {
  console.error("Unknown tools in plan:", validation.invalidTools);
}
```

---

## Layer 2 — Programmatic: Execute a Plan

`executePlan()` takes a `Plan` and runs each step as a subagent in sequence, with
checkpointing and configurable failure handling.

```ts
import { executePlan } from "./src/orchestrator";
import { toolRegistry } from "./src/index";

const result = await executePlan(plan, toolRegistry, {
  onStepFailure: "retry",  // "retry" | "skip" | "abort"
});

for (const step of result.stepResults) {
  const icon = step.status === "success" ? "✓" : step.status === "skipped" ? "–" : "✗";
  console.log(`${icon} Step ${step.stepIndex + 1}: ${step.description}`);
  if (step.error) console.log("  Error:", step.error);
}
console.log("Overall success:", result.success);
```

### Resuming after a failure

```ts
import { executePlan, InMemoryCheckpointStore } from "./src/orchestrator";
import { toolRegistry } from "./src/index";

const store = new InMemoryCheckpointStore();

// First run — fails at step 3
await executePlan(plan, toolRegistry, { checkpoint: store, onStepFailure: "abort" });

// Resume from step 3 (1-based), skipping already-completed steps
const result = await executePlan(plan, toolRegistry, { resumeFrom: 3, checkpoint: store });
```

---

## Layer 2 — Programmatic: Parallel Subagents

`SubagentManager.runParallel()` runs multiple subagents concurrently using `Promise.allSettled`.
A `concurrencyLimit` caps simultaneous execution; excess tasks queue automatically.

```ts
import { SubagentManager } from "./src/subagents/manager";
import { toolRegistry } from "./src/index";

const manager = new SubagentManager(3, toolRegistry); // max 3 concurrent

const { results, conflicts } = await manager.runParallel([
  {
    definition: { name: "lint-checker", tools: ["code-search", "file-read"], maxIterations: 5 },
    task: "Find all usages of console.log in src/ and list them",
  },
  {
    definition: { name: "test-analyser", tools: ["file-read", "code-search"], maxIterations: 5 },
    task: "Count how many test files exist under src/__tests__",
  },
  {
    definition: { name: "dep-auditor", tools: ["file-read"], maxIterations: 3 },
    task: "List direct production dependencies from package.json",
  },
]);

for (const res of results) {
  if ("error" in res) console.error(`[${res.name}] failed:`, res.error);
  else               console.log(`[${res.name}] →`, res.output.slice(0, 120));
}

if (conflicts.length > 0) {
  console.warn("File conflicts detected:");
  for (const c of conflicts) {
    console.warn(`  ${c.file} — modified by: ${c.agents.join(", ")}`);
  }
}
```

---

## Layer 2 — Combining Planner + Orchestrator (Full Flow)

```ts
import { generatePlan, validatePlan } from "./src/subagents/planner";
import { executePlan } from "./src/orchestrator";
import { analyzeWorkspace } from "./src/workspace";
import { toolRegistry } from "./src/index";

async function runTask(goal: string) {
  const workspaceInfo = await analyzeWorkspace(".");

  // 1. Generate a structured plan
  const plan = await generatePlan(goal, workspaceInfo, toolRegistry);

  // 2. Validate — abort early if unknown tools are referenced
  const validation = validatePlan(plan, toolRegistry);
  if (!validation.valid) {
    throw new Error(`Plan references unknown tools: ${validation.invalidTools.join(", ")}`);
  }

  // 3. Execute step-by-step; each step runs as an isolated subagent
  const result = await executePlan(plan, toolRegistry, {
    onStepFailure: "retry",
  });

  return result;
}

const result = await runTask("Add input validation to all POST handlers in src/routes/");
console.log("Success:", result.success);
result.stepResults.forEach(s =>
  console.log(`  ${s.stepIndex + 1}. ${s.status}: ${s.description}`)
);
```

---

## Bridging the Two Layers

To invoke the planner from a natural-language prompt, wrap it as a regular tool in `src/tools/`.
The agent loop auto-discovers any file in that directory that exports `toolDefinition`.

```ts
// src/tools/plan-and-run.ts  (already included in the default distribution)
import { z } from "zod";
import { generatePlan, validatePlan, refinePlan } from "../subagents/planner";
import { executePlan } from "../orchestrator";
import { analyzeWorkspace } from "../workspace";
import { appConfig } from "../config";
import { toolRegistry } from "./registry";
import type { ToolDefinition } from "./registry";

export const toolDefinition: ToolDefinition = {
  name: "plan-and-run",
  description: "Decompose a goal into steps using the planner, then execute each step.",
  permissions: "dangerous",
  schema: z.object({
    goal: z.string().describe("The high-level goal to plan and execute"),
    onStepFailure: z.enum(["retry", "skip", "abort"]).optional().default("retry"),
  }),
  async execute({ goal, onStepFailure = "retry" }) {
    const ws = await analyzeWorkspace(appConfig.workspaceRoot);
    let plan = await generatePlan(goal, ws, toolRegistry);
    let validation = validatePlan(plan, toolRegistry);
    if (!validation.valid) {
      plan = await refinePlan(goal, plan,
        `Unknown tools: ${validation.invalidTools.join(", ")}`,
        ws, toolRegistry);
      validation = validatePlan(plan, toolRegistry);
      if (!validation.valid)
        return `Plan failed — unknown tools: ${validation.invalidTools.join(", ")}`;
    }
    const result = await executePlan(plan, toolRegistry, { onStepFailure });
    return result.stepResults
      .map(s => `${s.status === "success" ? "✓" : "✗"} ${s.stepIndex + 1}: ${s.description}`)
      .join("\n");
  },
};
```

Once this file is in `src/tools/`, the agent loop auto-discovers it and the LLM can call it:

```
User: Plan and execute: add a health-check endpoint to the Express app
```
→ LLM calls `plan-and-run` → planner fires → orchestrator runs each step as a subagent

---

## Further Reading

- [architecture.md](architecture.md) — system diagrams for the agent loop, subagent architecture, and orchestrator
- [extending.md](extending.md) — add custom tools and subagent definitions
- [configuration.md](configuration.md) — all environment variables (iteration limits, concurrency, tracing, etc.)
- [testing.md](testing.md) — how to test code that uses subagents and the planner with `MockChatModel`
