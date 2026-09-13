from __future__ import annotations

import pytest
from pydantic_ai.models.test import TestModel

from agentloop.executor import AgentExecutor


@pytest.mark.asyncio
async def test_executor_stream_yields_text(test_settings) -> None:
    executor = AgentExecutor(
        settings=test_settings,
        model=TestModel(call_tools=[], custom_output_text="Hello world"),
    )
    chunks = [chunk async for chunk in executor.stream("hello")]
    assert chunks == ["Hello world"]


@pytest.mark.asyncio
async def test_stream_updates_history(test_settings) -> None:
    executor = AgentExecutor(
        settings=test_settings,
        model=TestModel(call_tools=[], custom_output_text="History"),
    )
    _ = [chunk async for chunk in executor.stream("hello")]
    assert len(executor.get_history()) == 2


@pytest.mark.asyncio
async def test_invoke_uses_stream_when_enabled(test_settings) -> None:
    stream_settings = test_settings.model_copy(update={"streaming_enabled": True})
    executor = AgentExecutor(
        settings=stream_settings,
        model=TestModel(call_tools=[], custom_output_text="Streamed"),
    )
    assert await executor.invoke("hello") == "Streamed"
