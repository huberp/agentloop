from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


class PlanStep(BaseModel):
    id: str
    description: str
    depends_on: list[str] = Field(default_factory=list)
    profile: str | None = None
    on_failure: Literal["retry", "skip", "abort"] = "abort"
    mutates_paths: list[str] = Field(default_factory=list)


class Plan(BaseModel):
    steps: list[PlanStep]
    resume_from: int | None = None


class StepResult(BaseModel):
    step_id: str
    status: Literal["ok", "failed", "skipped"]
    output: str | None = None
    error: str | None = None
