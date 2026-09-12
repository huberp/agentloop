# Phase 6 — MCP Integration

## Objective

Replace the custom `McpClient` / `registerMcpTools` bridge (`src/mcp/`) with **PydanticAI's built-in MCP support** (`pydantic_ai.mcp`).

---

## Background

### Current Architecture

```
src/mcp/client.ts    McpClient
                      - connects to stdio / SSE MCP servers
                      - lists tools, calls tools
                      - handles CreateMessageRequest sampling callbacks

src/mcp/bridge.ts    registerMcpTools()
                      - iterates McpClient.listTools()
                      - wraps each MCP tool as a ToolDefinition
                      - registers into ToolRegistry
```

This is significant custom code (~400 lines) implementing the MCP protocol from scratch on top of the `@modelcontextprotocol/sdk`. PydanticAI provides first-class MCP support that replaces all of it.

### PydanticAI Built-Ins Used

| Built-in | Replaces |
|---|---|
| `pydantic_ai.mcp.MCPServerStdio` | `StdioClientTransport` + `McpClient` (stdio path) |
| `pydantic_ai.mcp.MCPServerHTTP` | `SSEClientTransport` + `McpClient` (SSE path) |
| `Agent(mcp_servers=[...])` | `registerMcpTools()` manual tool wrapping |

---

## Deliverables

### 6.1 — MCP Configuration Schema

Extend `Settings` (Phase 1) to parse `MCP_SERVERS` as a typed Pydantic model:

```python
class McpServerConfig(BaseModel):
    name: str
    transport: Literal["stdio", "sse"]
    command: str | None = None
    args: list[str] = []
    url: str | None = None

class Settings(BaseSettings):
    mcp_servers: list[McpServerConfig] = []
    # ... rest unchanged
```

### 6.2 — MCP Server Factory (`src/agentloop/mcp.py`)

```python
from pydantic_ai.mcp import MCPServerStdio, MCPServerHTTP

def build_mcp_servers(configs: list[McpServerConfig]) -> list:
    servers = []
    for cfg in configs:
        if cfg.transport == "stdio":
            servers.append(MCPServerStdio(cfg.command, args=cfg.args))
        elif cfg.transport == "sse":
            servers.append(MCPServerHTTP(cfg.url))
    return servers
```

### 6.3 — Agent Integration

Pass MCP servers directly to `Agent`:

```python
mcp_servers = build_mcp_servers(settings.mcp_servers)

agent = Agent(
    model=model,
    tools=tool_registry.to_pydantic_ai_tools(),
    mcp_servers=mcp_servers,   # ← built-in MCP support
    system_prompt=system_prompt,
)
```

PydanticAI:
- Connects to each server at the start of `agent.run()`.
- Exposes MCP tools alongside built-in tools automatically.
- Handles tool calls, responses, and disconnection lifecycle.

No manual `listTools()`, wrapping, or registration is needed.

### 6.4 — Sampling Callback (CreateMessageRequest)

The current `McpClient` handles `CreateMessageRequest` (MCP sampling protocol) by routing back to the Mistral LLM. PydanticAI's `MCPServerStdio` handles the sampling lifecycle automatically when the agent is the sampling client. If custom sampling logic is needed, use the `sampling` parameter of `MCPServerStdio`.

### 6.5 — `list providers` CLI Command

The `oneshot list providers` command (Phase 10) should continue to show which MCP servers are configured and connected. Derive this from `settings.mcp_servers` and the connected state of the `MCPServerStdio` / `MCPServerHTTP` objects.

---

## Acceptance Criteria

- [ ] Configuring a stdio MCP server via `MCP_SERVERS` env var causes its tools to appear in `list tools`.
- [ ] MCP tool calls execute correctly during an agent run.
- [ ] A missing or unreachable MCP server logs a warning and continues without that server.
- [ ] Unit tests mock MCP servers using `pydantic_ai.models.test.TestModel` and an in-process fake MCP server.

---

## Files Changed / Created

| Action | Path |
|---|---|
| Create | `src/agentloop/mcp.py` |
| Update | `src/agentloop/config.py` (typed `McpServerConfig`) |
| Update | `src/agentloop/agent.py` (pass `mcp_servers=`) |
| Create | `tests/test_mcp.py` |
| Delete (later) | `src/mcp/client.ts`, `src/mcp/bridge.ts` |

---

## Dependencies Removed

- `@modelcontextprotocol/sdk` (npm) — replaced by PydanticAI's built-in MCP client
- Custom `McpClient` / `registerMcpTools` code
