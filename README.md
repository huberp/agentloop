# AgentLoop

AgentLoop is a TypeScript-first [LangChain](https://js.langchain.com/) runtime for tool-using coding agents. It provides an iterative agent loop with native tool binding, dynamic tool discovery, streaming responses, a security permission system, MCP integration, and optional multi-agent planning and execution.

## Key Features

- **Iterative agent loop** — LLM calls tools, receives results as `ToolMessage` entries, and loops until the task is done or `MAX_ITERATIONS` is reached.
- **Dynamic tool discovery** — drop a `.ts` file exporting `toolDefinition` into `src/tools/` and it is auto-registered at startup; no central list to edit.
- **16 built-in tools** — filesystem read/write/edit/delete, shell execution, code search, code runner, unified diff/patch, and four git tools.
- **Security controls** — path traversal prevention, shell injection detection, per-tool permission levels (`safe` / `cautious` / `dangerous`), blocklist/allowlist, output size limits, and concurrency cap.
- **MCP integration** — connect stdio or SSE MCP servers; their tools appear alongside built-in tools.
- **Streaming mode** — assembles `ToolCallChunk` fragments and streams text tokens to the CLI as they arrive.
- **Observability** — per-invocation JSON traces with token counts and cost accounting.
- **Subagents and orchestration** — `Planner` + `Orchestrator` for multi-step tasks; `SubagentManager` for parallel isolated agent loops with conflict detection.
- **Agent profiles** — JSON/YAML profile files that override model, temperature, and allowed tools per invocation.

## Requirements

- Node.js 20+
- npm
- Mistral API key ([console.mistral.ai](https://console.mistral.ai))

## Quick Start

```bash
# 1. Clone and install
git clone https://github.com/huberp/agentloop.git
cd agentloop
npm install

# 2. Configure
cp .env.example .env
# Edit .env and set MISTRAL_API_KEY=your_key_here

# 3. Run
npm run start
```

Type a message and press **Enter**. Type `exit` to quit.

## Programmatic API
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

// Non-streaming
const result = await agentExecutor.invoke("Summarize this project");
console.log(result.output);

// Streaming
for await (const chunk of agentExecutor.stream("What files changed recently?")) {
const result = await agentExecutor.invoke("Summarize this project");
console.log(result.output);

for await (const chunk of agentExecutor.stream("Explain the recent changes")) {
  process.stdout.write(chunk);
}
```

## Documentation

| Doc | Contents |
|---|---|
| [docs/getting-started.md](docs/getting-started.md) | Installation, first run, example workflows |
| [docs/architecture.md](docs/architecture.md) | System overview, agent loop flow, Mermaid diagrams |
| [docs/tools.md](docs/tools.md) | Catalog of all 16 built-in tools with inputs, outputs, and examples |
| [docs/configuration.md](docs/configuration.md) | All 43 environment variables with defaults and descriptions |
| [docs/extending.md](docs/extending.md) | Add a custom tool, create subagents, connect MCP servers |
| [docs/security.md](docs/security.md) | Threat model and security mitigations |
| [docs/testing.md](docs/testing.md) | Testing strategy and `MockChatModel` usage |

## Scripts

| Command | Description |
|---|---|
| `npm run start` | Start the interactive CLI agent (dev mode via tsx) |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run build:clean` | Remove `dist/` then compile |
| `npm run start:prod` | Start the agent from compiled `dist/` |
| `npm test` | Run the full unit/integration test suite (no API key needed) |
| `npm run test:e2e` | Run end-to-end scenarios |
| `npm run bench` | Run performance benchmarks |
| `npm run bench:profile` | Run benchmarks with Node.js `--prof` for CPU profiling |

## Deployment

### Docker

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
docker build -t agentloop .
docker run -it -e MISTRAL_API_KEY=your_key agentloop
```

The image uses a multi-stage build (`node:20-alpine`) — the final image contains only the compiled `dist/` and production dependencies.

### npm package

The package is published as `@huberp/agentloop`. To use it programmatically:

```bash
npm install @huberp/agentloop
```

### CI/CD

A GitHub Actions workflow (`.github/workflows/ci.yml`) runs on every push and pull request:
1. **test** — `npm ci` + `npm test`
2. **build** — `npm run build`, uploads `dist/` as an artifact

See [CHANGELOG.md](CHANGELOG.md) for version history.

## License

There are focused suites for major areas including tooling, orchestration,
streaming, MCP, sandboxing, and security hardening.

## License
MIT. See [LICENSE](LICENSE).