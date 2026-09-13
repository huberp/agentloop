from __future__ import annotations

import importlib.util
from dataclasses import asdict, dataclass
from pathlib import Path
from types import ModuleType
from typing import Any, Callable, Literal

from pydantic_ai.tools import Tool

PermissionLevel = Literal["safe", "cautious", "dangerous"]
ToolSource = Literal["built-in", "custom", "mcp"]
ToolMutator = Callable[[dict[str, Any]], str | None]
ToolPrepareHook = Callable[..., Any]


@dataclass(slots=True)
class ToolDefinition:
    name: str
    description: str
    fn: Callable[..., Any]
    permissions: PermissionLevel = "safe"
    timeout_ms: int | None = None
    mutates_file: ToolMutator | None = None
    source: ToolSource | None = None
    file_path: str | None = None


def tool_def(
    *,
    name: str,
    description: str,
    permissions: PermissionLevel = "safe",
    timeout_ms: int | None = None,
    mutates_file: ToolMutator | None = None,
    source: ToolSource | None = None,
) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
    def decorator(fn: Callable[..., Any]) -> Callable[..., Any]:
        setattr(
            fn,
            "__tool_definition__",
            ToolDefinition(
                name=name,
                description=description,
                fn=fn,
                permissions=permissions,
                timeout_ms=timeout_ms,
                mutates_file=mutates_file,
                source=source,
            ),
        )
        return fn

    return decorator


class ToolRegistry:
    def __init__(self) -> None:
        self._definitions: dict[str, ToolDefinition] = {}

    def register(self, definition: ToolDefinition) -> None:
        if definition.name in self._definitions:
            raise ValueError(f'Tool "{definition.name}" is already registered')
        self._definitions[definition.name] = definition

    def unregister(self, name: str) -> None:
        self._definitions.pop(name, None)

    def get(self, name: str) -> ToolDefinition | None:
        return self._definitions.get(name)

    def list(self) -> list[dict[str, str]]:
        return [{"name": item.name, "description": item.description} for item in self._definitions.values()]

    def get_all(self) -> list[dict[str, str | None]]:
        return [
            {
                "name": item.name,
                "description": item.description,
                "permissions": item.permissions,
                "source": item.source,
                "file_path": item.file_path,
            }
            for item in self._definitions.values()
        ]

    async def load_from_directory(self, dir_path: Path, source: ToolSource | None = None) -> None:
        for path in sorted(dir_path.glob("*.py")):
            if path.name in {"__init__.py", "registry.py", "sanitize.py"} or path.name.startswith("_"):
                continue
            module = self._load_module(path)
            for attr in vars(module).values():
                definition = getattr(attr, "__tool_definition__", None)
                if (
                    isinstance(definition, ToolDefinition)
                    and getattr(attr, "__module__", None) == module.__name__
                ):
                    data = asdict(definition)
                    data["file_path"] = definition.file_path or str(path)
                    data["source"] = definition.source or source
                    self.register(ToolDefinition(**data))

    def to_pydantic_ai_tools(self, prepare: ToolPrepareHook | None = None) -> list[Tool[Any]]:
        result: list[Tool[Any]] = []
        for definition in self._definitions.values():
            result.append(
                Tool(
                    definition.fn,
                    name=definition.name,
                    description=definition.description,
                    timeout=(definition.timeout_ms / 1000) if definition.timeout_ms else None,
                    prepare=prepare,
                    requires_approval=definition.permissions in {"cautious", "dangerous"},
                    metadata={
                        "permissions": definition.permissions,
                        "source": definition.source,
                        "file_path": definition.file_path,
                    },
                )
            )
        return result

    @staticmethod
    def _load_module(path: Path) -> ModuleType:
        module_name = f"agentloop_dynamic_tools_{path.stem}"
        spec = importlib.util.spec_from_file_location(module_name, path)
        if spec is None or spec.loader is None:
            raise ImportError(f"Unable to import tool module: {path}")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module


def get_tool_definition(fn: Callable[..., Any]) -> ToolDefinition:
    definition = getattr(fn, "__tool_definition__", None)
    if not isinstance(definition, ToolDefinition):
        raise TypeError(f"{fn!r} is not decorated with @tool_def")
    return definition
