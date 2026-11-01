from __future__ import annotations

from pathlib import Path

from pydantic_ai.models.test import TestModel
from pydantic_ai_skills import SkillsCapability

from agentloop.agents.registry import AgentProfileRegistry, agent_from_profile
from agentloop.prompts.system import build_system_prompt
from agentloop.tools import BUILTIN_TOOLS_DIR
from agentloop.tools.registry import ToolRegistry


async def _load_tools() -> tuple[list[object], list[dict[str, str | None]]]:
    registry = ToolRegistry()
    await registry.load_from_directory(BUILTIN_TOOLS_DIR, source="built-in")
    return registry.to_pydantic_ai_tools(), registry.get_all()


async def test_profile_registry_loads_builtin_profiles() -> None:
    registry = AgentProfileRegistry()
    await registry.load_from_directory(Path("src/agentloop/agents/builtin"))
    assert registry.get("coder") is not None


async def test_agent_from_profile_filters_tools(test_settings) -> None:
    profile_registry = AgentProfileRegistry()
    await profile_registry.load_from_directory(Path("src/agentloop/agents/builtin"))
    tools, metadata = await _load_tools()
    agent = agent_from_profile(
        profile_registry.get("planner"),
        settings=test_settings,
        model=TestModel(call_tools=[], custom_output_text="ok"),
        tools=tools,
        tool_metadata=metadata,
        skills_dir=Path("src/agentloop/skills/builtin"),
    )
    assert "file_read" in agent.agentloop_tool_names
    assert "shell" not in agent.agentloop_tool_names


def test_skills_directory_uses_skill_md_format() -> None:
    path = Path("src/agentloop/skills/builtin/code-reviewer/SKILL.md")
    content = path.read_text()
    assert "## Description" in content
    assert isinstance(SkillsCapability(Path("src/agentloop/skills/builtin")), SkillsCapability)


def test_build_system_prompt_returns_string(test_settings) -> None:
    assert build_system_prompt(["git-workflow"], settings=test_settings)
