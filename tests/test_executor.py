from __future__ import annotations

from pathlib import Path

import pytest
from pydantic_ai.models.anthropic import AnthropicModel
from pydantic_ai.models.mistral import MistralModel
from pydantic_ai.models.ollama import OllamaModel
from pydantic_ai.models.openai import OpenAIChatModel
from pydantic_ai.models.test import TestModel

from agentloop.executor import AgentExecutor
from agentloop.llm import create_model_for_provider


@pytest.mark.asyncio
async def test_executor_invoke_returns_output(test_settings) -> None:
    executor = AgentExecutor(settings=test_settings, model=TestModel(custom_output_text="Hello from test"))
    assert await executor.invoke("Hi") == "Hello from test"


@pytest.mark.asyncio
async def test_executor_accumulates_history(test_settings) -> None:
    executor = AgentExecutor(settings=test_settings, model=TestModel(custom_output_text="done"))
    await executor.invoke("first")
    await executor.invoke("second")
    assert len(executor.get_history()) == 4


def test_create_model_for_supported_providers() -> None:
    assert isinstance(create_model_for_provider("mistral", "mistral-large-latest", "x"), MistralModel)
    assert isinstance(create_model_for_provider("openai", "gpt-4o-mini", "x"), OpenAIChatModel)
    assert isinstance(create_model_for_provider("anthropic", "claude-3-5-haiku-latest", "x"), AnthropicModel)
    assert isinstance(create_model_for_provider("ollama", "llama3.2", None), OllamaModel)


def test_executor_keeps_profile_histories_separate(test_settings) -> None:
    executor = AgentExecutor(settings=test_settings, model=TestModel(custom_output_text="ok"))
    assert executor.get_history("alpha") == []
    assert executor.get_history("beta") == []
