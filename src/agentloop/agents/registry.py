from __future__ import annotations

from pathlib import Path
from typing import Any

from pydantic_ai import Agent
from pydantic_ai.settings import ModelSettings
from pydantic_ai_skills import SkillsCapability

from agentloop.agent import AgentDeps
from agentloop.agents.types import AgentProfile
from agentloop.config import Settings, settings as default_settings
from agentloop.prompts.system import build_system_prompt


class AgentProfileRegistry:
    def __init__(self) -> None:
        self._profiles: dict[str, AgentProfile] = {}

    async def load_from_directory(self, dir_path: Path, source: str = "built-in") -> None:
        if not dir_path.exists():
            return
        for path in sorted(dir_path.glob("*.agent.json")):
            profile = AgentProfile.model_validate_json(path.read_text())
            self._profiles[profile.name] = profile.model_copy(update={"source": source, "file_path": str(path)})

    def get(self, name: str) -> AgentProfile | None:
        return self._profiles.get(name)

    def list(self) -> list[AgentProfile]:
        return list(self._profiles.values())


def _normalize_tool_name(name: str) -> str:
    return name.replace("-", "_")


def agent_from_profile(
    profile: AgentProfile,
    *,
    settings: Settings | None = None,
    model: Any = None,
    tools: list[Any] | None = None,
    toolsets: list[Any] | None = None,
    tool_metadata: list[dict[str, Any]] | None = None,
    skills_dir: Path | None = None,
) -> Agent[AgentDeps, str]:
    resolved = settings or default_settings
    selected_tools = [_normalize_tool_name(name) for name in (profile.tools or [])]
    blocked = {_normalize_tool_name(name) for name in (profile.blocked_tools or [])}
    filtered_tools = list(tools or [])
    if selected_tools and tool_metadata:
        allowed = set(selected_tools)
        filtered_tools = [tool for tool, meta in zip(filtered_tools, tool_metadata, strict=False) if meta.get("name") in allowed]
    if blocked and tool_metadata:
        filtered_tools = [tool for tool, meta in zip(filtered_tools, tool_metadata, strict=False) if meta.get("name") not in blocked]
    capabilities = []
    skill_names = list(profile.skills or [])
    if skills_dir and skills_dir.exists():
        capabilities.append(SkillsCapability(skills_dir, include=skill_names or None))
    prompt = profile.system_prompt_override or build_system_prompt(skill_names, settings=resolved)
    agent = Agent(
        model or profile.model or f"{resolved.llm_provider}:{resolved.llm_model}",
        deps_type=AgentDeps,
        system_prompt=prompt,
        tools=filtered_tools,
        toolsets=list(toolsets or []),
        capabilities=capabilities,
        model_settings=ModelSettings(temperature=profile.temperature or resolved.llm_temperature),
        retries=resolved.llm_retry_max,
        name=profile.name,
        defer_model_check=True,
    )
    setattr(
        agent,
        "agentloop_tool_names",
        selected_tools
        or [meta.get("name") for meta in (tool_metadata or []) if meta.get("name") not in blocked],
    )
    setattr(agent, "agentloop_skill_names", skill_names)
    setattr(agent, "agentloop_profile", profile)
    return agent
