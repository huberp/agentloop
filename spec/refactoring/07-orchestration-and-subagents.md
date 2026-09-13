# Phase 7 — Orchestration & Subagents

## Objective

Port the multi-step `Orchestrator` / `Planner` and parallel `SubagentManager` to Python using **PydanticAI's built-in "agent as tool" multi-agent delegation pattern** and `asyncio`. Remove LangGraph entirely.

---

## Background

### Current Architecture

```
src/langgraph/          LangGraph-based orchestrator
src/subagents/          SubagentManager.runParallel()
src/orchestrator.ts     executePlan() — ties everything together
```

LangGraph is used only for the multi-step orchestration path. The default path already uses a custom `executePlan()` loop.

### PydanticAI Built-Ins Used

| Built-in | Replaces |
|---|---|
| **"Agent as tool"** — delegate agent called inside a parent `@agent.tool` | LangGraph `StateGraph` + custom `executePlan()` node dispatch |
| `ctx.usage` propagation to delegate `.run()` | Manual token tracking across agent calls |
| `UsageLimits` passed to delegate runs | Per-subagent cost / token caps |
| `asyncio.gather()` over delegate `.run()` calls | `SubagentManager.runParallel()` |
| `Agent(output_type=Plan)` structured output | Custom `Planner` JSON parsing |
| `pydantic_ai.models.test.TestModel` | Orchestrator unit tests |

LangGraph is **fully removed**. Orchestration is expressed as PydanticAI agents that call other agents through tools — the official PydanticAI multi-agent pattern.

---

## Deliverables

### 7.1 — Plan Types (`src/agentloop/orchestrator/types.py`)

```python
from pydantic import BaseModel
from typing import Literal

class PlanStep(BaseModel):
    id: str
    description: str
    depends_on: list[str] = []
    profile: str | None = None
    on_failure: Literal["retry", "skip", "abort"] = "abort"

class Plan(BaseModel):
    steps: list[PlanStep]
    resume_from: int | None = None
```

### 7.2 — Delegate Agents (one per role)

Define stateless module-level agents for each role. Agents are instantiated once and reused:

```python
# src/agentloop/orchestrator/agents.py
from pydantic_ai import Agent

planner_agent = Agent(
    model=...,
    name="planner",
    instructions="Decompose the given task into a step-by-step plan.",
    output_type=Plan,   # structured output — no custom parsing
)

step_agent = Agent(
    model=...,
    name="step_executor",
    instructions="Execute the described step and return your result.",
    tools=[...],        # full tool set
)
```

### 7.3 — Orchestrator Agent (parent, "agent as tool" pattern)

The orchestrator agent delegates each step to `step_agent` via a tool. This is the official PydanticAI multi-agent pattern:

```python
# src/agentloop/orchestrator/executor.py
from pydantic_ai import Agent, RunContext
from agentloop.orchestrator.agents import planner_agent, step_agent

orchestrator = Agent(
    model=...,
    name="orchestrator",
    instructions="Plan and execute multi-step tasks by delegating each step.",
)

@orchestrator.tool
async def execute_step(ctx: RunContext[AgentDeps], step_description: str) -> str:
    """Delegate one plan step to the step_executor agent."""
    result = await step_agent.run(
        step_description,
        deps=ctx.deps,
        usage=ctx.usage,  # propagate usage tracking to delegate
    )
    return result.output
```

- `ctx.usage` propagation ensures token accounting is correct across the delegation chain.
- `UsageLimits` can be passed to delegate calls to cap per-step cost.
- The orchestrator's own loop is driven by PydanticAI (no manual iteration).

### 7.4 — Planner (`src/agentloop/orchestrator/planner.py`)

```python
async def make_plan(task: str, deps: AgentDeps) -> Plan:
    result = await planner_agent.run(
        f"Create a step-by-step plan for: {task}",
        deps=deps,
        usage=deps.usage,
    )
    return result.output   # already a validated Plan — no custom parsing
```

`output_type=Plan` uses PydanticAI's built-in structured output. The model is instructed to return valid `Plan` JSON; PydanticAI validates and retries automatically on schema errors.

### 7.5 — Parallel Steps: `asyncio.gather()`

For steps with no inter-dependencies, run delegate calls concurrently:

```python
async def run_parallel_steps(
    steps: list[PlanStep],
    deps: AgentDeps,
) -> list[str]:
    coros = [
        step_agent.run(s.description, deps=deps, usage=deps.usage)
        for s in steps
    ]
    results = await asyncio.gather(*coros, return_exceptions=True)
    return [r.output if not isinstance(r, Exception) else str(r) for r in results]
```

`asyncio.gather()` replaces `SubagentManager.runParallel()`. Write-conflict detection (`mutates_file`) is preserved in a pre-gather check.

### 7.6 — `on_failure` / `resume_from` Logic

Sequential `on_failure` handling wraps the delegate tool call:

```python
async def execute_plan(plan: Plan, deps: AgentDeps) -> list[StepResult]:
    results = []
    start = (plan.resume_from or 1) - 1
    for step in plan.steps[start:]:
        try:
            out = await step_agent.run(step.description, deps=deps, usage=deps.usage)
            results.append(StepResult(step_id=step.id, output=out.output, status="ok"))
        except Exception as exc:
            results.append(StepResult(step_id=step.id, error=str(exc), status="failed"))
            if step.on_failure == "abort":
                break
            # "skip" or "retry" handled here
    return results
```

### 7.7 — CheckpointStore (unchanged interface)

```python
class CheckpointStore(Protocol):
    async def save(self, step_index: int, step: PlanStep) -> None: ...
    async def load(self) -> int | None: ...

class InMemoryCheckpointStore(CheckpointStore): ...
class FileCheckpointStore(CheckpointStore): ...   # persists to JSON
```

### 7.8 — Remove LangGraph

- Delete `src/langgraph/` entirely and remove `@langchain/langgraph` from `package.json`.
- The `ORCHESTRATOR=langgraph` env-var option is removed; only `ORCHESTRATOR=default` remains.

---

## Acceptance Criteria

- [ ] `make_plan("refactor the codebase")` returns a valid `Plan` with at least one step.
- [ ] Each step is delegated to `step_agent` via the `execute_step` tool; no manual loop.
- [ ] Usage tokens are correctly summed across parent and delegate agents.
- [ ] A failing step with `on_failure="abort"` stops orchestration.
- [ ] A failing step with `on_failure="skip"` continues to the next step.
- [ ] `resume_from=2` skips step 1.
- [ ] Parallel steps with `asyncio.gather()` run concurrently.
- [ ] Write conflicts between parallel tasks are detected before execution.
- [ ] All tests use `TestModel`; no real LLM calls.

---

## Files Changed / Created

| Action | Path |
|---|---|
| Create | `src/agentloop/orchestrator/__init__.py` |
| Create | `src/agentloop/orchestrator/types.py` |
| Create | `src/agentloop/orchestrator/agents.py` |
| Create | `src/agentloop/orchestrator/planner.py` |
| Create | `src/agentloop/orchestrator/executor.py` |
| Create | `tests/test_orchestrator.py` |
| Delete (later) | `src/langgraph/` (all files) |
| Delete (later) | `src/subagents/runner.ts`, `src/subagents/types.ts`, `src/orchestrator.ts` |

---

## Dependencies Removed

- `@langchain/langgraph` — entire LangGraph dependency eliminated

