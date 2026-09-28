from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest
from pydantic_ai import RunContext
from pydantic_ai.models.test import TestModel
from pydantic_ai.tools import ToolDefinition as PydanticToolDefinition
from pydantic_ai.usage import RunUsage

from agentloop.agent import AgentDeps
from agentloop.errors import ToolExecutionError
from agentloop.security import ConcurrencyLimiter, PermissionManager
from agentloop.tools.registry import ToolRegistry, build_prepare_hook, tool_def
from agentloop.tools.sanitize import safe_path


@pytest.mark.asyncio
async def test_permission_manager_honors_lists(test_settings) -> None:
    manager = PermissionManager(test_settings)
    assert manager.check("file_read", {}, permissions="safe") == "allow"

    blocklisted = test_settings.model_copy(update={"tool_blocklist": ["shell"]})
    assert PermissionManager(blocklisted).check("shell", {}, permissions="dangerous") == "block"

    allowlisted = test_settings.model_copy(update={"tool_allowlist": ["file_read"]})
    assert PermissionManager(allowlisted).check("shell", {}, permissions="safe") == "block"


@pytest.mark.asyncio
async def test_permission_manager_blocks_shell_injection(test_settings) -> None:
    manager = PermissionManager(test_settings)
    assert manager.check("shell", {"command": "echo hi && whoami"}, permissions="dangerous") == "block"


@pytest.mark.asyncio
async def test_concurrency_limiter_caps_parallelism() -> None:
    limiter = ConcurrencyLimiter(1)
    active_counts: list[int] = []

    async def worker() -> None:
        async with limiter.acquire():
            active_counts.append(limiter.active_count)
            await asyncio.sleep(0.01)

    await asyncio.gather(worker(), worker())
    assert max(active_counts) == 1


@pytest.mark.asyncio
async def test_prepare_hook_omits_unapproved_tools(test_settings) -> None:
    deps = AgentDeps(settings=test_settings, workspace_root=test_settings.workspace_root, max_iterations=0)
    deps.permission_manager = PermissionManager(test_settings)
    deps.concurrency_limiter = ConcurrencyLimiter(0)
    ctx = RunContext(deps=deps, model=TestModel(), usage=RunUsage())
    hook = build_prepare_hook()
    tool_def = PydanticToolDefinition(name="shell", metadata={"permissions": "dangerous"})
    assert hook(ctx, tool_def) is None


@pytest.mark.asyncio
async def test_tool_wrapper_applies_timeout(test_settings) -> None:
    registry = ToolRegistry()

    @tool_def(name="slow_tool", description="slow", timeout_ms=10)
    async def slow_tool(ctx: RunContext[AgentDeps], value: int) -> str:
        del ctx, value
        await asyncio.sleep(0.05)
        return "done"

    registry.register(getattr(slow_tool, "__tool_definition__"))
    tool = registry.to_pydantic_ai_tools()[0]
    deps = AgentDeps(settings=test_settings, workspace_root=test_settings.workspace_root)
    deps.permission_manager = PermissionManager(test_settings)
    deps.concurrency_limiter = ConcurrencyLimiter(0)
    ctx = RunContext(deps=deps, model=TestModel(), usage=RunUsage())
    with pytest.raises(ToolExecutionError):
        await tool.function(ctx, 1)


@pytest.mark.asyncio
async def test_tool_wrapper_enforces_max_iterations(test_settings) -> None:
    registry = ToolRegistry()

    @tool_def(name="once_tool", description="once")
    async def once_tool(ctx: RunContext[AgentDeps], value: int) -> str:
        del ctx
        return str(value)

    registry.register(getattr(once_tool, "__tool_definition__"))
    tool = registry.to_pydantic_ai_tools()[0]
    deps = AgentDeps(settings=test_settings, workspace_root=test_settings.workspace_root, max_iterations=0)
    deps.permission_manager = PermissionManager(test_settings)
    deps.concurrency_limiter = ConcurrencyLimiter(0)
    ctx = RunContext(deps=deps, model=TestModel(), usage=RunUsage())
    with pytest.raises(Exception, match="Maximum tool iterations reached"):
        await tool.function(ctx, 1)


def test_safe_path_rejects_traversal(test_settings) -> None:
    with pytest.raises(ToolExecutionError):
        safe_path(test_settings.workspace_root, "../outside.txt")
