# AgentLoop

AgentLoop is a TypeScript-first LangChain runtime for tool-using coding agents.
It supports iterative tool execution, streaming responses, security controls,
MCP integration, and optional multi-agent planning/execution components.

## Highlights
- Iterative agent loop with native `bindTools` and tool-result reinjection.
- Dynamic tool discovery from `src/tools` (no central hardcoded tool list).
- Built-in filesystem, shell, code execution, git, patch/diff, and search tools.
- Security hardening for path safety, shell input checks, output limits, and permissions.
- Streaming mode that assembles `ToolCallChunk` fragments and resumes streaming after tool runs.
- Observability/tracing with per-invocation JSON trace output and token/cost accounting.
- MCP client bridge that can register remote MCP tools at startup.
- Planner/orchestrator/subagent modules for phased and parallelized task execution patterns.

## Requirements
- Node.js 20+
- npm
- Mistral API key

## Quick Start
1. Clone and install:

```bash
git clone https://github.com/huberp/agentloop.git
cd agentloop
npm install
```

2. Create `.env` from `.env.example` and set at least:

```env
MISTRAL_API_KEY=your_mistral_api_key_here
LLM_PROVIDER=mistral
LLM_MODEL=
LLM_TEMPERATURE=0.7
```

3. Start the CLI:

```bash
npm run start
```

4. Exit with `exit`.

## Runtime Architecture
- `src/config.ts`: dotenv initialization and all runtime config (`appConfig`).
- `src/index.ts`: primary iterative loop, tool execution, retries, timeout handling.
- `src/streaming.ts`: streaming loop with chunked tool-call assembly.
- `src/tools/registry.ts`: tool registration + dynamic loading from `src/tools`.
- `src/security.ts`: permission manager, network allowlist checks, concurrency limiter.
- `src/observability.ts`: tracer interface and file-based tracing implementation.
- `src/mcp/*`: MCP client + bridge for registering MCP tools.
- `src/subagents/*`: planner, runner, and manager for specialized subagent workflows.
- `src/orchestrator.ts`: plan execution with retry/skip/abort and checkpointing support.

## Built-In Tools
Current built-in tool names:
- `calculate`
- `search`
- `code-search`
- `code_run`
- `shell`
- `file-list`
- `file-read`
- `file-write`
- `file-edit`
- `file-delete`
- `diff`
- `patch`
- `git-status`
- `git-log`
- `git-diff`
- `git-commit`

MCP tools are additional and discovered at runtime from configured MCP servers.

## Configuration
All runtime settings come from `appConfig` in `src/config.ts`.

Key groups in `.env.example`:
- Agent loop: `MAX_ITERATIONS`, `MAX_CONTEXT_TOKENS`, retry and timeout settings.
- LLM: `LLM_PROVIDER`, `LLM_MODEL`, `LLM_TEMPERATURE`.
- Tool permissions: `AUTO_APPROVE_ALL`, `TOOL_ALLOWLIST`, `TOOL_BLOCKLIST`.
- Shell/code execution: `SHELL_COMMAND_BLOCKLIST`, `EXECUTION_TIMEOUT_MS`.
- Workspace isolation: `WORKSPACE_ROOT`.
- MCP: `MCP_SERVERS` JSON array.
- Security limits: `MAX_FILE_SIZE_BYTES`, `MAX_SHELL_OUTPUT_BYTES`, `MAX_CONCURRENT_TOOLS`, `NETWORK_ALLOWED_DOMAINS`.
- Sandbox: `SANDBOX_MODE`, `SANDBOX_DOCKER_IMAGE`.
- Streaming: `STREAMING_ENABLED`.
- Tracing: `TRACING_ENABLED`, `TRACE_OUTPUT_DIR`, token cost vars.
- Logging: `LOG_LEVEL`, `LOG_ENABLED`, `LOG_DESTINATION`, `LOG_NAME`, `LOG_TIMESTAMP`.

## MCP Server Configuration
`MCP_SERVERS` uses a JSON array. Example:

```env
MCP_SERVERS=[{"name":"my-server","transport":"stdio","command":"npx","args":["my-mcp-server"]}]
```

Supported transports are `stdio` and `sse`.

## Streaming API
Programmatic usage:

```ts
import { agentExecutor } from "./src/index";

const result = await agentExecutor.invoke("Summarize this project");
console.log(result.output);

for await (const chunk of agentExecutor.stream("Explain the recent changes")) {
  process.stdout.write(chunk);
}
```

## Security
See `docs/security.md` for threat model and mitigations, including:
- path traversal prevention for file/shell cwd operations
- shell injection checks
- output and file-size limits
- concurrency limits
- network domain allowlist for network-capable tools

## Tests
Run the full suite:

```bash
npm test
```

There are focused suites for major areas including tooling, orchestration,
streaming, MCP, sandboxing, and security hardening.

## License
MIT. See [LICENSE](LICENSE).