from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Protocol

import logfire

from agentloop.config import Settings


class Tracer(Protocol):
    async def record(self, invocation_id: str, event: dict[str, Any]) -> None: ...

    async def close(self) -> None: ...


class NoopTracer:
    async def record(self, invocation_id: str, event: dict[str, Any]) -> None:
        del invocation_id, event

    async def close(self) -> None:
        return None


class FileTracer:
    def __init__(self, output_dir: Path, cost_per_input: float, cost_per_output: float) -> None:
        self.output_dir = output_dir
        self.cost_per_input = cost_per_input
        self.cost_per_output = cost_per_output
        self.output_dir.mkdir(parents=True, exist_ok=True)

    async def record(self, invocation_id: str, event: dict[str, Any]) -> None:
        payload = dict(event)
        usage = payload.get("usage") or {}
        input_tokens = int(usage.get("input_tokens", 0))
        output_tokens = int(usage.get("output_tokens", 0))
        payload["estimated_cost_usd"] = (
            input_tokens * self.cost_per_input + output_tokens * self.cost_per_output
        )
        with (self.output_dir / f"{invocation_id}.jsonl").open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(payload, ensure_ascii=False) + "\n")

    async def close(self) -> None:
        return None


_LOGFIRE_INITIALIZED = False
_TRACER: Tracer | None = None


def initialize_logfire() -> None:
    global _LOGFIRE_INITIALIZED
    if _LOGFIRE_INITIALIZED or not os.getenv("LOGFIRE_TOKEN"):
        return
    logfire.configure()
    logfire.instrument_pydantic_ai()
    logfire.instrument_httpx()
    _LOGFIRE_INITIALIZED = True


def create_tracer(settings: Settings) -> Tracer:
    if settings.tracing_enabled and not os.getenv("LOGFIRE_TOKEN"):
        return FileTracer(
            Path(settings.trace_output_dir),
            settings.tracing_cost_per_input_token_usd,
            settings.tracing_cost_per_output_token_usd,
        )
    return NoopTracer()


def get_tracer(settings: Settings) -> Tracer:
    global _TRACER
    if _TRACER is None:
        _TRACER = create_tracer(settings)
    return _TRACER


def set_tracer(tracer: Tracer | None) -> None:
    global _TRACER
    _TRACER = tracer
