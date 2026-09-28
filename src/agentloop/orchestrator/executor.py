from __future__ import annotations

import asyncio
import json
from collections.abc import Sequence
from pathlib import Path
from typing import Any, Protocol

from pydantic_ai import Agent, RunContext

from agentloop.agent import AgentDeps
from agentloop.llm import create_model
from agentloop.orchestrator.agents import planner_agent, step_agent
from agentloop.orchestrator.types import Plan, PlanStep, StepResult

orchestrator = Agent(
    create_model(),
    name="orchestrator",
    instructions="Plan and execute multi-step tasks by delegating with tools.",
    deps_type=AgentDeps,
    defer_model_check=True,
)


@orchestrator.tool
async def execute_step(
    ctx: RunContext[AgentDeps],
    /,
    step_description: str,
    profile: str | None = None,
) -> str:
    result = await step_agent.run(step_description, deps=ctx.deps, usage=ctx.usage)
    del profile
    return str(result.output)


class CheckpointStore(Protocol):
    async def save(self, step_index: int, step: PlanStep) -> None: ...

    async def load(self) -> int | None: ...


class InMemoryCheckpointStore:
    def __init__(self) -> None:
        self.step_index: int | None = None

    async def save(self, step_index: int, step: PlanStep) -> None:
        del step
        self.step_index = step_index

    async def load(self) -> int | None:
        return self.step_index


class FileCheckpointStore:
    def __init__(self, path: Path) -> None:
        self.path = path

    async def save(self, step_index: int, step: PlanStep) -> None:
        self.path.write_text(json.dumps({"step_index": step_index, "step": step.model_dump()}))

    async def load(self) -> int | None:
        if not self.path.exists():
            return None
        return int(json.loads(self.path.read_text())["step_index"])


async def make_plan(task: str, deps: AgentDeps, planner: Agent[AgentDeps, Plan] = planner_agent) -> Plan:
    result = await planner.run(f"Create a plan for: {task}", deps=deps)
    return result.output


async def run_parallel_steps(
    steps: Sequence[PlanStep],
    deps: AgentDeps,
    step_runner: Any = step_agent,
) -> list[StepResult]:
    seen: set[str] = set()
    for step in steps:
        for path in step.mutates_paths:
            if path in seen:
                raise ValueError(f"Parallel write conflict detected for {path}")
            seen.add(path)

    async def run_one(step: PlanStep) -> StepResult:
        try:
            result = await step_runner.run(step.description, deps=deps)
            return StepResult(step_id=step.id, status="ok", output=str(result.output))
        except Exception as exc:  # pragma: no cover - exercised in tests
            return StepResult(step_id=step.id, status="failed", error=str(exc))

    return list(await asyncio.gather(*(run_one(step) for step in steps)))


async def execute_plan(
    plan: Plan,
    deps: AgentDeps,
    *,
    checkpoint_store: CheckpointStore | None = None,
    step_runner: Any = step_agent,
) -> list[StepResult]:
    results: list[StepResult] = []
    completed: set[str] = set()
    start_index = (plan.resume_from or 1) - 1
    for index, step in enumerate(plan.steps[start_index:], start=start_index):
        if any(dep not in completed for dep in step.depends_on):
            results.append(StepResult(step_id=step.id, status="skipped", error="dependencies not satisfied"))
            continue
        try:
            result = await step_runner.run(step.description, deps=deps)
            results.append(StepResult(step_id=step.id, status="ok", output=str(result.output)))
            completed.add(step.id)
            if checkpoint_store is not None:
                await checkpoint_store.save(index + 1, step)
        except Exception as exc:
            if step.on_failure == "retry":
                result = await step_runner.run(step.description, deps=deps)
                results.append(StepResult(step_id=step.id, status="ok", output=str(result.output)))
                completed.add(step.id)
                continue
            results.append(StepResult(step_id=step.id, status="failed", error=str(exc)))
            if step.on_failure == "abort":
                break
    return results
