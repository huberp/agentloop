# Agentloop LangGraph Log Protocol Assessment

**Reference:** `huberp/agentloop` · run `24935457632` · job `73020142658` step 6  
**Sorted by:** criticality (Critical → High → Medium → Low)

---

## CRITICAL

---

### C-1 · Explorer Prompt Hardcodes Multi-Language Config File List → Blind Probing of Non-Existent Files

**Log evidence** (lines 193, 197-204):
```
iteration 2: toolCallCount=11, toolCalls=[
  {file-read, package.json},
  {file-read, jest.e2e.config.js},
  {file-read, tsconfig.json},
  {file-read, Cargo.toml},        ← ENOENT
  {file-read, pyproject.toml},    ← ENOENT
  {file-read, go.mod},            ← ENOENT
  {file-read, build.gradle},      ← ENOENT
  {file-read, build.gradle.kts},  ← ENOENT
  {file-read, pom.xml},           ← ENOENT
  {file-read, CMakeLists.txt},    ← ENOENT
  {file-read, CMakePresets.json}  ← ENOENT
]
```

7 out of 11 tool calls in the second explorer iteration are ENOENT errors. The file-list call in iteration 1 already provided a complete directory tree containing no Rust/Python/Go/Java/C++ artifacts whatsoever.

**Root cause** — `src/agents/project-explorer.ts:34-36`:
```ts
`2. Identify key project files (package.json, Cargo.toml, CMakeLists.txt, CMakePresets.json, ` +
`build.gradle, build.gradle.kts, pom.xml, go.mod, pyproject.toml, requirements.txt, Makefile, etc.).\n` +
`3. Call file-read on each identified key file…`
```

The instruction says "identify… then read each identified key file" — but the LLM interprets this as "the list in step 2 is the identification; now read ALL of them", bypassing the file-list output entirely. The system prompt enumeration of every possible language's build file is treated as a mandatory checklist rather than an example of what to look for.

**Connection to user's observation:** The user noticed "file-list seems to list the files of the ignore list". The confusion arises because `DEFAULT_EXCLUDE_DIRS` in `file-list.ts` contains language-specific build artifact directories (`target` for Rust/Maven, `.venv` for Python, etc.) and the explorer system prompt enumerates the same language ecosystem's config files (`Cargo.toml`, `pyproject.toml`, etc.). The two lists are mirror images of each other — one lists excluded output directories, the other lists the corresponding source config files — making it look like the file-list result drove the probe attempts.

**Structural problem:** The explorer's system prompt enumerates filenames, not a detection strategy. The LLM lacks the reasoning step "check file-list output FIRST; only read files that APPEARED in the listing."

**Actionable fixes:**
1. **Change the prompt instruction** from listing specific filenames to specifying the heuristic: *"Scan the file-list output for build system configuration files (e.g., files named `package.json`, `Cargo.toml`, `pom.xml`, etc.). Only call `file-read` on files that actually appeared in the file-list result."*
2. **Add an explicit guard in the prompt:** `"Do NOT attempt to read a file unless you saw it in the file-list output."`
3. **Medium-term fix:** Pre-filter the file-list result in `exploreWorkspace()` code before giving it to the LLM — pass only the list of known build-system config files that actually appear in the listing to a simpler prompt.

---

### C-2 · LLM Hallucinated Wrong Repository URL (Step s2)

**Log evidence** (lines 217-224):
```
iteration 1: shell → git clone https://github.com/alfred-ai-research/alfred.git .
→ SCHEMA ERROR (array instead of string, see H-3)
iteration 2: shell → git clone https://github.com/alfred-ai-research/alfred.git .
→ "fatal: destination path '.' already exists and is not an empty directory."
iteration 3: shell → ls -la
iteration 4: output "The workspace already contains a repository…"
```

The agent cloned `alfred-ai-research/alfred` — a completely unrelated repository from the LLM's training data — instead of the user's actual repo `huberp/agentloop`. The request said "add Anthropic models to **github repo huberp/agentloop**" but the step context for s2 only got the description "Clone the forked repository locally to the workspace" with no URL grounding.

**Root cause** — `src/langgraph/step-runner.ts:103-111`: The step system prompt is:
```ts
`Step: ${node.description}\n`
```

The plan node's `description` is "Clone the forked repository locally to the workspace" — no URL, no repo name. The step LLM hallucinates a plausible-sounding URL from training memory.

The execution was "saved" only because the workspace was already populated (making git clone fail). In a clean CI environment or if the workspace had been different, the wrong repo would have been cloned and all subsequent file edits would corrupt it.

**Structural problem:** There is no mechanism to pass the original request's named entities (repo URL, specific versions, etc.) down to individual plan steps. The planner LLM knows the full request but each step only gets its `description` string. Critical parameters are lost at compile time.

**Actionable fixes:**
1. **Inject the original `state.request`** into every step's system prompt: `"Original user request (for context): ${state.request}"`.
2. **Require the planner** to embed concrete values (URLs, package names) in step descriptions: add to `BLOCKS_PLANNER_SYSTEM` — *"Include all concrete values (URLs, file paths, version numbers) needed to execute the step in the step description itself."*
3. **Tool-level fix for shell:** Validate git clone target URLs against an allowlist or at least log a warning when a clone target is not the workspace's own remote.

---

### C-3 · Semantic Step Failures Silently Recorded as "Success" (Step s1)

**Log evidence** (lines 214-215):
```
iteration 1: toolCallCount=0, toolCalls=[]
output: "I cannot directly fork a repository or perform GitHub actions like forking.
         However, you can manually fork the repository by following these steps:…"
→ recorded as "success", graph proceeds to s2
```

Step s1 was "Fork the huberp/agentloop repository". The LLM explicitly states it cannot perform this action and outputs human-directed instructions instead. No exception was raised, so `runSubagent()` completed normally. `runPlannedStep()` in `step-runner.ts` returns `{ status: "success", output: "I cannot…" }`. The graph records s1 as succeeded and all s2–sN proceed on the false premise that forking was done.

**Root cause** — `src/langgraph/step-runner.ts:130-136`:
```ts
return {
  status: "success",
  output: result.output,
  …
};
```

Success is defined as "no exception thrown". There is no semantic validation that the step actually accomplished anything. The text "I cannot" is treated identically to "Done."

**Structural problem:** The LangGraph execution model delegates success/failure entirely to exception propagation. LLMs that gracefully decline or produce partial outputs appear indistinguishable from steps that succeeded.

**Actionable fixes:**
1. **Marker-based failure detection** (symmetric with the existing `REPLAN_MARKERS`): Add a `STEP_FAILED_MARKERS` list (`["I cannot", "I am unable", "I don't have the ability", "cannot perform"]`) and check the output — if matched, return `status: "failed"`.
2. **Structured step output format:** Instruct steps to respond with JSON `{ "status": "done" | "failed" | "blocked", "summary": "…" }`. This is more reliable than marker scanning.
3. **Self-evaluation pass:** After each step, run a quick LLM call that asks "Did this output complete the task described? Yes/No" — cheap single-turn with no tools.

---

## HIGH

---

### H-1 · Parallel Branches s4 + s5 Both Mutate `package.json` Concurrently Without Resource Locks

**Log evidence** (lines 230-240):
```
runnable: ["p1.b0.s4", "p1.b1.s5"]   ← dispatched simultaneously

s4 (npm install @anthropic-ai/sdk):
  → npm error ETARGET No matching version found for @anthropic-ai/sdk@^0.25.3
  → retry: npm install @anthropic-ai/sdk@latest → installed

s5 (file-edit package.json, adding @anthropic-ai/sdk ^0.25.3):
  → success (wrote stale/conflicting version string)
```

Both steps ran in parallel and both modified `package.json`. `npm install @latest` rewrote the lockfile and `package.json` at the same time as `file-edit` inserted `^0.25.3`. The result is a `package.json` with `^0.25.3` in `dependencies` but `@latest` in `node_modules` (and possibly the lockfile) — an inconsistent state.

**Root cause:** The scheduler in `src/langgraph/scheduler.ts` has a correct `file:write:` locking mechanism, but it is entirely inert here because the planner LLM never emitted `resources: ["file:WRITE:package.json"]` hints in the plan. The scheduler can only protect what is declared.

**Structural problem:** Resource hints are purely advisory and LLM-generated. The planner has no enforced obligation to declare them, and the schema hint in `BLOCKS_PLAN_SCHEMA_HINT` only shows them as an example. The consequence is that the entire write-conflict protection system is silently bypassed whenever the planner omits `resources`.

**Actionable fixes:**
1. **Add npm-install to serial-only steps:** Instruct the planner explicitly — *"Steps that run `npm install`, `pip install`, `cargo build`, or any package manager command must never be parallelised with steps that edit the corresponding manifest file."* Add this as a hard constraint in `BLOCKS_PLANNER_SYSTEM`.
2. **Infer file locks from `toolsNeeded`:** In `compileBlocksPlanToDag`, if `toolsNeeded` contains `file-edit` or `file-write`, mark the step as potentially writing to files and prevent its parallelisation with npm-install steps automatically.
3. **Post-plan validation:** After the planner produces the plan, validate that no parallel branch pair contains one npm-install-like step and one file-edit step without a declared resource lock, and trigger refinement if so.

---

### H-2 · `isDeadlocked` Imported but Never Called → Infinite Loop on Deadlock

**Code evidence** — `src/langgraph/graph.ts:32`:
```ts
import { selectRunnable, getCancellableForRace, isAllDone, isDeadlocked } from "./scheduler";
```

`isDeadlocked` is imported but never used in any node function or routing condition. The conditional router after `handle_outcomes` is:
```ts
if (state.done) return "finalize";
if (state.replanRequested) return "maybe_replan";
return "select_runnable";  // ← always falls through here
```

If a deadlock occurs (e.g., all pending nodes have dependencies on failed nodes, `replanRequested` is false, and `done` is false), the graph enters an infinite loop: `select_runnable → execute_batch (empty) → handle_outcomes → select_runnable…`.

**Actionable fixes:**
1. **Use the already-imported function** in the routing conditional:
   ```ts
   if (state.done) return "finalize";
   if (state.replanRequested) return "maybe_replan";
   if (isDeadlocked(state.compiledPlan!, state.records, {
     maxConcurrency: state.maxConcurrency,
     networkConcurrency: state.networkConcurrency
   })) {
     // set fatalError or trigger replan
     return "finalize";
   }
   return "select_runnable";
   ```
2. **Add a deadlock guard node** or guard in `handle_outcomes` that sets `done: true, fatalError: "deadlock"` when no progress is possible.

---

### H-3 · Shell Tool Schema Mismatch — LLM Repeatedly Passes Arrays

**Log evidence** (lines 218, 244):
```
s2 iteration 1: shell({ command: ["git", "clone", "…", "."] })
→ "Expected string, received array → at command"
→ retry needed

s7 iteration 1: shell({ command: ["mkdir", "-p", "src/models/anthropic"] })
→ same schema error
→ retry needed
```

The shell tool schema clearly requires a string, but the LLM was trained on OpenAI-style function-calling conventions where many shell tools accept `["cmd", "arg1", "arg2"]` array form. This hit twice in a single run.

**Root cause** — `src/tools/shell.ts:20`:
```ts
command: z.string().describe("Shell command to execute (split by whitespace; no shell expansion)")
```

The description says "split by whitespace" which is about how the command is _executed_, not the _input format_. This may confuse the LLM into thinking an array is accepted.

**Actionable fixes:**
1. **Improve the schema description:** Change to `"A single string shell command, e.g. 'git clone https://… dest'. Do NOT pass an array."` — the negative example prevents array attempts.
2. **Add a Zod preprocessor** that coerces arrays to joined strings: `z.preprocess((v) => Array.isArray(v) ? v.join(" ") : v, z.string())` — eliminates the need for a retry entirely.

---

## MEDIUM

---

### M-1 · `MemorySaver` and Graph Rebuilt from Scratch on Every `invokeGraph` Call

**Code location** — `src/langgraph/graph.ts:550-555`:
```ts
export async function invokeGraph(request, deps, opts) {
  const graph = buildGraph(deps, opts);  // ← new StateGraph + new MemorySaver every call
  …
}
```

Each invocation creates a brand-new `StateGraph`, compiles it, and instantiates a new `MemorySaver`. The in-memory checkpointer is discarded when the function returns. This means:
- A mid-execution crash loses all completed step results.
- Multi-turn conversations can't resume from where they left off.
- The `MemorySaver` checkpointing machinery is entirely wasted in practice.

**Actionable fixes:**
1. **Hoist MemorySaver** to module scope (or inject via `GraphDeps`), so the compiled graph and checkpointer persist for the process lifetime.
2. **Reuse the compiled graph** across calls by memoizing in `getActiveExecutor()` in `src/index.ts` (which already memoizes the executor adapter).
3. **Longer term:** Switch to `SqliteSaver` or a persistent store for production checkpointing.

---

### M-2 · Step Output Truncated to 500 Characters in `sharedContext`

**Code location** — `src/langgraph/graph.ts:329`:
```ts
stepOutputs[r.nodeId] = r.output.slice(0, 500);
```

When later steps reference prior step output (e.g., step s8 uses the output of s4 to determine what SDK version was installed), only the first 500 characters are available. Complex step outputs (TypeScript code, npm install summaries, file read results) routinely exceed this. The truncation is silent — the receiving step LLM gets no indication the context is incomplete.

**Actionable fixes:**
1. **Increase the limit** or make it configurable via `appConfig`.
2. **Add a truncation marker:** Append `"… [truncated]"` so downstream steps know the context is incomplete.
3. **Structured output:** Instead of raw text, have steps output a JSON summary object — the LLM can then produce a compact structured output more reliably within budget.

---

### M-3 · Planner Has No Mechanism to Prevent "Fork/Clone" Class of Impossible Steps

**Log evidence** (lines 210-215): The planner generated a step "Fork the huberp/agentloop repository to create a personal copy" as a plan node with `toolsNeeded: ["web_fetch"]`. The planning agent had no means of knowing the executing agent can't actually make GitHub API calls to fork repositories.

**Root cause** — `src/langgraph/graph.ts:157`: The planner is only told `availableTools` names, not their capabilities or limitations. `web_fetch` is a tool for reading pages; the planner extrapolated it could also trigger GitHub fork actions.

**Actionable fixes:**
1. **Add tool descriptions to the planner context**: Instead of just tool names, pass each tool's `description` field so the planner knows what each tool actually does.
2. **Add a "capabilities" section to the planner prompt**: Explicitly state what the agent ecosystem cannot do (e.g., "Cannot create GitHub PRs, forks, or OAuth flows").

---

### M-4 · Resource Hint Case Mismatch Between Schema Example and Code

**Code locations:**
- `src/langgraph/graph.ts:96`: schema hint shows `"resources": ["file:WRITE:path"]` (uppercase)
- `src/langgraph/compiler.ts:177`: normalises to lowercase: `.trim().toLowerCase()`
- `src/langgraph/scheduler.ts:22`: checks `r.startsWith("file:write:")` (lowercase)

The round-trip works by accident (normalisation fixes it), but the planner LLM is shown the uppercase form in its schema hint. If the normalisation step is ever removed or the check is updated carelessly, this silently breaks.

**Actionable fix:** Standardise to lowercase in the schema hint: `"resources": ["file:write:path"]` and document the convention.

---

## LOW

---

### L-1 · `parsePlanOutput` Is Brittle Against Trailing Code Fences in the Middle

**Code location** — `src/langgraph/graph.ts:141`:
```ts
const stripped = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
```

This only strips a single leading and trailing fence. If the LLM emits text before or after the JSON block, or uses nested fences, the `JSON.parse` will throw and trigger the planner error path.

**Actionable fix:** Use a more robust extraction that finds the first `{` and the matching last `}`:
```ts
const jsonStart = text.indexOf("{");
const jsonEnd = text.lastIndexOf("}");
JSON.parse(text.slice(jsonStart, jsonEnd + 1));
```

---

### L-2 · Plan Version Check Rejects Any Variation of "2.0"

**Code location** — `src/langgraph/compiler.ts:30`:
```ts
if (p.version !== "2.0") throw new Error(`Unsupported plan version: ${String(p.version)}`);
```

If the LLM emits `"version": "2"`, `"version": "v2.0"`, or even `"version": 2` (number), the plan is rejected. Since the planner prompt instructs `"version must be \"2.0\""`, this usually works, but a single hallucination here forces a full replan cycle.

**Actionable fix:** Accept `String(p.version).startsWith("2")` or coerce with `String(p.version).replace(/^v/, "")`.

---

### L-3 · `file-list` `target` in `DEFAULT_EXCLUDE_DIRS` Hides Valid Project Subdirectories

**Code location** — `src/tools/file-list.ts:19`:
```ts
"target",       // Rust / Maven
```

`target` is an extremely common directory name used by non-Maven/Cargo projects (e.g., `target/` as a docs output folder, Bazel's `bazel-out/target/`, some npm setups). Silently skipping it without any log warning makes it impossible to debug missing entries.

**Actionable fix:** Log a debug message when a directory is excluded: `logger.debug({ excluded: entry.name }, "file-list: skipping excluded directory")`. Consider making it opt-in via a `defaultExclude: false` flag.

---

## Summary Table

| ID | Severity | Area | Description |
|----|----------|------|-------------|
| C-1 | **Critical** | `project-explorer.ts` | Explorer blindly probes all multi-language config files regardless of file-list output → 7 ENOENT errors per run |
| C-2 | **Critical** | `step-runner.ts` / planner | LLM hallucinated wrong repo URL (alfred.git) due to missing request context in step prompts |
| C-3 | **Critical** | `step-runner.ts` | Semantic failures ("I cannot…") recorded as success; graph continues on false premises |
| H-1 | **High** | `scheduler.ts` / planner | Parallel branches write same file without resource locks; LLM rarely emits `resources` hints |
| H-2 | **High** | `graph.ts` | `isDeadlocked` imported but never used → infinite loop possible on deadlock |
| H-3 | **High** | `shell.ts` | LLM repeatedly calls shell with array schema; schema description misleads; wastes iterations |
| M-1 | **Medium** | `graph.ts` | Graph and MemorySaver rebuilt each invocation; checkpointing wasted |
| M-2 | **Medium** | `graph.ts` | Step outputs truncated to 500 chars in sharedContext without marker |
| M-3 | **Medium** | `graph.ts` planner | Planner not told tool limitations; generates unexecutable steps (GitHub fork, clone) |
| M-4 | **Medium** | `compiler.ts` / `graph.ts` | Resource hint uppercase in schema but normalised to lowercase in code |
| L-1 | **Low** | `graph.ts` | `parsePlanOutput` brittle against non-standard fence placement |
| L-2 | **Low** | `compiler.ts` | Plan version check strict-equals "2.0" |
| L-3 | **Low** | `file-list.ts` | `target` directory silently excluded with no diagnostic log |
