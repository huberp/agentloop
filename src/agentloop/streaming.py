from __future__ import annotations

from collections.abc import AsyncIterator

from pydantic_ai import Agent
from pydantic_ai.messages import ModelMessage

from agentloop.agent import AgentDeps


async def stream_with_tools(
    agent: Agent[AgentDeps, str],
    prompt: str,
    history: list[ModelMessage],
    deps: AgentDeps,
) -> AsyncIterator[str]:
    chunks: list[str] = []
    async with agent.run_stream(prompt, message_history=history, deps=deps) as stream:
        async for delta in stream.stream_text(delta=True):
            chunks.append(delta)
            yield delta
        deps.metadata["stream_usage"] = stream.usage
        deps.metadata["stream_output"] = "".join(chunks)
    history.extend(stream.new_messages())
