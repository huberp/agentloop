from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING

BUILTIN_TOOLS_DIR = Path(__file__).parent

if TYPE_CHECKING:
    from agentloop.tools.registry import ToolRegistry


async def load_builtin_tool_registry() -> "ToolRegistry":
    from agentloop.tools.registry import ToolRegistry

    registry = ToolRegistry()
    await registry.load_from_directory(BUILTIN_TOOLS_DIR, source="built-in")
    return registry


__all__ = ["BUILTIN_TOOLS_DIR", "load_builtin_tool_registry"]
