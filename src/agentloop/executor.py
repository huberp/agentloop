from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Sequence
from typing import Any

from pydantic_ai import Agent
from pydantic_ai.messages import ModelMessage

from agentloop.agent import AgentDeps, create_agent
from agentloop.config import Settings, settings as default_settings
from agentloop.llm import ProviderModel, create_model
from agentloop.security import ConcurrencyLimiter, PermissionManager
from agentloop.tools import load_builtin_tool_registry
from agentloop.tools.registry import ToolRegistry, build_prepare_hook


class AgentExecutor:
    def __init__(
        self,
        *,
        settings: Settings | None = None,
        model: ProviderModel | str | None = None,
        system_prompt: str | None = None,
        tools: Sequence[Any] | None = None,
    ) -> None:
        self.settings = settings or default_settings
        self._model = model
        self._system_prompt = system_prompt
        self._tools = list(tools or [])
        self._registry: ToolRegistry | None = None
        self._history: dict[str, list[ModelMessage]] = {"default": []}
        self._agent_cache: dict[str, Agent[AgentDeps, str]] = {}
        self._init_lock = asyncio.Lock()
        self._initialized = False

    async def initialize(self) -> None:
        await self._ensure_initialized()

    async def _ensure_initialized(self) -> None:
        if self._initialized:
            return
        async with self._init_lock:
            if self._initialized:
                return
            self._model = self._model or create_model(self.settings)
            if not self._tools:
                self._registry = await load_builtin_tool_registry()
                self._tools = self._registry.to_pydantic_ai_tools(prepare=build_prepare_hook())
            self._agent_cache["default"] = create_agent(
                self._tools,
                system_prompt=self._system_prompt,
                config=self.settings,
                model=self._model,
            )
            self._initialized = True

    def _profile_key(self, profile: str | None) -> str:
        return profile or "default"

    def _get_agent(self, profile: str | None = None) -> Agent[AgentDeps, str]:
        key = self._profile_key(profile)
        if key not in self._agent_cache:
            self._agent_cache[key] = create_agent(
                self._tools,
                system_prompt=self._system_prompt,
                config=self.settings,
                model=self._model,
                name=key,
            )
        return self._agent_cache[key]

    def _make_deps(self) -> AgentDeps:
        return AgentDeps(
            settings=self.settings,
            workspace_root=self.settings.workspace_root,
            max_iterations=self.settings.max_iterations,
            metadata={
                "permission_manager": PermissionManager(self.settings),
                "concurrency_limiter": ConcurrencyLimiter(self.settings.max_concurrent_tools),
            },
        )

    async def invoke(self, prompt: str, profile: str | None = None) -> str:
        await self._ensure_initialized()
        key = self._profile_key(profile)
        agent = self._get_agent(profile)
        result = await agent.run(
            prompt,
            message_history=self._history.setdefault(key, []),
            deps=self._make_deps(),
        )
        self._history[key].extend(result.new_messages())
        return str(result.output)

    async def stream(self, prompt: str, profile: str | None = None) -> AsyncIterator[str]:
        await self._ensure_initialized()
        key = self._profile_key(profile)
        agent = self._get_agent(profile)
        async with agent.run_stream(
            prompt,
            message_history=self._history.setdefault(key, []),
            deps=self._make_deps(),
        ) as stream_result:
            async for delta in stream_result.stream_text(delta=True):
                yield delta
        self._history[key].extend(stream_result.new_messages())

    def get_history(self, profile: str | None = None) -> list[ModelMessage]:
        return list(self._history.get(self._profile_key(profile), []))
