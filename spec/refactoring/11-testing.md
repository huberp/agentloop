# Phase 11 — Test Suite Migration

## Objective

Migrate the full Jest + `ts-jest` test suite (~55 test files) to **`pytest` + `pytest-asyncio`**, using **`pydantic_ai.models.test.TestModel`** as the built-in LLM mock.

---

## Background

### Current Test Architecture

```
src/__tests__/
  index.test.ts          Agent loop (mock LLM)
  streaming.test.ts      Streaming (mock LLM)
  security.test.ts       ToolPermissionManager
  registry.test.ts       ToolRegistry
  llm.test.ts            createLLM factory
  mcp.test.ts            MCP integration
  subagents.test.ts      SubagentManager
  langgraph.test.ts      LangGraph orchestrator
  observability.test.ts  FileTracer / NoopTracer
  config-layered.test.ts Layered config
  ... (45 more)

src/testing/
  mock-chat-model.ts     MockChatModel (records/replays LLM responses)
  recorder.ts            Response recorder
```

### PydanticAI Built-Ins Used for Testing

| Built-in | Replaces |
|---|---|
| `pydantic_ai.models.test.TestModel` | `MockChatModel` in `testing/mock-chat-model.ts` |
| `TestModel(custom_output_text=...)` | Static response fixtures |
| `TestModel(custom_result_args=...)` | Structured output mocking |
| `pytest-asyncio` | Jest async test support |

---

## Deliverables

### 11.1 — Test Infrastructure (`tests/conftest.py`)

```python
import pytest
from pydantic_ai.models.test import TestModel
from agentloop.config import Settings
from agentloop.executor import AgentExecutor

@pytest.fixture
def test_model():
    return TestModel()

@pytest.fixture
def test_settings():
    return Settings(
        mistral_api_key="test-key",
        llm_provider="test",
    )

@pytest.fixture
async def executor(test_settings):
    ex = AgentExecutor(settings=test_settings, model=TestModel())
    await ex.initialize()
    return ex
```

### 11.2 — Test Mapping

| TypeScript test file | Python test file | Notes |
|---|---|---|
| `index.test.ts` | `tests/test_executor.py` | Uses `TestModel` |
| `streaming.test.ts` | `tests/test_streaming.py` | `TestModel` + `run_stream` |
| `security.test.ts` | `tests/test_security.py` | No LLM needed |
| `security-hardening.test.ts` | `tests/test_security_hardening.py` | |
| `registry.test.ts` | `tests/test_tool_registry.py` | |
| `llm.test.ts` | `tests/test_llm.py` | |
| `mcp.test.ts` | `tests/test_mcp.py` | Fake MCP server |
| `subagents.test.ts` | `tests/test_subagents.py` | `TestModel` |
| `langgraph.test.ts` | `tests/test_orchestrator.py` | LangGraph removed |
| `observability.test.ts` | `tests/test_observability.py` | Temp dir fixture |
| `config-layered.test.ts` | `tests/test_config.py` | `pydantic-settings` |
| `agent-profile.test.ts` | `tests/test_agent_profiles.py` | |
| `builtin-agent-profiles.test.ts` | `tests/test_builtin_profiles.py` | |
| `skills.test.ts` | `tests/test_skills.py` | |
| `builtin-skills.test.ts` | `tests/test_builtin_skills.py` | |
| `skill-injection.test.ts` | `tests/test_skill_injection.py` | |
| `prompts.test.ts` | `tests/test_prompts.py` | |
| `prompt-registry.test.ts` | `tests/test_prompt_registry.py` | |
| `prompt-versioning.test.ts` | `tests/test_prompt_versioning.py` | |
| `prompt-context.test.ts` | `tests/test_prompt_context.py` | |
| `file-tools.test.ts` | `tests/test_file_tools.py` | `tmp_path` fixture |
| `git-tools.test.ts` | `tests/test_git_tools.py` | Temp git repo |
| `shell.test.ts` | `tests/test_shell.py` | |
| `code-search.test.ts` | `tests/test_code_search.py` | |
| `code-run.test.ts` | `tests/test_code_run.py` | |
| `diff-patch.test.ts` | `tests/test_diff_patch.py` | |
| `search.test.ts` | `tests/test_search.py` | |
| `web-fetch.test.ts` | `tests/test_web_fetch.py` | `httpx` mock |
| `web-utils.test.ts` | `tests/test_web_utils.py` | |
| `sandbox.test.ts` | `tests/test_sandbox.py` | Docker mock |
| `retry.test.ts` | `tests/test_retry.py` | Removed (built-in) |
| `arg-repair.test.ts` | (removed — built into Pydantic) | |
| `mock-chat-model.test.ts` | `tests/test_test_model.py` | `TestModel` docs |
| `context.test.ts` | `tests/test_context.py` | |
| `error-recovery.test.ts` | `tests/test_error_recovery.py` | |
| `workspace.test.ts` | `tests/test_workspace.py` | |
| `instructions.test.ts` | `tests/test_instructions.py` | |
| `language-guardrails.test.ts` | `tests/test_language_guardrails.py` | |
| `project-explorer.test.ts` | `tests/test_project_explorer.py` | |
| `start-oneshot.test.ts` | `tests/test_cli.py` | `click.testing.CliRunner` |
| `agent-activation.test.ts` | `tests/test_agent_activation.py` | |

### 11.3 — LLM Fixture Migration

Replace `MockChatModel` recording/replaying fixtures:
- Existing JSON response fixtures under `tests/fixtures/llm-responses/` are converted to `TestModel(custom_output_text=...)` calls.
- No `RECORD_LLM_RESPONSES` mechanism needed — `TestModel` is deterministic by default.

### 11.4 — `pytest` Configuration (`pyproject.toml`)

```toml
[tool.pytest.ini_options]
asyncio_mode = "auto"
testpaths = ["tests"]

[tool.mypy]
strict = true
plugins = ["pydantic.mypy"]
```

### 11.5 — Coverage Target

Maintain existing coverage levels (≥ 80 % line coverage for production modules). Add `pytest-cov` to dev dependencies.

---

## Acceptance Criteria

- [ ] `pytest` discovers all test files.
- [ ] All tests pass without a real API key.
- [ ] No test imports any LangChain or LangGraph symbol.
- [ ] `TestModel` is used in every test that previously used `MockChatModel`.
- [ ] Coverage does not decrease from the TypeScript baseline.

---

## Files Changed / Created

| Action | Path |
|---|---|
| Create | `tests/conftest.py` (updated) |
| Create | `tests/test_*.py` (one per mapping row above) |
| Delete (later) | `src/__tests__/*.test.ts` |
| Delete (later) | `src/testing/mock-chat-model.ts`, `src/testing/recorder.ts` |
| Delete (later) | `jest.config.js`, `jest.e2e.config.js` |

---

## Dependencies Added

| Package | Purpose |
|---|---|
| `pytest` | Test runner |
| `pytest-asyncio` | async test support |
| `pytest-cov` | Coverage reporting |

## Dependencies Removed

- `jest`, `ts-jest`, `@types/jest` (npm)
