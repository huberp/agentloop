from __future__ import annotations

import json
from pathlib import Path

import pytest
from pydantic_ai import Agent
from pydantic_ai.exceptions import UsageLimitExceeded
from pydantic_ai.models.test import TestModel

from agentloop.context import trim_messages
from agentloop.executor import AgentExecutor
from agentloop.observability import FileTracer, NoopTracer, create_tracer, initialize_logfire, set_tracer


@pytest.mark.asyncio
async def test_file_tracer_writes_jsonl(tmp_path: Path) -> None:
    tracer = FileTracer(tmp_path, 0.1, 0.2)
    await tracer.record("run-1", {"usage": {"input_tokens": 2, "output_tokens": 3}})
    payload = json.loads((tmp_path / "run-1.jsonl").read_text().splitlines()[0])
    assert payload["estimated_cost_usd"] == pytest.approx(0.8)


@pytest.mark.asyncio
async def test_noop_tracer_produces_no_output() -> None:
    tracer = NoopTracer()
    assert await tracer.record("run", {"x": 1}) is None
    assert await tracer.close() is None


def test_create_tracer_uses_file_tracer_when_enabled(monkeypatch: pytest.MonkeyPatch, test_settings) -> None:
    monkeypatch.delenv("LOGFIRE_TOKEN", raising=False)
    settings = test_settings.model_copy(update={"tracing_enabled": True, "trace_output_dir": str(test_settings.workspace_root / "traces")})
    assert isinstance(create_tracer(settings), FileTracer)


def test_initialize_logfire_once(monkeypatch: pytest.MonkeyPatch) -> None:
    from agentloop import observability as module

    calls: list[str] = []
    monkeypatch.setenv("LOGFIRE_TOKEN", "token")
    monkeypatch.setattr(module.logfire, "configure", lambda: calls.append("configure"))
    monkeypatch.setattr(module.logfire, "instrument_pydantic_ai", lambda: calls.append("pai"))
    monkeypatch.setattr(module.logfire, "instrument_httpx", lambda: calls.append("httpx"))
    monkeypatch.setattr(module, "_LOGFIRE_INITIALIZED", False)
    initialize_logfire()
    initialize_logfire()
    assert calls == ["configure", "pai", "httpx"]


@pytest.mark.asyncio
async def test_executor_uses_tracer_and_usage_limits(test_settings) -> None:
    records: list[dict[str, object]] = []

    class RecordingTracer:
        async def record(self, invocation_id: str, event: dict[str, object]) -> None:
            records.append({"invocation_id": invocation_id, **event})

        async def close(self) -> None:
            return None

    set_tracer(RecordingTracer())
    executor = AgentExecutor(
        settings=test_settings,
        model=TestModel(call_tools=[], custom_output_text="hello"),
    )
    assert await executor.invoke("hi") == "hello"
    assert records and records[0]["output"] == "hello"

    limited = AgentExecutor(
        settings=test_settings.model_copy(update={"max_tokens_budget": 1}),
        model=TestModel(call_tools=[], custom_output_text="hello"),
    )
    with pytest.raises(UsageLimitExceeded):
        await limited.invoke("too many tokens")
    set_tracer(None)


@pytest.mark.asyncio
async def test_trim_messages_reduces_history() -> None:
    agent = Agent(TestModel(call_tools=[], custom_output_text="hi"), defer_model_check=True)
    result1 = await agent.run("one")
    result2 = await agent.run("two", message_history=result1.new_messages())
    trimmed = trim_messages(result1.new_messages() + result2.new_messages(), max_tokens=60)
    assert len(trimmed) < len(result1.new_messages() + result2.new_messages())
