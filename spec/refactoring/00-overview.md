# Refactoring Plan: LangChain → PydanticAI

## Goal

Replace all LangChain / LangGraph dependencies with **PydanticAI** while keeping every user-visible feature intact. PydanticAI built-in capabilities are preferred over re-implementing custom equivalents.

> **Language note:** PydanticAI is a Python library. Because this repository is TypeScript/Node.js, the refactoring requires a language migration from TypeScript to Python in addition to the framework swap. All spec documents below address both dimensions.

---

## Now-vs-PydanticAI Mapping Table

| # | Current (LangChain/TypeScript) | Concern | PydanticAI Equivalent | Effort |
|---|---|---|---|---|
| 1 | `@langchain/core` messages (`HumanMessage`, `AIMessage`, `SystemMessage`, `ToolMessage`) | Message model | `pydantic_ai.messages.*` (built-in typed message types) | Medium |
| 2 | `BaseChatModel` + `ChatMistralAI` from `@langchain/mistralai` | LLM provider | `pydantic_ai.Agent(model='mistral:...')` with built-in provider | Medium |
| 3 | `llm.bindTools(tools)` + manual tool-call loop in `index.ts` | Agent loop | `pydantic_ai.Agent` — built-in agentic loop; no manual iteration needed | High |
| 4 | Custom `ToolRegistry` + `tool()` from `@langchain/core/tools` | Tool registration | `@agent.tool` decorator / `Tool` dataclass; `Agent.run()` discovers tools automatically | High |
| 5 | `z.ZodTypeAny` schema on each tool | Input validation | Pydantic `BaseModel` subclass as tool input type; validation is automatic | Medium |
| 6 | `ToolPermissionManager` (custom blocklist/allowlist + `ConcurrencyLimiter`) | Security / permissions | `pydantic_ai.Agent` `prepare` hook + `RunContext`; semaphore for concurrency | Medium |
| 7 | `InMemoryChatMessageHistory` from `@langchain/core/chat_history` | Conversation history | `pydantic_ai.Agent.run(message_history=...)` built-in parameter | Low |
| 8 | `withRetry()` + exponential back-off (custom `retry.ts`) | LLM retries | `pydantic_ai` built-in retry via `retries=` on `Agent` and per-tool | Low |
| 9 | `invokeWithTimeout()` (custom race against `setTimeout`) | Tool timeouts | `asyncio.wait_for()` in tool wrapper; or built-in `timeout=` where available | Low |
| 10 | `streamWithTools()` in `streaming.ts` + manual `ToolCallChunk` assembly | Streaming | `Agent.run_stream()` built-in async iterator; no manual chunk assembly | High |
| 11 | `McpClient` + `registerMcpTools` (custom MCP bridge in `mcp/`) | MCP integration | `pydantic_ai.mcp.MCPServerStdio` / `MCPServerHTTP` (built-in MCP support) | High |
| 12 | `@langchain/langgraph` compiler/scheduler/graph | Multi-step orchestration | `pydantic_ai.Agent` multi-turn + custom `Orchestrator` using `asyncio`; no LangGraph | High |
| 13 | `SubagentManager.runParallel` (custom parallel runner) | Parallel subagents | `asyncio.gather()` over multiple `Agent.run()` calls | Medium |
| 14 | `AgentProfile` JSON files + `activateProfile()` | Agent profiles | Pydantic `BaseModel` config + `Agent` constructor kwargs; profiles become Python dataclasses | Medium |
| 15 | `skillRegistry` + markdown skill injection | Skills | System-prompt assembly; no built-in equivalent — thin custom layer retained | Low |
| 16 | `PromptRegistry` + versioned prompt history | Prompt management | Plain Python + Pydantic models; no equivalent in PydanticAI — thin custom layer | Low |
| 17 | `FileTracer` / `NoopTracer` (custom observability) | Observability / tracing | `pydantic_ai` `instrument=True` (Logfire integration) or custom `UsageLimits` + callbacks | Medium |
| 18 | `js-tiktoken` token counting + `trimMessages()` | Context window mgmt | `pydantic_ai.settings.UsageLimits` + `tiktoken` Python package | Low |
| 19 | `pino` structured logger | Logging | `structlog` or `python-json-logger`; same JSON-structured output | Low |
| 20 | `dotenv` + layered config (`config/load.ts`, `config/schema.ts`) | Configuration | `pydantic-settings` `BaseSettings` (env + YAML/JSON files, same layering) | Medium |
| 21 | `ink` + React TUI | Terminal UI | `textual` or `rich` Python TUI | Medium |
| 22 | `tsx` / TypeScript build chain | Runtime / build | Python packaging (`pyproject.toml`, `uv` or `pip`) | Low |
| 23 | `jest` + `ts-jest` test suite | Testing | `pytest` + `pytest-asyncio`; `pydantic_ai.models.test.TestModel` for mocking | High |
| 24 | `MockChatModel` + fixture recording (`testing/`) | LLM mocking | `pydantic_ai.models.test.TestModel` (built-in); `pytest` fixtures | Medium |

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

1. **Use PydanticAI built-ins first.** Custom code is only written when PydanticAI has no equivalent.
2. **Feature parity before new features.** Every user-visible capability must work before any enhancement is added.
3. **One phase at a time.** Each phase delivers a runnable, testable increment.
4. **Pydantic everywhere.** All data structures (config, tool inputs, agent profiles) are `BaseModel` subclasses.
5. **Python packaging best practices.** `pyproject.toml` with `uv` lockfile; type-checked with `mypy` or `pyright`.
