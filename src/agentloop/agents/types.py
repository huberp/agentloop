from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field


class AgentProfile(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    name: str
    description: str = ""
    version: str = "1.0.0"
    model: str | None = None
    temperature: float | None = None
    max_iterations: int | None = Field(default=None, alias="maxIterations")
    tools: list[str] | None = None
    blocked_tools: list[str] | None = None
    skills: list[str] | None = None
    system_prompt_override: str | None = Field(default=None, alias="systemPrompt")
    prompt_template: str | None = Field(default=None, alias="promptTemplate")
    source: str | None = None
    file_path: str | None = None
