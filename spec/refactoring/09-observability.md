# Phase 9 — Observability: Tracing, Logging & Token Accounting

## Objective

Port the `FileTracer` / `NoopTracer` observability layer and token-counting logic to Python, using PydanticAI's built-in `usage` tracking and optionally **Logfire** integration.

---

## Background

### Current Architecture

```
src/observability.ts   Tracer interface
                        FileTracer  — writes per-invocation JSON traces
                        NoopTracer  — no-op for prod / tests
                        newInvocationId()
                        createTracer()

src/context.ts         countTokens(), trimMessages()  (js-tiktoken)
```

### PydanticAI Built-Ins Used

| Built-in | Replaces |
|---|---|
| `RunResult.usage()` → `Usage(requests, request_tokens, response_tokens, total_tokens)` | Manual token counting in `context.ts` |
| `Agent(instrument=True)` | `FileTracer` (Logfire-based) |
| `UsageLimits(total_tokens_limit=...)` | `maxTokensBudget` enforcement |

---

## Deliverables

### 9.1 — Tracer Interface (`src/agentloop/observability.py`)

```python
from typing import Protocol

class Tracer(Protocol):
    async def record(self, invocation_id: str, event: dict) -> None: ...
    async def close(self) -> None: ...

class NoopTracer:
    async def record(self, invocation_id: str, event: dict) -> None: pass
    async def close(self) -> None: pass

class FileTracer:
    def __init__(self, output_dir: Path, cost_per_input: float, cost_per_output: float): ...
    async def record(self, invocation_id: str, event: dict) -> None:
        """Append event as JSON line to output_dir/<invocation_id>.jsonl"""
        ...
    async def close(self) -> None: ...

def create_tracer(settings: Settings) -> Tracer:
    if not settings.tracing_enabled:
        return NoopTracer()
    return FileTracer(
        output_dir=Path(settings.trace_output_dir),
        cost_per_input=settings.tracing_cost_per_input_token_usd,
        cost_per_output=settings.tracing_cost_per_output_token_usd,
    )
```

### 9.2 — Token Accounting

After each `agent.run()` call, extract usage from the result:

```python
result = await agent.run(prompt, deps=deps, usage_limits=UsageLimits(
    total_tokens_limit=settings.max_tokens_budget,
))
usage = result.usage()
tracer.record(invocation_id, {
    "input_tokens": usage.request_tokens,
    "output_tokens": usage.response_tokens,
    "total_tokens": usage.total_tokens,
    "cost_usd": (
        usage.request_tokens * settings.tracing_cost_per_input_token_usd +
        usage.response_tokens * settings.tracing_cost_per_output_token_usd
    ),
})
```

- `UsageLimits(total_tokens_limit=...)` replaces the custom `maxTokensBudget` enforcement in the agent loop.
- No `js-tiktoken` or manual token counting — PydanticAI provides actual counts from the model response.

### 9.3 — Context Window Management (`src/agentloop/context.py`)

The TypeScript `trimMessages()` truncates the message history when the token budget is exceeded. In Python:

- Use `tiktoken` (Python) to count tokens if a pre-call estimate is needed.
- Rely on `UsageLimits` to let the model reject calls that exceed the budget, then trim history and retry.
- Provide a `trim_messages(history, max_tokens, model)` utility function for cases where pre-trimming is preferred.

### 9.4 — Logfire Integration (Optional)

If `settings.tracing_enabled` and `LOGFIRE_TOKEN` is set, configure PydanticAI's built-in Logfire instrumentation:

```python
import logfire
logfire.configure()
agent = Agent(..., instrument=logfire)
```

This provides distributed traces, token counts, and cost accounting in the Logfire dashboard without any custom `FileTracer`. The `FileTracer` remains as a fallback for environments without Logfire.

### 9.5 — Logging (`src/agentloop/logger.py`) — Final Form

Integrate `structlog` with `pino`-compatible JSON output:

```python
import structlog

structlog.configure(
    processors=[
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.stdlib.add_log_level,
        structlog.processors.JSONRenderer(),
    ],
    wrapper_class=structlog.make_filtering_bound_logger(logging.INFO),
    logger_factory=structlog.PrintLoggerFactory(
        file=sys.stderr if settings.log_destination == "stderr" else sys.stdout
    ),
)
```

Log tool lifecycle events with the same structured fields as the TypeScript logger:
- invocation: `tool_name`, `call_id`, `args`
- completion: `tool_name`, `call_id`, `result_length`

### 9.6 — `setTracer()` Equivalent

Expose `set_tracer(tracer: Tracer) -> None` for test injection — mirrors `setTracer()` from `index.ts`.

---

## Acceptance Criteria

- [ ] `FileTracer` writes a JSONL trace file for each invocation.
- [ ] `NoopTracer` produces no output.
- [ ] `UsageLimits` stops the agent when `max_tokens_budget` is exceeded.
- [ ] Token counts appear in trace records.
- [ ] Cost calculation matches expected formula.
- [ ] Logger outputs valid JSON to the configured destination.
- [ ] `set_tracer()` in tests overrides the global tracer.

---

## Files Changed / Created

| Action | Path |
|---|---|
| Create | `src/agentloop/observability.py` |
| Create | `src/agentloop/context.py` |
| Update | `src/agentloop/logger.py` (structlog final config) |
| Update | `src/agentloop/executor.py` (inject UsageLimits + tracer) |
| Create | `tests/test_observability.py` |
| Delete (later) | `src/observability.ts`, `src/context.ts` |

---

## Dependencies Added

| Package | Purpose |
|---|---|
| `tiktoken` | Optional pre-call token estimation |
| `logfire` | Optional Logfire integration |

## Dependencies Removed

- `js-tiktoken` (npm)
- Custom `Tracer` TypeScript implementation
