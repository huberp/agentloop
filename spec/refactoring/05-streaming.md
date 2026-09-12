# Phase 5 — Streaming Output

## Objective

Replace the manual `ToolCallChunk` assembly loop in `src/streaming.ts` with **PydanticAI's built-in `Agent.run_stream()`**.

---

## Background

### Current Architecture

```
src/streaming.ts   streamWithTools()
                    - mirrors executeWithTools() but uses llmWithTools.stream()
                    - manually accumulates ToolCallChunk fragments
                    - appends ToolMessages, re-enters stream loop
                    - yields text deltas to the CLI
```

This is one of the most complex files in the codebase (~200 lines). PydanticAI replaces it with a single `async with agent.run_stream(...) as stream:` call.

### PydanticAI Built-Ins Used

| Built-in | Replaces |
|---|---|
| `agent.run_stream()` | `streamWithTools()` manual chunk loop |
| `StreamedRunResult.stream_text(delta=True)` | Manual text delta extraction |
| `StreamedRunResult.get_output()` | Final result after streaming |

---

## Deliverables

### 5.1 — Streaming Executor (`src/agentloop/streaming.py`)

```python
from pydantic_ai import Agent
from pydantic_ai.result import StreamedRunResult
from agentloop.agent import AgentDeps
from collections.abc import AsyncIterator

async def stream_with_tools(
    agent: Agent,
    prompt: str,
    history: list,
    deps: AgentDeps,
) -> AsyncIterator[str]:
    async with agent.run_stream(
        prompt,
        message_history=history,
        deps=deps,
    ) as stream:
        async for delta in stream.stream_text(delta=True):
            yield delta
    history.extend(stream.all_messages())
```

- Total implementation: ~15 lines, replacing ~200 lines in `streaming.ts`.
- Tool calls are handled internally by PydanticAI; no manual chunk assembly.

### 5.2 — AgentExecutor.stream() Update

Update `executor.py` (Phase 2) to use `stream_with_tools()`:

```python
async def stream(self, prompt: str, profile: str | None = None) -> AsyncIterator[str]:
    await self._ensure_initialized()
    agent = self._get_agent(profile)
    deps = self._make_deps()
    async for token in stream_with_tools(agent, prompt, self._history, deps):
        yield token
```

### 5.3 — CLI Streaming Integration (preview for Phase 10)

The CLI (Phase 10) uses `async for token in executor.stream(prompt): print(token, end="", flush=True)`.

This replaces the `STREAMING_ENABLED` env-var branch in `start-cli.ts`.

### 5.4 — Streaming Enabled Flag

`settings.streaming_enabled` controls whether `AgentExecutor.invoke()` internally uses `run_stream` (collecting and returning the concatenated result) or `run()`. Both paths share the same conversation history update.

---

## Acceptance Criteria

- [ ] `AgentExecutor.stream("Hello")` yields text tokens incrementally.
- [ ] Tool calls within a streaming turn complete transparently; tokens appear before and after tool results.
- [ ] Conversation history is correctly updated after a streaming turn.
- [ ] Streaming tests use `TestModel` (no real API calls).

---

## Files Changed / Created

| Action | Path |
|---|---|
| Create | `src/agentloop/streaming.py` |
| Update | `src/agentloop/executor.py` |
| Create | `tests/test_streaming.py` |
| Delete (later) | `src/streaming.ts` |

---

## Dependencies Removed

- Manual `ToolCallChunk` accumulation logic (no equivalent npm package)
