# Phase 3 — Tool System: Definitions, Registry & Validation

## Objective

Replace the custom `ToolRegistry` + LangChain `tool()` wrapper + Zod schemas with **PydanticAI's native tool system** (`@agent.tool`, `Tool` dataclass, and Pydantic `BaseModel` input types).

---

## Background

### Current Architecture

```
src/tools/registry.ts   ToolRegistry class
                         - register(ToolDefinition)
                         - loadFromDirectory()        ← dynamic discovery
                         - toLangChainTools()         ← binds to LLM

src/tools/*.ts          Each file exports `toolDefinition: ToolDefinition`
                         - name, description, schema (Zod), execute (fn)
                         - permissions, timeout, mutatesFile, source, filePath
```

### PydanticAI Built-Ins Used

| Built-in | Replaces |
|---|---|
| `@agent.tool` decorator / `Tool` dataclass | `tool()` from LangChain + Zod schema |
| Pydantic `BaseModel` parameter types | `z.ZodTypeAny` schema |
| Automatic JSON schema generation | Manual Zod → JSON schema conversion |
| `RunContext` passed to tools | Manual argument passing |

---

## Deliverables

### 3.1 — Tool Definition Convention

Each tool lives in its own file under `src/agentloop/tools/`. It exports:

```python
# src/agentloop/tools/file_read.py
from pydantic import BaseModel
from pydantic_ai import RunContext
from agentloop.tools.registry import tool_def

class FileReadInput(BaseModel):
    path: str
    start_line: int | None = None
    end_line: int | None = None

@tool_def(
    name="file_read",
    description="Read a file from the workspace",
    permissions="safe",
    timeout_ms=5000,
)
async def file_read(ctx: RunContext, args: FileReadInput) -> str:
    ...
```

- `BaseModel` subclass provides type-safe input validation and automatic JSON schema generation — replaces Zod schema.
- `RunContext` carries injected dependencies (workspace root, settings, permission manager).
- `@tool_def` is a thin decorator defined in `src/agentloop/tools/registry.py` that records metadata (permissions, timeout, mutates_file) alongside the function.

### 3.2 — ToolDefinition Dataclass

```python
@dataclass
class ToolDefinition:
    name: str
    description: str
    fn: Callable
    permissions: Literal["safe", "cautious", "dangerous"] = "safe"
    timeout_ms: int | None = None
    mutates_file: Callable[[dict], str | None] | None = None
    source: Literal["built-in", "custom", "mcp"] | None = None
    file_path: str | None = None
```

- Replaces the TypeScript `ToolDefinition` interface exactly.

### 3.3 — ToolRegistry (`src/agentloop/tools/registry.py`)

```python
class ToolRegistry:
    def register(self, defn: ToolDefinition) -> None: ...
    def unregister(self, name: str) -> None: ...
    def get(self, name: str) -> ToolDefinition | None: ...
    def list(self) -> list[dict]: ...
    def get_all(self) -> list[dict]: ...
    async def load_from_directory(self, dir_path: Path, source: str) -> None: ...
    def to_pydantic_ai_tools(self) -> list[Tool]: ...
```

- `load_from_directory()` imports each `.py` file in the tools directory and collects objects tagged by `@tool_def`.
- `to_pydantic_ai_tools()` converts `ToolDefinition` list into PydanticAI `Tool` objects for `Agent(tools=...)`.

**No central list is needed** — dynamic discovery is identical to the TypeScript version.

### 3.4 — Migrate All 22 Built-in Tools

Migrate each tool file from TypeScript to Python:

| Tool | File |
|---|---|
| file_read | `tools/file_read.py` |
| file_write | `tools/file_write.py` |
| file_edit | `tools/file_edit.py` |
| file_delete | `tools/file_delete.py` |
| file_list | `tools/file_list.py` |
| shell | `tools/shell.py` |
| code_search | `tools/code_search.py` |
| code_run | `tools/code_run.py` |
| diff | `tools/diff.py` |
| patch | `tools/patch.py` |
| git_status | `tools/git_status.py` |
| git_log | `tools/git_log.py` |
| git_diff | `tools/git_diff.py` |
| git_commit | `tools/git_commit.py` |
| git_branch | `tools/git_branch.py` |
| git_checkout | `tools/git_checkout.py` |
| git_push | `tools/git_push.py` |
| web_search | `tools/web_search.py` |
| web_fetch | `tools/web_fetch.py` |
| calculate | `tools/calculate.py` |
| search | `tools/search.py` |
| sanitize (internal helper) | `tools/sanitize.py` |

Each file preserves the original tool's documented inputs, outputs, and behaviour. Python equivalents used:

| TypeScript dep | Python replacement |
|---|---|
| `simple-git` | `gitpython` |
| `diff` (npm) | `difflib` (stdlib) |
| `duck-duck-scrape` | `duckduckgo-search` |
| `@mozilla/readability` + `jsdom` | `readability-lxml` / `trafilatura` |
| `turndown` | `markdownify` |
| `mathjs` | `sympy` / `asteval` |

### 3.5 — Arg Repair

The TypeScript `tools/arg-repair.ts` handles malformed JSON tool arguments from the LLM. PydanticAI validates tool inputs via Pydantic automatically and returns structured validation errors to the model for self-correction. No custom arg-repair layer is needed. If the pattern is still required for edge cases, implement it as a `Tool.prepare` hook.

### 3.6 — Tool Sanitize / Security Helpers

Migrate `src/tools/sanitize.ts` to `src/agentloop/tools/sanitize.py`:
- Path traversal prevention
- Shell injection detection
- Output size truncation

These helpers are called within each tool's `async def` body, unchanged in logic.

---

## Acceptance Criteria

- [ ] All 22 tools are importable without error.
- [ ] `tool_registry.load_from_directory(...)` discovers all tools automatically.
- [ ] Each tool's Pydantic model validates inputs (wrong types raise `ValidationError`).
- [ ] `tool_registry.to_pydantic_ai_tools()` returns a list that `Agent(tools=...)` accepts.
- [ ] Unit tests for each tool pass using mocked filesystem/shell/network.

---

## Files Changed / Created

| Action | Path |
|---|---|
| Create | `src/agentloop/tools/__init__.py` |
| Create | `src/agentloop/tools/registry.py` |
| Create | `src/agentloop/tools/sanitize.py` |
| Create | `src/agentloop/tools/file_read.py` (+ 21 others) |
| Create | `tests/test_tools.py` |
| Delete (later) | `src/tools/*.ts` |

---

## Dependencies Removed (eventually)

- `@langchain/core/tools` — `tool()` function and `StructuredToolInterface`
- `zod` — replaced by Pydantic
- `js-tiktoken` — replaced by `tiktoken` (Python)
- `diff` (npm) — replaced by `difflib`
