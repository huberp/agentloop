from __future__ import annotations

from dataclasses import dataclass, field

import pytest
from pydantic_ai import Agent
from pydantic_ai.models.test import TestModel

from agentloop.agent import AgentDeps
from agentloop.orchestrator.executor import FileCheckpointStore, InMemoryCheckpointStore, execute_plan, make_plan, run_parallel_steps
from agentloop.orchestrator.types import Plan, PlanStep


@dataclass
class DummyResult:
    output: str


class DummyRunner:
    def __init__(self, responses: list[str], fail_on: set[str] | None = None) -> None:
        self.responses = responses
        self.fail_on = fail_on or set()
        self.calls: list[str] = []

    async def run(self, prompt: str, deps=None, usage=None):
        del deps, usage
        self.calls.append(prompt)
        if prompt in self.fail_on:
            raise RuntimeError(f"failed: {prompt}")
        index = len(self.calls) - 1
        return DummyResult(self.responses[index] if index < len(self.responses) else prompt)


@pytest.mark.asyncio
async def test_make_plan_returns_structured_plan(test_settings) -> None:
    deps = AgentDeps(settings=test_settings, workspace_root=test_settings.workspace_root)
    planner = Agent(
        TestModel(call_tools=[], custom_output_args={"steps": [{"id": "s1", "description": "Do work"}]}),
        output_type=Plan,
        defer_model_check=True,
    )
    plan = await make_plan("refactor", deps, planner=planner)
    assert plan.steps[0].id == "s1"


@pytest.mark.asyncio
async def test_execute_plan_abort_and_resume(test_settings) -> None:
    deps = AgentDeps(settings=test_settings, workspace_root=test_settings.workspace_root)
    plan = Plan(
        steps=[
            PlanStep(id="one", description="one"),
            PlanStep(id="two", description="two", on_failure="abort"),
            PlanStep(id="three", description="three"),
        ]
    )
    runner = DummyRunner(["done"], fail_on={"two"})
    results = await execute_plan(plan, deps, step_runner=runner)
    assert [result.step_id for result in results] == ["one", "two"]

    resumed = plan.model_copy(update={"resume_from": 2})
    resume_runner = DummyRunner(["done-two", "done-three"])
    resume_results = await execute_plan(resumed, deps, step_runner=resume_runner)
    assert resume_results[0].step_id == "two"


@pytest.mark.asyncio
async def test_execute_plan_skip_and_retry(test_settings) -> None:
    deps = AgentDeps(settings=test_settings, workspace_root=test_settings.workspace_root)
    skip_plan = Plan(
        steps=[
            PlanStep(id="one", description="one", on_failure="skip"),
            PlanStep(id="two", description="two"),
        ]
    )
    skip_runner = DummyRunner(["done-two"], fail_on={"one"})
    skip_results = await execute_plan(skip_plan, deps, step_runner=skip_runner)
    assert skip_results[0].status == "failed"
    assert skip_results[1].status == "ok"

    class RetryRunner(DummyRunner):
        async def run(self, prompt: str, deps=None, usage=None):
            if prompt == "retry-me" and prompt not in self.calls:
                self.calls.append(prompt)
                raise RuntimeError("boom")
            self.calls.append(prompt)
            return DummyResult("recovered")

    retry_plan = Plan(steps=[PlanStep(id="retry", description="retry-me", on_failure="retry")])
    retry_results = await execute_plan(retry_plan, deps, step_runner=RetryRunner([]))
    assert retry_results[0].output == "recovered"


@pytest.mark.asyncio
async def test_run_parallel_steps_and_conflicts(test_settings) -> None:
    deps = AgentDeps(settings=test_settings, workspace_root=test_settings.workspace_root)
    runner = DummyRunner(["a", "b"])
    steps = [PlanStep(id="a", description="A"), PlanStep(id="b", description="B")]
    results = await run_parallel_steps(steps, deps, step_runner=runner)
    assert [result.output for result in results] == ["a", "b"]

    with pytest.raises(ValueError):
        await run_parallel_steps(
            [
                PlanStep(id="x", description="X", mutates_paths=["same.txt"]),
                PlanStep(id="y", description="Y", mutates_paths=["same.txt"]),
            ],
            deps,
            step_runner=runner,
        )


@pytest.mark.asyncio
async def test_checkpoint_stores(test_settings) -> None:
    plan = PlanStep(id="step", description="work")
    memory = InMemoryCheckpointStore()
    await memory.save(1, plan)
    assert await memory.load() == 1

    file_store = FileCheckpointStore(test_settings.workspace_root / "checkpoint.json")
    await file_store.save(2, plan)
    assert await file_store.load() == 2
