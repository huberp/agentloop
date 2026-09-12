# Phase 4 — Security, Permissions & Timeouts

## Objective

Port the `ToolPermissionManager`, `ConcurrencyLimiter`, and per-tool timeout logic from TypeScript to Python, integrating them with PydanticAI's `Tool.prepare` hook and `RunContext`.

---

## Background

### Current Architecture

```
src/security.ts   ToolPermissionManager
                    - check(toolName, args) → "allow" | "block" | "confirm"
                    - blocklist/allowlist enforcement
                    - shell injection detection

                  ConcurrencyLimiter
                    - semaphore-based cap on simultaneous tool runs

src/index.ts      executeWithTools():
                    - calls permissionManager.check() before each tool
                    - injects ToolBlockedError as ToolMessage on block
                    - wraps tool call with invokeWithTimeout()
```

The permission checks, concurrency limiting, and timeout logic are all wired manually in the agent loop. In PydanticAI, the `Tool.prepare` hook provides the correct interception point.

---

## Deliverables

### 4.1 — Permission Manager (`src/agentloop/security.py`)

```python
class PermissionManager:
    def __init__(self, settings: Settings): ...

    def check(self, tool_name: str, args: dict) -> Literal["allow", "block", "confirm"]:
        """Return allow/block/confirm for the given tool call."""
        ...
```

Logic (identical to TypeScript):
1. If `tool_name` is in `settings.tool_blocklist` → `"block"`.
2. If `settings.tool_allowlist` is non-empty and `tool_name` is not in it → `"block"`.
3. If `settings.auto_approve_all` is true → `"allow"`.
4. Look up `ToolDefinition.permissions`: `"safe"` → `"allow"`, `"cautious"` → `"confirm"`, `"dangerous"` → `"confirm"`.
5. Detect shell injection in `args` values → `"block"`.

### 4.2 — Concurrency Limiter

```python
class ConcurrencyLimiter:
    def __init__(self, max_concurrent: int):
        self._sem = asyncio.Semaphore(max_concurrent) if max_concurrent > 0 else None

    @asynccontextmanager
    async def acquire(self):
        if self._sem:
            async with self._sem:
                yield
        else:
            yield
```

### 4.3 — RunContext Dependencies

Inject security objects via PydanticAI's `RunContext` dependency mechanism:

```python
@dataclass
class AgentDeps:
    settings: Settings
    permission_manager: PermissionManager
    concurrency_limiter: ConcurrencyLimiter
    workspace_root: Path

agent = Agent(
    model=...,
    deps_type=AgentDeps,
    tools=[...],
)

result = await agent.run(prompt, deps=AgentDeps(...))
```

- All tools receive `ctx: RunContext[AgentDeps]` and access deps via `ctx.deps`.
- No global singleton security objects; everything flows through the injected context.

### 4.4 — Tool prepare Hook (Permission Check)

PydanticAI's `Tool` accepts an optional `prepare` coroutine that runs before the tool executes:

```python
async def permission_prepare(ctx: RunContext[AgentDeps], tool_def: ToolDefinitionParam) -> ToolDefinitionParam | None:
    decision = ctx.deps.permission_manager.check(tool_def["name"], {})
    if decision == "block":
        # Return None to suppress the tool from this call; the model receives no tool result
        # and the ToolBlockedError message is injected separately.
        raise ModelRetry(f"Tool '{tool_def['name']}' is blocked by policy.")
    return tool_def
```

- For `"confirm"` decisions in non-interactive mode, treat as `"block"` unless `auto_approve_all`.
- For interactive CLI mode (Phase 10), prompt the user and resume if approved.

### 4.5 — Per-Tool Timeout

Wrap each tool's `async def` body with `asyncio.wait_for()`:

```python
async def file_read(ctx: RunContext[AgentDeps], args: FileReadInput) -> str:
    timeout_s = (ctx.deps.settings.tool_timeout_ms) / 1000
    return await asyncio.wait_for(_do_file_read(ctx, args), timeout=timeout_s)
```

The `@tool_def(timeout_ms=...)` decorator stores the per-tool override; the wrapper uses `tool_def.timeout_ms` if set, otherwise falls back to `settings.tool_timeout_ms`.

### 4.6 — Path Traversal Prevention

Migrate `sanitize.ts` path checks to `sanitize.py`:

```python
def safe_path(workspace_root: Path, requested: str) -> Path:
    resolved = (workspace_root / requested).resolve()
    if not str(resolved).startswith(str(workspace_root)):
        raise ToolExecutionError("file_read", f"Path traversal detected: {requested}")
    return resolved
```

### 4.7 — MAX_ITERATIONS Enforcement

Maintain a call counter in `AgentDeps` (or a closure):

```python
@dataclass
class AgentDeps:
    ...
    tool_call_count: int = 0
    max_iterations: int = 20
```

In the `prepare` hook:

```python
ctx.deps.tool_call_count += 1
if ctx.deps.tool_call_count > ctx.deps.max_iterations:
    raise ModelRetry("Maximum tool iterations reached.")
```

---

## Acceptance Criteria

- [ ] Blocklisted tools are never executed; the model receives a descriptive error message.
- [ ] Allowlisted-only mode blocks all tools not in the list.
- [ ] Concurrency limiter prevents more than `max_concurrent_tools` simultaneous tool executions.
- [ ] Tools that exceed `timeout_ms` raise `ToolExecutionError` with a clear message.
- [ ] Path traversal attempts are caught before any file operation.
- [ ] `MAX_ITERATIONS` stops the agent loop cleanly.
- [ ] All security behaviours are unit-tested without real LLM calls (`TestModel`).

---

## Files Changed / Created

| Action | Path |
|---|---|
| Create | `src/agentloop/security.py` |
| Update | `src/agentloop/tools/registry.py` (integrate prepare hook) |
| Update | `src/agentloop/tools/sanitize.py` |
| Update | `src/agentloop/agent.py` (inject `AgentDeps`) |
| Create | `tests/test_security.py` |
| Delete (later) | `src/security.ts` |
