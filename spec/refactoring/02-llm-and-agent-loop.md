# Phase 2 — LLM Provider, Agent Loop & Conversation History

## Objective

Replace `@langchain/mistralai`, `@langchain/core` messages, the manual agent loop in `src/index.ts`, and `InMemoryChatMessageHistory` with **PydanticAI's built-in `Agent`**, message types, and history handling.

---

## Background

### Current Architecture

```
src/llm.ts               createLLM() → ChatMistralAI (LangChain)
src/index.ts             executeWithTools():
                           1. chatHistory.addMessage(HumanMessage)
                           2. loop (≤ MAX_ITERATIONS):
                              a. llmWithTools.invoke(messages)
                              b. if no tool_calls → break
                              c. execute each tool_call → ToolMessage
                              d. append ToolMessages → repeat
src/streaming.ts         streamWithTools() — same loop with async iteration
```

The manual loop, message construction, and tool dispatch are all custom. PydanticAI handles all of this internally.

### PydanticAI Built-Ins Used

| Built-in | Replaces |
|---|---|
| `Agent(model=..., tools=[...])` | `createLLM()` + `llm.bindTools()` |
| `Agent.run(user_prompt, message_history=...)` | `executeWithTools()` manual loop |
| `Agent.run_stream(...)` | `streamWithTools()` |
| `pydantic_ai.messages.*` | `HumanMessage`, `AIMessage`, `SystemMessage`, `ToolMessage` |
| `Agent` `max_result_retries` / `retries` | `withRetry()` in `retry.ts` |
| `ModelSettings` | per-invocation temperature/token overrides |

---

## Deliverables

### 2.1 — LLM Factory (`src/agentloop/llm.py`)

```python
from pydantic_ai import Agent
from pydantic_ai.models.mistral import MistralModel
from agentloop.config import settings

def create_model() -> MistralModel:
    return MistralModel(
        model_name=settings.llm_model,
        api_key=settings.mistral_api_key.get_secret_value(),
    )
```

- Uses PydanticAI's `MistralModel` directly; no LangChain wrapper.
- Extension point: add `OpenAIModel`, `AnthropicModel`, etc. in a `switch` on `settings.llm_provider`.

### 2.2 — Agent Factory (`src/agentloop/agent.py`)

Create a factory function `create_agent(tools, system_prompt, profile)` that returns a configured `pydantic_ai.Agent`:

```python
agent = Agent(
    model=create_model(),
    system_prompt=system_prompt,
    tools=tools,           # list of @tool-decorated functions (Phase 3)
    retries=settings.llm_retry_max,
    model_settings=ModelSettings(temperature=settings.llm_temperature),
)
```

- `system_prompt` is assembled by the same logic as `getSystemPrompt()` in Phase 8.
- `retries=` replaces the custom `withRetry()` for LLM-level retries.
- Agent is **not** a module-level singleton; it is constructed per-session or per-profile activation.

### 2.3 — Conversation History

PydanticAI's `Agent.run()` accepts `message_history: list[ModelMessage]` and returns a `RunResult` that exposes `result.all_messages()` for the updated history.

```python
history: list[ModelMessage] = []

async def run_turn(user_input: str) -> str:
    result = await agent.run(user_input, message_history=history)
    history.extend(result.all_messages())
    return result.output
```

- Replaces `InMemoryChatMessageHistory` and `chatHistory.addMessage()`.
- History is stored as a Python list; the `ModelMessage` types from `pydantic_ai.messages` are Pydantic models (serialisable to JSON for persistence).

### 2.4 — Main Entry Point (`src/agentloop/executor.py`)

Expose the same public API as `src/index.ts`:

```python
class AgentExecutor:
    async def invoke(self, prompt: str, profile: str | None = None) -> str: ...
    async def stream(self, prompt: str) -> AsyncIterator[str]: ...
```

- `invoke()` delegates to `agent.run()`; no manual loop.
- `stream()` delegates to `agent.run_stream()` (see Phase 5).
- `ensureInitialized()` equivalent: lazy `asyncio.Lock`-guarded init that registers tools and loads profiles.

### 2.5 — MAX_ITERATIONS

PydanticAI does not expose a direct `max_iterations` setting; the closest is `max_result_retries`. Implement a thin `prepare` hook on the agent (see Phase 4) that counts tool calls and raises `pydantic_ai.exceptions.UnexpectedModelBehavior` if the limit is exceeded. Alternatively, wrap `agent.run()` with `asyncio.wait_for()` and a wall-clock timeout derived from `settings.execution_timeout_ms`.

### 2.6 — Provider Extension Point

Add a `create_model_for_provider(provider, model_name, api_key)` factory that maps provider names to PydanticAI model classes. Supported at Phase 2:

| Provider name | PydanticAI class |
|---|---|
| `"mistral"` | `MistralModel` |
| `"openai"` | `OpenAIModel` |
| `"anthropic"` | `AnthropicModel` |
| `"ollama"` | `OllamaModel` |

---

## Acceptance Criteria

- [ ] `AgentExecutor.invoke("Hello")` returns a non-empty string using the Mistral API.
- [ ] Conversation history accumulates across turns correctly.
- [ ] `settings.llm_retry_max` retries on transient errors without custom retry code.
- [ ] `create_model_for_provider("openai", ...)` returns an `OpenAIModel` instance.
- [ ] Unit tests use `pydantic_ai.models.test.TestModel` (no real API calls).

---

## Files Changed / Created

| Action | Path |
|---|---|
| Create | `src/agentloop/llm.py` |
| Create | `src/agentloop/agent.py` |
| Create | `src/agentloop/executor.py` |
| Create | `tests/test_executor.py` |
| Delete (later) | `src/llm.ts`, `src/index.ts`, `src/retry.ts`, `src/streaming.ts` |

---

## Dependencies Removed (eventually)

- `@langchain/core` (messages, history, runnables)
- `@langchain/mistralai`
- `InMemoryChatMessageHistory`
