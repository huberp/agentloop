from __future__ import annotations

import asyncio
import builtins
import importlib.util
import inspect
from collections.abc import Awaitable
from dataclasses import asdict, dataclass
from functools import wraps
from pathlib import Path
from types import ModuleType
from typing import TYPE_CHECKING, Any, Callable, Literal

from pydantic_ai import RunContext
from pydantic_ai.exceptions import ModelRetry
from pydantic_ai.tools import Tool

from agentloop.errors import ToolExecutionError

if TYPE_CHECKING:
    from agentloop.agent import AgentDeps

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

    def list(self) -> builtins.list[dict[str, str]]:
        return [{"name": item.name, "description": item.description} for item in self._definitions.values()]

    def get_all(self) -> builtins.list[dict[str, str | None]]:
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

    def to_pydantic_ai_tools(self, prepare: ToolPrepareHook | None = None) -> builtins.list[Tool[Any]]:
        result: builtins.list[Tool[Any]] = []
        for definition in self._definitions.values():
            result.append(
                Tool(
                    _wrap_tool_callable(definition),
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


def build_prepare_hook() -> ToolPrepareHook:
    def prepare(ctx: RunContext["AgentDeps"], tool_def: Any) -> Any:
        metadata = getattr(tool_def, "metadata", {}) or {}
        permissions = metadata.get("permissions", "safe")
        decision = ctx.deps.permission_manager.check(tool_def.name, {}, permissions=permissions)
        if decision in {"block", "confirm"}:
            return None
        return tool_def

    return prepare


def _wrap_tool_callable(definition: ToolDefinition) -> Callable[..., Awaitable[Any]]:
    @wraps(definition.fn)
    async def wrapped(*args: Any, **kwargs: Any) -> Any:
        ctx = args[0] if args else None
        timeout_ms = definition.timeout_ms
        if isinstance(ctx, RunContext):
            ctx.deps.tool_call_count += 1
            if ctx.deps.tool_call_count > ctx.deps.max_iterations:
                raise ModelRetry("Maximum tool iterations reached.")
            if timeout_ms is None:
                timeout_ms = ctx.deps.settings.tool_timeout_ms
            limiter = ctx.deps.concurrency_limiter
        else:
            limiter = None
        async def invoke() -> Any:
            result = definition.fn(*args, **kwargs)
            if inspect.isawaitable(result):
                return await result
            return result
        async def invoke_with_timeout() -> Any:
            if timeout_ms is None:
                return await invoke()
            try:
                return await asyncio.wait_for(invoke(), timeout=timeout_ms / 1000)
            except TimeoutError as exc:
                raise ToolExecutionError(
                    f"Tool '{definition.name}' timed out after {timeout_ms}ms"
                ) from exc
        if limiter is None:
            return await invoke_with_timeout()
        async with limiter.acquire():
            return await invoke_with_timeout()

    wrapped.__signature__ = inspect.signature(definition.fn)  # type: ignore[attr-defined]
    return wrapped
