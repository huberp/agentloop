# Phase 7 — Orchestration & Subagents

## Objective

Port the multi-step `Orchestrator` / `Planner` and parallel `SubagentManager` from LangGraph + custom TypeScript to Python using `asyncio` and PydanticAI `Agent` instances.

---

## Background

### Current Architecture

```
src/langgraph/          LangGraph-based orchestrator
  graph.ts              StateGraph definition
  compiler.ts           Plan → graph nodes
  scheduler.ts          Resume / step-skip logic
  step-runner.ts        Per-step agent invocation
  types.ts              LangGraph types

src/subagents/
  runner.ts             SubagentManager.runParallel()
  types.ts              SubagentTask, CheckpointStore

src/orchestrator.ts     executePlan() — ties everything together
```

LangGraph (`@langchain/langgraph`) is used only for the multi-step orchestration path. The default (non-LangGraph) path uses a custom `executePlan()` loop.

### PydanticAI Built-Ins Used

| Built-in | Replaces |
|---|---|
| `pydantic_ai.Agent.run()` per step | LangGraph `StateGraph` node execution |
| `asyncio.gather()` | `SubagentManager.runParallel()` |
| `pydantic_ai.models.test.TestModel` | Orchestrator unit tests |

LangGraph is **fully removed**; no equivalent is pulled in. The orchestration logic is reimplemented as a lightweight Python `Orchestrator` class.

---

## Deliverables

### 7.1 — Plan Types (`src/agentloop/orchestrator/types.py`)

```python
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

### 7.2 — Planner (`src/agentloop/orchestrator/planner.py`)

```python
class Planner:
    def __init__(self, agent: Agent, deps: AgentDeps): ...

    async def plan(self, task: str) -> Plan:
        """Ask the LLM to produce a structured Plan for the given task."""
        result = await self._agent.run(
            f"Create a step-by-step plan for: {task}",
            result_type=Plan,   # ← PydanticAI structured output
        )
        return result.output
```

- `result_type=Plan` uses PydanticAI's built-in structured output feature — the LLM is asked to return a valid `Plan` JSON. No custom parsing.

### 7.3 — Orchestrator (`src/agentloop/orchestrator/executor.py`)

```python
class Orchestrator:
    async def execute_plan(
        self,
        plan: Plan,
        checkpoint_store: CheckpointStore | None = None,
    ) -> list[StepResult]:
        results = []
        start = (plan.resume_from or 1) - 1
        for i, step in enumerate(plan.steps[start:], start=start):
            if checkpoint_store:
                await checkpoint_store.save(i, step)
            result = await self._run_step(step)
            results.append(result)
            if result.status == "failed" and step.on_failure == "abort":
                break
        return results

    async def _run_step(self, step: PlanStep) -> StepResult:
        agent = self._agent_factory(profile=step.profile)
        result = await agent.run(step.description, deps=self._deps)
        return StepResult(step_id=step.id, output=result.output)
```

### 7.4 — SubagentManager (`src/agentloop/subagents/manager.py`)

```python
class SubagentManager:
    async def run_parallel(self, tasks: list[SubagentTask]) -> list[SubagentResult]:
        self._detect_write_conflicts(tasks)
        coros = [self._run_task(t) for t in tasks]
        return await asyncio.gather(*coros, return_exceptions=True)
```

- `asyncio.gather()` replaces the custom parallel runner — no LangGraph nodes.
- Write-conflict detection (`mutates_file`) is preserved in `_detect_write_conflicts`.

### 7.5 — CheckpointStore

```python
class CheckpointStore(Protocol):
    async def save(self, step_index: int, step: PlanStep) -> None: ...
    async def load(self) -> int | None: ...   # returns resume_from index

class InMemoryCheckpointStore(CheckpointStore): ...
class FileCheckpointStore(CheckpointStore): ...   # persists to JSON
```

### 7.6 — Remove LangGraph

- Delete the entire `src/langgraph/` directory and its TypeScript source.
- Remove `@langchain/langgraph` from `package.json`.
- The `ORCHESTRATOR=langgraph` env-var option is removed; only `ORCHESTRATOR=default` remains (and is eventually deprecated in favour of the Python orchestrator path).

### 7.7 — `plan_only` Mode

When `settings.plan_only` is `True`, `Orchestrator.execute_plan()` returns the plan as text without executing any steps.

---

## Acceptance Criteria

- [ ] `Planner.plan("refactor the codebase")` returns a valid `Plan` with at least one step.
- [ ] `Orchestrator.execute_plan(plan)` executes each step in order.
- [ ] A failing step with `on_failure="abort"` stops the orchestration.
- [ ] A failing step with `on_failure="skip"` continues to the next step.
- [ ] `resume_from=2` skips step 1 and resumes from step 2.
- [ ] `SubagentManager.run_parallel([t1, t2])` runs both concurrently.
- [ ] Write conflicts between parallel tasks are detected before execution.
- [ ] All tests use `TestModel`; no real LLM calls.

---

## Files Changed / Created

| Action | Path |
|---|---|
| Create | `src/agentloop/orchestrator/__init__.py` |
| Create | `src/agentloop/orchestrator/types.py` |
| Create | `src/agentloop/orchestrator/planner.py` |
| Create | `src/agentloop/orchestrator/executor.py` |
| Create | `src/agentloop/subagents/__init__.py` |
| Create | `src/agentloop/subagents/manager.py` |
| Create | `src/agentloop/subagents/types.py` |
| Create | `tests/test_orchestrator.py` |
| Create | `tests/test_subagents.py` |
| Delete (later) | `src/langgraph/` (all files) |
| Delete (later) | `src/subagents/runner.ts`, `src/subagents/types.ts` |

---

## Dependencies Removed

- `@langchain/langgraph` — entire LangGraph dependency eliminated
