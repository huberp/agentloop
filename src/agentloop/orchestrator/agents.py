from __future__ import annotations

from pydantic_ai import Agent

from agentloop.llm import create_model
from agentloop.orchestrator.types import Plan

planner_agent = Agent(
    create_model(),
    name="planner",
    instructions="Decompose the task into an ordered execution plan.",
    output_type=Plan,
    defer_model_check=True,
)

step_agent = Agent(
    create_model(),
    name="step_executor",
    instructions="Execute the requested step and return a concise result.",
    defer_model_check=True,
)
