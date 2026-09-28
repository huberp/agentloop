# Refactoring Plan: LangChain → PydanticAI

## Goal

Replace all LangChain / LangGraph dependencies with **PydanticAI** while keeping every user-visible feature intact. PydanticAI built-in capabilities are preferred over re-implementing custom equivalents.

> **Language note:** PydanticAI is a Python library. Because this repository is TypeScript/Node.js, the refactoring requires a language migration from TypeScript to Python in addition to the framework swap. All spec documents below address both dimensions.

---

## Now-vs-PydanticAI Mapping Table

> **Coverage key:** ✅ PydanticAI built-in · 📦 First-party ecosystem (pydantic-ai-skills, Logfire) · 🔧 Thin custom layer needed

| # | Current (LangChain/TypeScript) | Concern | PydanticAI / Ecosystem Equivalent | Effort |
|---|---|---|---|---|
| 1 | `@langchain/core` messages | Message model | ✅ `pydantic_ai.messages.*` built-in typed message types | Low |
| 2 | `BaseChatModel` + `ChatMistralAI` | LLM provider | ✅ `Agent(model='mistral:...')` — built-in Mistral (+ OpenAI, Anthropic, Ollama, …) | Low |
| 3 | `llm.bindTools(tools)` + manual tool-call loop | Agent loop | ✅ `Agent` built-in agentic loop; no manual iteration | High |
| 4 | Custom `ToolRegistry` + LangChain `tool()` | Tool registration | ✅ `@agent.tool` / `Tool` dataclass; auto-discovered by `Agent(tools=[...])` | High |
| 5 | `z.ZodTypeAny` schema per tool | Input validation | ✅ Pydantic `BaseModel` parameter type; validation + JSON schema are automatic | Medium |
| 6 | `ToolPermissionManager` + `ConcurrencyLimiter` | Security / permissions | ✅ `Tool.prepare` hook + `RunContext[AgentDeps]`; `asyncio.Semaphore` for concurrency | Medium |
| 7 | `InMemoryChatMessageHistory` | Conversation history | ✅ `Agent.run(message_history=...)` + `RunResult.all_messages()` | Low |
| 8 | `withRetry()` + exponential back-off | LLM retries | ✅ `Agent(retries=N)` built-in retry; per-tool `max_retries` | Low |
| 9 | `invokeWithTimeout()` | Tool timeouts | 🔧 `asyncio.wait_for()` in each tool's body (no framework built-in) | Low |
| 10 | `streamWithTools()` + manual `ToolCallChunk` assembly | Streaming | ✅ `Agent.run_stream()` + `stream.stream_text(delta=True)` | High |
| 11 | `McpClient` + `registerMcpTools` custom bridge | MCP integration | ✅ `pydantic_ai.mcp.MCPServerStdio` / `MCPServerHTTP`; pass as `Agent(mcp_servers=[...])` | High |
| 12 | Custom `Orchestrator` / LangGraph graph | Multi-step orchestration | ✅ **"Agent as tool"** pattern (official PydanticAI multi-agent docs) + `asyncio.gather` for parallel steps | High |
| 13 | `SubagentManager.runParallel` | Parallel subagents | ✅ `asyncio.gather()` over delegate agent `.run()` calls; usage propagated via `ctx.usage` | Medium |
| 14 | `AgentProfile` JSON + `activateProfile()` | Agent profiles | ✅ `pydantic-settings` `BaseSettings` sub-model per profile; `Agent(**profile.model_dump())` | Medium |
| 15 | `skillRegistry` + markdown skill injection | Skills | 📦 **`pydantic-ai-skills`** (PyPI) — progressive-disclosure skill loader with local/remote registries; replaces custom `SkillRegistry` | Low |
| 16 | `PromptRegistry` + versioned prompts | Prompt management | 🔧 Plain Python strings with `.format()`; thin custom registry (no PydanticAI equivalent) | Low |
| 17 | `FileTracer` / `NoopTracer` | Observability / tracing | 📦 **Logfire** (`logfire.instrument_pydantic_ai()`) as primary — spans, tokens, costs, OTel export; `FileTracer` retained as no-token fallback | Medium |
| 18 | `js-tiktoken` + `trimMessages()` | Context window mgmt | ✅ `UsageLimits(total_tokens_limit=...)` enforced by PydanticAI; `tiktoken` (Python) for pre-call estimates | Low |
| 19 | `pino` structured logger | Logging | 🔧 `structlog` JSON logger (no PydanticAI equivalent; `logfire` subsumes in instrumented envs) | Low |
| 20 | `dotenv` + layered config | Configuration | ✅ `pydantic-settings` `BaseSettings` — env, dotenv, JSON/YAML layering | Medium |
| 21 | `ink` + React TUI | Terminal UI | 🔧 `textual` (TUI) + `click` + `rich` (CLI/spinner) | Medium |
| 22 | `tsx` / TypeScript build chain | Runtime / build | 🔧 `pyproject.toml` + `uv` lockfile | Low |
| 23 | `jest` + `ts-jest` | Testing | ✅ `pytest` + `pytest-asyncio`; `pydantic_ai.models.test.TestModel` for LLM mocking | High |
| 24 | `MockChatModel` + fixture recording | LLM mocking | ✅ `pydantic_ai.models.test.TestModel` built-in; `pytest` fixtures | Medium |

---

## Phased Delivery

| Phase | Spec | Title |
|---|---|---|
| 1 | [01-foundation.md](01-foundation.md) | Project scaffold, packaging, config |
| 2 | [02-llm-and-agent-loop.md](02-llm-and-agent-loop.md) | LLM provider, agent loop, history |
| 3 | [03-tool-system.md](03-tool-system.md) | Tool definitions, registry, validation |
| 4 | [04-security-and-permissions.md](04-security-and-permissions.md) | Permission manager, concurrency, timeouts |
| 5 | [05-streaming.md](05-streaming.md) | Streaming output |
| 6 | [06-mcp-integration.md](06-mcp-integration.md) | MCP server support |
| 7 | [07-orchestration-and-subagents.md](07-orchestration-and-subagents.md) | Multi-step planner, parallel subagents |
| 8 | [08-agent-profiles-and-skills.md](08-agent-profiles-and-skills.md) | Profiles, skills, prompts |
| 9 | [09-observability.md](09-observability.md) | Tracing, logging, token accounting |
| 10 | [10-ui-and-cli.md](10-ui-and-cli.md) | CLI, one-shot, TUI |
| 11 | [11-testing.md](11-testing.md) | Test suite migration |
| 12 | [12-docs-and-examples.md](12-docs-and-examples.md) | Documentation and examples update |

---

## Guiding Principles

1. **PydanticAI built-ins first.** Custom code is written only when PydanticAI and its first-party ecosystem have no equivalent.
2. **First-party ecosystem second.** Use `pydantic-ai-skills` (skills), Logfire (observability), `pydantic-settings` (config) before writing custom layers.
3. **Feature parity before new features.** Every user-visible capability must work before any enhancement is added.
4. **One phase at a time.** Each phase delivers a runnable, testable increment.
5. **Pydantic everywhere.** All data structures (config, tool inputs, agent profiles) are `BaseModel` subclasses.
6. **Python packaging best practices.** `pyproject.toml` with `uv` lockfile; type-checked with `mypy` or `pyright`.
