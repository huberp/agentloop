# Usage Examples

This guide covers advanced programmatic usage: working with subagents, the planner, the orchestrator, parallel execution, and streaming.

For installation and first-run instructions see [getting-started.md](getting-started.md).

---

## Basic Invocation

```ts
import { agentExecutor } from "./src/index";

const result = await agentExecutor.invoke("What files are in src/tools?");
console.log(result.output);
```

---

## Streaming Responses

When `STREAMING_ENABLED=true` in `.env`, use `stream()` to receive tokens as they arrive:

```ts
import { agentExecutor } from "./src/index";

for await (const chunk of agentExecutor.stream("Explain the orchestrator architecture")) {
  process.stdout.write(chunk);
}
```

You can also call the streaming variant directly:

```ts
import { executeWithToolsStream } from "./src/index";
import { ToolRegistry } from "./src/tools/registry";
import { createLLM } from "./src/llm";
import { appConfig } from "./src/config";

const registry = new ToolRegistry();
// ... register tools ...
const llm = createLLM(appConfig);

for await (const chunk of executeWithToolsStream("Summarise recent git changes", [], llm)) {
  process.stdout.write(chunk);
}
```

---

## Running a Subagent

A subagent is an isolated agent loop with its own message history and a restricted set of tools. Use `runSubagent()` when you want to delegate a focused task without exposing the full tool set.

```ts
import { runSubagent } from "./src/subagents/runner";
import { ToolRegistry } from "./src/tools/registry";
import { appConfig } from "./src/config";

// Build (or re-use) a parent registry that has all tools loaded
const registry = new ToolRegistry();
await registry.loadFromDirectory("./src/tools");

// Run a subagent that may only use file-read and code-search
const result = await runSubagent(
  {
    name: "file-inspector",
    tools: ["file-read", "code-search"],
    maxIterations: 5,
  },
  "Find all exported function names in src/orchestrator.ts",
  registry
);

console.log(result.output);
console.log("Iterations used:", result.iterations);
console.log("Files read:", result.filesModified);
```

### Injecting shared read-only context

Pass a `sharedContext` object to make additional facts available inside the subagent's system prompt (read-only):

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
  registry
);
```

---

## Generating a Plan

`generatePlan()` uses a specialised LLM subagent to decompose a high-level goal into a structured list of steps, each annotated with the tools it needs and an estimated complexity.

```ts
import { generatePlan, validatePlan } from "./src/subagents/planner";
import { ToolRegistry } from "./src/tools/registry";
import { analyzeWorkspace } from "./src/workspace";

const registry = new ToolRegistry();
await registry.loadFromDirectory("./src/tools");

const workspaceInfo = await analyzeWorkspace(".");

const plan = await generatePlan(
  "Add a new REST endpoint that returns git log as JSON",
  workspaceInfo,
  registry
);

console.log("Steps:", plan.steps.length);
plan.steps.forEach((step, i) => {
  console.log(`${i + 1}. [${step.estimatedComplexity}] ${step.description}`);
  console.log("   Tools:", step.toolsNeeded.join(", "));
});
```

### Validating a plan before execution

```ts
import { validatePlan } from "./src/subagents/planner";

const validation = validatePlan(plan, registry);
if (!validation.valid) {
  console.error("Plan references unknown tools:", validation.invalidTools);
}
```

---

## Executing a Plan

`executePlan()` takes a validated `Plan` and runs each step in order, spawning a subagent per step with an iteration budget derived from its `estimatedComplexity` (low → 3, medium → 5, high → 10).

```ts
import { generatePlan } from "./src/subagents/planner";
import { executePlan } from "./src/orchestrator";
import { ToolRegistry } from "./src/tools/registry";
import { analyzeWorkspace } from "./src/workspace";

const registry = new ToolRegistry();
await registry.loadFromDirectory("./src/tools");
const workspaceInfo = await analyzeWorkspace(".");

const plan = await generatePlan("Refactor calculateTax to use a lookup table", workspaceInfo, registry);

const result = await executePlan(plan, registry, {
  failureStrategy: "retry",   // "retry" | "skip" | "abort"
  maxRetries: 2,
});

for (const step of result.stepResults) {
  const icon = step.status === "success" ? "✓" : step.status === "skipped" ? "–" : "✗";
  console.log(`${icon} Step ${step.stepIndex + 1}: ${step.description}`);
  if (step.error) console.log("  Error:", step.error);
}
console.log("Overall success:", result.success);
```

### Resuming after a failure

When execution is interrupted, pass `resumeFrom` and a `checkpointStore` to skip already-completed steps:

```ts
import { executePlan, InMemoryCheckpointStore } from "./src/orchestrator";

const store = new InMemoryCheckpointStore();

// First run — may fail at step 3
await executePlan(plan, registry, { checkpointStore: store, failureStrategy: "abort" });

// Resume from step 3 (1-based)
const result = await executePlan(plan, registry, {
  resumeFrom: 3,
  checkpointStore: store,
});
```

---

## Parallel Subagents

`SubagentManager.runParallel()` runs multiple subagents concurrently using `Promise.allSettled`. A configurable `concurrencyLimit` caps how many run simultaneously; excess tasks are queued.

```ts
import { SubagentManager } from "./src/subagents/manager";
import { ToolRegistry } from "./src/tools/registry";

const registry = new ToolRegistry();
await registry.loadFromDirectory("./src/tools");

const manager = new SubagentManager(
  3,        // concurrencyLimit: at most 3 subagents running at once
  registry
);

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
  if ("error" in res) {
    console.error(`[${res.name}] failed:`, res.error);
  } else {
    console.log(`[${res.name}] →`, res.output.slice(0, 120));
  }
}

if (conflicts.length > 0) {
  console.warn("File conflicts detected:");
  for (const c of conflicts) {
    console.warn(`  ${c.file} — modified by: ${c.agents.join(", ")}`);
  }
}
```

---

## Using the SubagentManager for Sequential Tasks

`SubagentManager.run()` also works for a single subagent and automatically enforces the concurrency limit — useful when you fire multiple tasks from different call sites:

```ts
const manager = new SubagentManager(2, registry);

const [docResult, testResult] = await Promise.all([
  manager.run(
    { name: "doc-writer", tools: ["file-read", "file-write"], maxIterations: 8 },
    "Generate a JSDoc comment for every exported function in src/orchestrator.ts"
  ),
  manager.run(
    { name: "test-writer", tools: ["file-read", "file-write"], maxIterations: 8 },
    "Write a Jest test file for src/orchestrator.ts covering executePlan"
  ),
]);

console.log("Docs:", docResult.output);
console.log("Tests:", testResult.output);
```

---

## Combining Planner + Orchestrator

The typical end-to-end flow for a complex task:

```ts
import { generatePlan, validatePlan } from "./src/subagents/planner";
import { executePlan } from "./src/orchestrator";
import { ToolRegistry } from "./src/tools/registry";
import { analyzeWorkspace } from "./src/workspace";

async function runTask(goal: string) {
  const registry = new ToolRegistry();
  await registry.loadFromDirectory("./src/tools");
  const workspaceInfo = await analyzeWorkspace(".");

  // 1. Generate a structured plan
  const plan = await generatePlan(goal, workspaceInfo, registry);

  // 2. Validate — abort if unknown tools are referenced
  const validation = validatePlan(plan, registry);
  if (!validation.valid) {
    throw new Error(`Plan references unknown tools: ${validation.invalidTools.join(", ")}`);
  }

  // 3. Execute
  const result = await executePlan(plan, registry, {
    failureStrategy: "retry",
    maxRetries: 1,
  });

  return result;
}

const result = await runTask("Add input validation to all POST handlers in src/routes/");
console.log("Success:", result.success);
result.stepResults.forEach(s => console.log(`  ${s.stepIndex + 1}. ${s.status}: ${s.description}`));
```

---

## Further Reading

- [architecture.md](architecture.md) — system diagrams for the agent loop, subagent architecture, and orchestrator
- [extending.md](extending.md) — add custom tools and subagent definitions
- [configuration.md](configuration.md) — all environment variables (iteration limits, concurrency, tracing, etc.)
- [testing.md](testing.md) — how to test code that uses subagents and the planner with `MockChatModel`
