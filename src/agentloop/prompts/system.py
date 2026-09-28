from __future__ import annotations

from pathlib import Path

from agentloop.config import Settings, settings as default_settings

_DEFAULT_PROMPT = "You are a helpful AI assistant agent. Use tools when they improve accuracy."


def build_system_prompt(skill_names: list[str] | None = None, *, settings: Settings | None = None) -> str:
    del skill_names
    resolved = settings or default_settings
    if resolved.system_prompt_path:
        return Path(resolved.system_prompt_path).read_text()
    return _DEFAULT_PROMPT
