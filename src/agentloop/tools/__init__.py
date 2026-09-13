from __future__ import annotations

from pathlib import Path

BUILTIN_TOOLS_DIR = Path(__file__).parent


async def load_builtin_tool_registry():
    from agentloop.tools.registry import ToolRegistry

    registry = ToolRegistry()
    await registry.load_from_directory(BUILTIN_TOOLS_DIR, source="built-in")
    return registry


__all__ = ["BUILTIN_TOOLS_DIR", "load_builtin_tool_registry"]
