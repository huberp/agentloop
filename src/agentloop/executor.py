from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Sequence
from pathlib import Path
from typing import Any
from uuid import uuid4

from pydantic_ai import Agent
from pydantic_ai.messages import ModelMessage
from pydantic_ai.usage import UsageLimits

from agentloop.agent import AgentDeps, create_agent
from agentloop.agents.registry import AgentProfileRegistry, agent_from_profile
from agentloop.context import trim_messages
from agentloop.config import Settings, settings as default_settings
from agentloop.llm import ProviderModel, create_model
from agentloop.mcp import build_mcp_servers
from agentloop.observability import get_tracer, initialize_logfire
from agentloop.security import ConcurrencyLimiter, PermissionManager
from agentloop.streaming import stream_with_tools
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
        self._toolsets: list[Any] = []
        self._registry: ToolRegistry | None = None
        self._profile_registry = AgentProfileRegistry()
        self._history: dict[str, list[ModelMessage]] = {"default": []}
        self._agent_cache: dict[str, Agent[AgentDeps, str]] = {}
        self._tracer = get_tracer(self.settings)
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
            initialize_logfire()
            self._model = self._model or create_model(self.settings)
            if not self._tools:
                self._registry = await load_builtin_tool_registry()
                self._tools = self._registry.to_pydantic_ai_tools(prepare=build_prepare_hook())
            await self._profile_registry.load_from_directory(Path("src/agentloop/agents/builtin"))
            if self.settings.agent_profiles_dir:
                await self._profile_registry.load_from_directory(
                    Path(self.settings.agent_profiles_dir), source="custom"
                )
            self._toolsets = build_mcp_servers(self.settings.mcp_servers)
            self._agent_cache["default"] = create_agent(
                self._tools,
                toolsets=self._toolsets,
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
            selected_profile = self._profile_registry.get(key) if profile else None
            if selected_profile is None:
                self._agent_cache[key] = create_agent(
                    self._tools,
                    toolsets=self._toolsets,
                    system_prompt=self._system_prompt,
                    config=self.settings,
                    model=self._model,
                    name=key,
                )
            else:
                self._agent_cache[key] = agent_from_profile(
                    selected_profile,
                    settings=self.settings,
                    model=self._model,
                    tools=self._tools,
                    toolsets=self._toolsets,
                    tool_metadata=self._registry.get_all() if self._registry else [],
                    skills_dir=Path("src/agentloop/skills/builtin"),
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
        if self.settings.streaming_enabled:
            chunks: list[str] = []
            async for delta in self.stream(prompt, profile=profile):
                chunks.append(delta)
            return "".join(chunks)
        await self._ensure_initialized()
        key = self._profile_key(profile)
        agent = self._get_agent(profile)
        deps = self._make_deps()
        history = trim_messages(self._history.setdefault(key, []), self.settings.max_context_tokens)
        result = await agent.run(
            prompt,
            message_history=history,
            deps=deps,
            usage_limits=UsageLimits(total_tokens_limit=self.settings.max_tokens_budget),
        )
        self._history[key].extend(result.new_messages())
        await self._record_invocation(str(uuid4()), prompt, str(result.output), result.usage.__dict__)
        return str(result.output)

    async def stream(self, prompt: str, profile: str | None = None) -> AsyncIterator[str]:
        await self._ensure_initialized()
        key = self._profile_key(profile)
        agent = self._get_agent(profile)
        deps = self._make_deps()
        async for delta in stream_with_tools(
            agent,
            prompt,
            self._history.setdefault(key, []),
            deps,
        ):
            yield delta
        usage = getattr(deps.metadata.get("stream_usage"), "__dict__", {})
        output = str(deps.metadata.get("stream_output", ""))
        await self._record_invocation(str(uuid4()), prompt, output, usage)

    def get_history(self, profile: str | None = None) -> list[ModelMessage]:
        return list(self._history.get(self._profile_key(profile), []))

    async def _record_invocation(
        self, invocation_id: str, prompt: str, output: str, usage: dict[str, Any]
    ) -> None:
        await self._tracer.record(
            invocation_id,
            {
                "prompt": prompt,
                "output": output,
                "usage": usage,
            },
        )
