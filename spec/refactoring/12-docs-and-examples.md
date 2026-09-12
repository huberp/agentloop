# Phase 12 — Documentation & Examples Update

## Objective

Update all documentation and example files to reflect the Python/PydanticAI implementation. Remove all LangChain/TypeScript references. Add PydanticAI-specific guides. Delete the TypeScript source tree.

---

## Deliverables

### 12.1 — README.md

Rewrite `README.md` completely:

- Change "TypeScript LangChain Agent Loop" → "Python PydanticAI Agent Loop" in title and description.
- Update **Requirements**: Python ≥ 3.11, `uv` or `pip`.
- Update **Quick Start**: `uv sync` / `pip install -e .`, `cp .env.example .env`, `agentloop` CLI.
- Update **Programmatic API** section:

  ```python
  from agentloop import AgentExecutor

  executor = AgentExecutor()
  await executor.initialize()

  # Non-streaming
  result = await executor.invoke("Summarize this project")
  print(result)

  # Streaming
  async for token in executor.stream("What files changed recently?"):
      print(token, end="", flush=True)
  ```

- Update **Scripts** table: replace `npm run *` with `agentloop *` CLI commands and `uv run pytest`.
- Update **Keywords** in `pyproject.toml`: replace `langchain` with `pydantic-ai`.
- Add **PydanticAI** badge linking to `https://ai.pydantic.dev`.

### 12.2 — docs/getting-started.md

- Replace Node.js install steps with Python/uv install steps.
- Replace `.ts` code samples with `.py` equivalents.
- Update environment variable names to match Python `Settings` (underscore style).
- Add a note on `TestModel` for offline/CI testing.

### 12.3 — docs/architecture.md

- Update Mermaid diagrams:
  - Replace "LangChain `BaseChatModel`" node with "PydanticAI `Agent`".
  - Replace "LangGraph StateGraph" node with "Python `Orchestrator`".
  - Replace "Tool Registry → toLangChainTools()" with "Tool Registry → to_pydantic_ai_tools()".
  - Replace "InMemoryChatMessageHistory" with "list[ModelMessage]".
- Update the "Agent Loop Flow" section to reflect PydanticAI's internal loop (no manual ToolMessage injection shown).

### 12.4 — docs/tools.md

- Replace TypeScript `ToolDefinition` interface documentation with Python `ToolDefinition` dataclass.
- Replace Zod schema examples with Pydantic `BaseModel` examples.
- Update tool file path conventions (`src/agentloop/tools/` instead of `src/tools/`).
- Update the "Adding a Custom Tool" walkthrough:

  ```python
  # src/agentloop/tools/my_tool.py
  from pydantic import BaseModel
  from pydantic_ai import RunContext
  from agentloop.tools.registry import tool_def
  from agentloop.agents.types import AgentDeps

  class MyToolInput(BaseModel):
      message: str

  @tool_def(name="my_tool", description="Echo a message", permissions="safe")
  async def my_tool(ctx: RunContext[AgentDeps], args: MyToolInput) -> str:
      return f"Echo: {args.message}"
  ```

### 12.5 — docs/configuration.md

- Replace all TypeScript env-var docs with Python equivalents.
- Add a table column "pydantic-settings field name" alongside "env var name".
- Remove `MCP_SERVERS` raw JSON note; replace with `McpServerConfig` Pydantic model docs.
- Add `LOGFIRE_TOKEN` as optional observability config.

### 12.6 — docs/extending.md

- Update "Add a custom tool" (see §12.4 above).
- Update "Create subagents" to use Python `asyncio.gather()` pattern.
- Update "Connect MCP servers" to use `MCPServerStdio` / `MCPServerHTTP`.
- Remove "Add a LangGraph step" section (LangGraph is removed).

### 12.7 — docs/security.md

- Update threat model to reflect Python tool sandboxing.
- Update path traversal section to reference `sanitize.py`.
- No conceptual changes to the security model itself.

### 12.8 — docs/testing.md

- Replace `MockChatModel` docs with `TestModel` from PydanticAI.
- Replace Jest examples with `pytest` examples.
- Add `pytest-asyncio` setup instructions.
- Add `TestModel(custom_output_text=...)` quick-start example.

### 12.9 — docs/usage.md

- Update subagent / orchestrator examples to Python.
- Update streaming example to `agent.run_stream()`.
- Replace `npm run oneshot` with `agentloop agent`.

### 12.10 — docs/search-providers.md and docs/langgraph-log-assessment.md

- `search-providers.md`: update provider configuration to Python env vars.
- `langgraph-log-assessment.md`: archive or delete (LangGraph is removed). If kept, rename to `langgraph-removal-notes.md` and document the migration rationale.

### 12.11 — docs/examples/

- Update `repo-config.json` and `user-config.json` to use underscore-style keys matching `pydantic-settings` field names.

### 12.12 — TypeScript Source Removal

Once all phases (1–11) pass their acceptance criteria:

1. Delete `src/**/*.ts` (all TypeScript source files).
2. Delete `src/**/*.js` (compiled outputs if present).
3. Delete `tsconfig.json`, `jest.config.js`, `jest.e2e.config.js`.
4. Remove all npm packages from `package.json`.
5. Delete `package.json`, `package-lock.json` (or `node_modules/`).
6. Retain `src/agentloop/` (Python) and `tests/` (Python).
7. Update `.gitignore` to add Python artifacts (`__pycache__/`, `*.pyc`, `.venv/`, `dist/`).

### 12.13 — Changelog / Migration Guide

Create `docs/migration-from-typescript.md`:

- Summarise the language + framework change.
- List all removed npm packages and their Python replacements.
- Provide a before/after API comparison table.
- Document any behavioural differences (e.g. Zod vs Pydantic validation messages).

---

## Acceptance Criteria

- [ ] `grep -r "langchain\|langgraph\|LangChain\|LangGraph" docs/` returns no matches.
- [ ] `grep -r "langchain\|langgraph" README.md` returns no matches.
- [ ] All code samples in docs are valid Python.
- [ ] `docs/tools.md` custom tool example matches the `@tool_def` API from Phase 3.
- [ ] `docs/testing.md` `TestModel` example runs without error.
- [ ] `docs/configuration.md` lists every field from `Settings`.
- [ ] TypeScript source tree is deleted.
- [ ] `npm test` no longer runs (no `package.json`).
- [ ] `pytest` is the sole test runner.

---

## Files Changed

| Action | Path |
|---|---|
| Rewrite | `README.md` |
| Rewrite | `docs/getting-started.md` |
| Update | `docs/architecture.md` |
| Rewrite | `docs/tools.md` |
| Rewrite | `docs/configuration.md` |
| Update | `docs/extending.md` |
| Update | `docs/security.md` |
| Rewrite | `docs/testing.md` |
| Update | `docs/usage.md` |
| Update | `docs/search-providers.md` |
| Archive/Delete | `docs/langgraph-log-assessment.md` |
| Update | `docs/examples/repo-config.json` |
| Update | `docs/examples/user-config.json` |
| Create | `docs/migration-from-typescript.md` |
| Delete | `src/**/*.ts` (all TypeScript) |
| Delete | `tsconfig.json`, `jest*.config.js`, `package.json` |
