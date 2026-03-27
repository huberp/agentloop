# Configuration Reference

All runtime settings are loaded from environment variables via `src/config.ts` using `dotenv`. Copy `.env.example` to `.env` and set values before starting the agent.

---

## LLM / Provider

| Variable | Default | Type | Description |
|---|---|---|---|
| `MISTRAL_API_KEY` | *(required)* | string | Mistral API key. Only required when `LLM_PROVIDER=mistral`. |
| `LLM_PROVIDER` | `mistral` | string | LLM provider. Currently only `mistral` is supported. |
| `LLM_MODEL` | *(empty)* | string | Model name to pass to the provider SDK. Leave empty to use the provider's default. |
| `LLM_TEMPERATURE` | `0.7` | float | Sampling temperature (0 = deterministic, 1 = creative). |

---

## Agent Loop

| Variable | Default | Type | Description |
|---|---|---|---|
| `MAX_ITERATIONS` | `20` | int | Maximum LLM iterations per invocation before the loop is aborted with a warning. |
| `MAX_TOKENS_BUDGET` | `0` | int | Token budget reserved for future context-window management. `0` = disabled. |
| `MAX_CONTEXT_TOKENS` | `28000` | int | Maximum tokens in the context window (system prompt + history). Messages are trimmed to stay within this limit. |
| `SYSTEM_PROMPT_PATH` | *(empty)* | string | Optional path to a `.txt` or `.md` file that overrides the generated system prompt. |
| `UI_MODE` | `cli` | string | Interactive runtime interface mode: `cli` (readline) or `tui` (Ink multi-pane UI). |

---

## LLM Retry

| Variable | Default | Type | Description |
|---|---|---|---|
| `LLM_RETRY_MAX` | `3` | int | Maximum number of retries on transient LLM API failures. |
| `LLM_RETRY_BASE_DELAY_MS` | `500` | int | Base delay in milliseconds for exponential back-off between retries. |

---

## Tool Execution

| Variable | Default | Type | Description |
|---|---|---|---|
| `TOOL_TIMEOUT_MS` | `30000` | int | Per-tool execution timeout in milliseconds. The tool promise is raced against an `AbortController`; the tool is cancelled if it exceeds this limit. |

---

## DuckDuckGo Search

| Variable | Default | Type | Description |
|---|---|---|---|
| `DUCKDUCKGO_MAX_RESULTS` | `5` | int | Maximum number of results returned by the `search` tool per query. |
| `DUCKDUCKGO_MIN_DELAY_MS` | `1000` | int | Minimum delay between outbound DuckDuckGo requests to reduce upstream throttling. `0` disables delay. |
| `DUCKDUCKGO_RETRY_MAX` | `2` | int | Maximum retries for transient DuckDuckGo failures (network, timeout, 429, 5xx). |
| `DUCKDUCKGO_RETRY_BASE_DELAY_MS` | `400` | int | Base delay in milliseconds for exponential back-off between search retries. |
| `DUCKDUCKGO_RATE_LIMIT_PENALTY_MS` | `1000` | int | Additional delay added when a retry follows a detected rate-limit (429) failure. |
| `DUCKDUCKGO_CACHE_TTL_MS` | `300000` | int | In-memory cache TTL for search results in milliseconds. `0` disables caching. |
| `DUCKDUCKGO_CACHE_MAX_ENTRIES` | `128` | int | Maximum number of cached search queries retained in memory. `0` disables caching. |
| `DUCKDUCKGO_SERVE_STALE_ON_ERROR` | `true` | bool | When `true`, serves stale cached results if upstream search fails after retries. |

---

## Tool Security

| Variable | Default | Type | Description |
|---|---|---|---|
| `AUTO_APPROVE_ALL` | `false` | bool | Skip all interactive confirmation prompts for `dangerous` tools. Set to `true` for CI or non-interactive environments. |
| `TOOL_ALLOWLIST` | *(empty)* | string (CSV) | Comma-separated list of tool names that are permitted to run. When non-empty, all other tools are blocked. |
| `TOOL_BLOCKLIST` | *(empty)* | string (CSV) | Comma-separated list of tool names that are always blocked, regardless of other settings. |

---

## Shell Tool

| Variable | Default | Type | Description |
|---|---|---|---|
| `SHELL_COMMAND_BLOCKLIST` | *(empty)* | string (CSV) | Extra blocked command patterns appended to the built-in shell blocklist (e.g. `shutdown,reboot`). |

---

## Code Execution

| Variable | Default | Type | Description |
|---|---|---|---|
| `EXECUTION_TIMEOUT_MS` | `60000` | int | Timeout in milliseconds for `code_run` executions. Overrides `TOOL_TIMEOUT_MS` for this tool. |
| `EXECUTION_ENVIRONMENT` | `local` | string | Execution environment label. Reserved for future use; currently unused at runtime. |

---

## Sandboxing

| Variable | Default | Type | Description |
|---|---|---|---|
| `SANDBOX_MODE` | `none` | `"none" \| "docker"` | Execution sandbox for `code_run`. `none` runs code directly on the host; `docker` isolates it in a container. |
| `SANDBOX_DOCKER_IMAGE` | `node:20-alpine` | string | Docker image used when `SANDBOX_MODE=docker`. Must contain the required interpreter. |

---

## Workspace

| Variable | Default | Type | Description |
|---|---|---|---|
| `WORKSPACE_ROOT` | `process.cwd()` | string | Root directory for all file operations. Paths outside this directory are rejected (path traversal prevention). |

---

## Security Limits

| Variable | Default | Type | Description |
|---|---|---|---|
| `MAX_FILE_SIZE_BYTES` | `10485760` (10 MB) | int | Maximum file size in bytes for read/write operations. |
| `MAX_SHELL_OUTPUT_BYTES` | `1048576` (1 MB) | int | Maximum combined stdout+stderr output size in bytes for shell commands. Output is truncated at this limit. |
| `MAX_CONCURRENT_TOOLS` | `10` | int | Maximum number of tool executions allowed to run concurrently. `0` = unlimited. |
| `NETWORK_ALLOWED_DOMAINS` | *(empty — allow all)* | string (CSV) | Comma-separated allowlist of hostnames for network tool requests. When non-empty, only these hosts are permitted. |

---

## MCP Integration

| Variable | Default | Type | Description |
|---|---|---|---|
| `MCP_SERVERS` | *(empty)* | JSON array | JSON array of MCP server config objects. Parsed at startup; servers are connected before the first agent invocation. |

Each entry in `MCP_SERVERS` must be a JSON object:

```json
{
  "name": "my-server",          // logical name used for namespacing
  "transport": "stdio",         // "stdio" or "sse"
  "command": "npx",             // executable (stdio only)
  "args": ["my-mcp-server"],    // arguments (stdio only)
  "url": "https://..."          // SSE endpoint URL (sse only)
}
```

Example:

```env
MCP_SERVERS=[{"name":"my-server","transport":"stdio","command":"npx","args":["my-mcp-server"]}]
```

---

## Streaming

| Variable | Default | Type | Description |
|---|---|---|---|
| `STREAMING_ENABLED` | `false` | bool | Print LLM response tokens as they arrive in the CLI REPL. Uses the streaming agent loop when enabled. |

---

## Prompts and Instructions

| Variable | Default | Type | Description |
|---|---|---|---|
| `INSTRUCTIONS_ROOT` | same as `WORKSPACE_ROOT` | string | Root directory for discovering instruction files (`.instructions.md`, `AGENTS.md`, etc.). |
| `PROMPT_TEMPLATES_DIR` | *(empty)* | string | Directory containing `.md`/`.txt` prompt template files loaded into `PromptRegistry` at startup. |
| `PROMPT_HISTORY_FILE` | *(empty)* | string | Path to a JSON file where prompt template version history is persisted. Leave empty to disable persistence. |
| `PROMPT_CONTEXT_REFRESH_MS` | `5000` | int | TTL in milliseconds before runtime context (workspace, tools, instructions) is rebuilt. `0` = rebuild on every LLM call. |

---

## Skills and Agent Profiles

| Variable | Default | Type | Description |
|---|---|---|---|
| `SKILLS_DIR` | *(empty)* | string | Directory to auto-load `*.skill.md` skill files from at startup. |
| `AGENT_PROFILES_DIR` | *(empty)* | string | Directory to auto-load `*.agent.json` / `*.agent.yaml` agent profile files from at startup. |

---

## Observability and Tracing

| Variable | Default | Type | Description |
|---|---|---|---|
| `TRACING_ENABLED` | `false` | bool | Write a JSON trace file per agent invocation to `TRACE_OUTPUT_DIR`. |
| `TRACE_OUTPUT_DIR` | `./traces` | string | Directory where invocation trace JSON files are written. Created if missing. |
| `TRACING_COST_PER_INPUT_TOKEN_USD` | `0` | float | USD cost per input (prompt) token for cost estimation. `0` = disabled. |
| `TRACING_COST_PER_OUTPUT_TOKEN_USD` | `0` | float | USD cost per output (completion) token for cost estimation. `0` = disabled. |

---

## Logging

| Variable | Default | Type | Description |
|---|---|---|---|
| `LOG_LEVEL` | `info` | string | Pino log level: `trace`, `debug`, `info`, `warn`, `error`, `fatal`. |
| `LOG_ENABLED` | `true` | bool | Set to `false` to silence all log output. |
| `LOG_DESTINATION` | `stdout` | string | Log destination. Currently `stdout` is the only supported value. |
| `LOG_NAME` | `agentloop` | string | Logger name included in every log record. |
| `LOG_TIMESTAMP` | `true` | bool | Include an ISO timestamp in every log record. |

---

## LLM Response Recording (Testing)

| Variable | Default | Type | Description |
|---|---|---|---|
| `RECORD_LLM_RESPONSES` | `false` | bool | Record real LLM API responses as JSON fixture files for later replay in tests. |
| `LLM_FIXTURE_DIR` | `tests/fixtures/llm-responses` | string | Directory where recorded fixture files are stored and `MockChatModel.fromFixture()` reads from. |
