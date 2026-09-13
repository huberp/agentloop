from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from pydantic_ai import Agent
from pydantic_ai.settings import ModelSettings

from agentloop.config import Settings, settings as default_settings
from agentloop.llm import ProviderModel, create_model


@dataclass(slots=True)
class AgentDeps:
    settings: Settings
    workspace_root: Path
    permission_manager: Any | None = None
    concurrency_limiter: Any | None = None
    tool_call_count: int = 0
    max_iterations: int = 20
    metadata: dict[str, Any] = field(default_factory=dict)


def create_agent(
    tools: Sequence[Any] | None = None,
    *,
    system_prompt: str | Sequence[str] | None = None,
    config: Settings | None = None,
    model: ProviderModel | str | None = None,
    name: str | None = None,
) -> Agent[AgentDeps, str]:
    resolved = config or default_settings
    agent_model = model or create_model(resolved)
    prompt = system_prompt if system_prompt is not None else "You are a helpful AI assistant agent."
    return Agent(
        model=agent_model,
        deps_type=AgentDeps,
        system_prompt=prompt,
        tools=list(tools or []),
        retries=resolved.llm_retry_max,
        model_settings=ModelSettings(temperature=resolved.llm_temperature),
        name=name,
        defer_model_check=True,
    )
