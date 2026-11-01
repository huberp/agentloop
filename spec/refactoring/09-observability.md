# Phase 9 — Observability: Tracing, Logging & Token Accounting

## Objective

Replace the custom `FileTracer` / `NoopTracer` layer with **Logfire** as the primary observability backend (PydanticAI's native instrumentation), retaining `FileTracer` as a token-free fallback.

---

## Background

### Current Architecture

```
src/observability.ts   FileTracer / NoopTracer (custom JSON trace files)
src/context.ts         countTokens(), trimMessages() — js-tiktoken
```

### PydanticAI / First-Party Ecosystem Used

| Built-in / Package | Replaces |
|---|---|
| **`logfire.instrument_pydantic_ai()`** | Custom `FileTracer` (agent traces, token/cost, tool calls) |
| `RunResult.usage()` → `Usage` | `js-tiktoken` manual token counting |
| `UsageLimits(total_tokens_limit=...)` | Custom `maxTokensBudget` enforcement loop |
| `FileTracer` (retained) | Logfire fallback for air-gapped / token-free environments |

---

## Deliverables

### 9.1 — Logfire Integration (Primary Path)

When `LOGFIRE_TOKEN` is set, configure Logfire at startup:

```python
import logfire
from pydantic_ai import Agent

logfire.configure()              # reads LOGFIRE_TOKEN from env
logfire.instrument_pydantic_ai() # one-line: traces all agent runs, tool calls, token costs
logfire.instrument_httpx()       # traces outbound HTTP (web-fetch tool, MCP, etc.)
```

This provides:
- Full distributed traces per agent run (including delegate/subagent calls)
- Token counts and cost per model call
- Tool invocation spans with arguments and results
- Exception capture in context
- OTel export to any compatible backend (Jaeger, Datadog, etc.)

No `FileTracer`, no custom span recording — Logfire handles it all.

### 9.2 — FileTracer (Fallback)

Retained for environments without a Logfire token or network access:

```python
class FileTracer:
    def __init__(self, output_dir: Path, cost_per_input: float, cost_per_output: float): ...
    async def record(self, invocation_id: str, event: dict) -> None:
        """Append event as JSON line to output_dir/<invocation_id>.jsonl"""
        ...
```

Activated when `settings.tracing_enabled` is `True` and `LOGFIRE_TOKEN` is absent.

### 9.3 — Token Accounting

After each `agent.run()` call, extract usage from the result:

```python
result = await agent.run(
    prompt,
    deps=deps,
    usage_limits=UsageLimits(total_tokens_limit=settings.max_tokens_budget),
)
usage = result.usage()
# usage.request_tokens, usage.response_tokens, usage.total_tokens
```

- `UsageLimits` replaces the custom `maxTokensBudget` enforcement — PydanticAI raises `UsageLimitExceeded` automatically.
- When Logfire is active, token counts and costs are captured in traces automatically; no separate recording call is needed.
- When using `FileTracer`, record `usage` fields manually.

### 9.4 — Context Window Management (`src/agentloop/context.py`)

- `UsageLimits` prevents over-budget calls at runtime.
- Provide `trim_messages(history, max_tokens, model)` using `tiktoken` (Python) for pre-call estimates when needed.
- `trimMessages()` from TypeScript maps directly to this utility.

### 9.5 — Tracer Abstraction (Minimal)

```python
from typing import Protocol

class Tracer(Protocol):
    async def record(self, invocation_id: str, event: dict) -> None: ...
    async def close(self) -> None: ...

class NoopTracer:
    async def record(self, *_): pass
    async def close(self): pass

def create_tracer(settings: Settings) -> Tracer:
    if settings.tracing_enabled and not os.getenv("LOGFIRE_TOKEN"):
        return FileTracer(...)
    return NoopTracer()   # Logfire handles tracing when token is present
```

`set_tracer()` is exported for test injection — mirrors `setTracer()` from `index.ts`.

### 9.6 — Logging (`src/agentloop/logger.py`)

`structlog` with JSON output, unchanged from Phase 1. When Logfire is active, `logfire.configure()` also captures Python log records automatically — no duplicate setup required.

---

## Acceptance Criteria

- [ ] When `LOGFIRE_TOKEN` is set, `logfire.instrument_pydantic_ai()` is called exactly once at startup.
- [ ] Agent runs produce Logfire spans with token counts.
- [ ] `UsageLimits` raises `UsageLimitExceeded` when `max_tokens_budget` is exceeded.
- [ ] `FileTracer` writes a JSONL trace file per invocation when Logfire is absent.
- [ ] `NoopTracer` produces no output.
- [ ] `set_tracer()` in tests overrides the global tracer.
- [ ] `trim_messages()` reduces history to fit within a token budget.

---

## Files Changed / Created

| Action | Path |
|---|---|
| Create | `src/agentloop/observability.py` |
| Create | `src/agentloop/context.py` |
| Update | `src/agentloop/logger.py` (structlog final config) |
| Update | `src/agentloop/executor.py` (inject UsageLimits + tracer + logfire init) |
| Create | `tests/test_observability.py` |
| Delete (later) | `src/observability.ts`, `src/context.ts` |

---

## Dependencies Added

| Package | Purpose |
|---|---|
| `logfire[pydantic-ai]` | Primary observability — traces, tokens, costs (10 M spans/month free) |
| `tiktoken` | Pre-call token estimation for `trim_messages()` |

## Dependencies Removed

- `js-tiktoken` (npm)
- Custom `FileTracer` TypeScript implementation (Python version retained as fallback only)

