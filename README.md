# AgentLoop

AgentLoop is a TypeScript-first [LangChain](https://js.langchain.com/) runtime for tool-using coding agents. It provides an iterative agent loop with native tool binding, dynamic tool discovery, streaming responses, a security permission system, MCP integration, and optional multi-agent planning and execution.

## Key Features

- **Iterative agent loop** — LLM calls tools, receives results as `ToolMessage` entries, and loops until the task is done or `MAX_ITERATIONS` is reached.
- **Dynamic tool discovery** — drop a `.ts` file exporting `toolDefinition` into `src/tools/` and it is auto-registered at startup; no central list to edit.
- **16 built-in tools** — filesystem read/write/edit/delete, shell execution, code search, code runner, unified diff/patch, and four git tools.
- **Resilient web search** — DuckDuckGo search includes retry with back-off, configurable throttling, and in-memory caching to reduce transient failures.
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
npm run startCli
```

Type a message and press **Enter**. Type `exit` to quit.

To launch the Ink-based multi-pane TUI:

```bash
npm run startTui
```

## Programmatic API

```ts
import { agentExecutor } from "./src/index";

// Non-streaming
const result = await agentExecutor.invoke("Summarize this project");
console.log(result.output);

// Streaming
for await (const chunk of agentExecutor.stream("What files changed recently?")) {
  process.stdout.write(chunk);
}
```

## Documentation

| Doc | Contents |
|---|---|
| [docs/getting-started.md](docs/getting-started.md) | Installation, first run, example workflows |
| [docs/usage.md](docs/usage.md) | Subagents, planner, orchestrator, parallel execution examples |
| [docs/architecture.md](docs/architecture.md) | System overview, agent loop flow, Mermaid diagrams |
| [docs/tools.md](docs/tools.md) | Catalog of all 16 built-in tools with inputs, outputs, and examples |
| [docs/configuration.md](docs/configuration.md) | All 43 environment variables with defaults and descriptions |
| [docs/extending.md](docs/extending.md) | Add a custom tool, create subagents, connect MCP servers |
| [docs/security.md](docs/security.md) | Threat model and security mitigations |
| [docs/testing.md](docs/testing.md) | Testing strategy and `MockChatModel` usage |

## Scripts

| Command | Description |
|---|---|
| `npm run start` | Start the agent using `UI_MODE` from the environment |
| `npm run startCli` | Start the readline CLI agent (dev mode via tsx) |
| `npm run startTui` | Start the Ink TUI agent (dev mode via tsx) |
| `npm run oneshot` | Run a one-shot command and exit (see below) |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run build:clean` | Remove `dist/` then compile |
| `npm run start:prod` | Start the agent from compiled `dist/` |
| `npm test` | Run the full unit/integration test suite (no API key needed) |
| `npm run test:e2e` | Run end-to-end scenarios |
| `npm run bench` | Run performance benchmarks |
| `npm run bench:profile` | Run benchmarks with Node.js `--prof` for CPU profiling |

## One-Shot CLI Mode

`agentloop` supports a non-interactive, scriptable mode via `src/start-oneshot.ts`. Run a single operation, print the result to `stdout`, and exit — ideal for shell scripts, Makefiles, and CI workflows.

```bash
npm run oneshot -- <command> [options]
# or directly:
npx tsx src/start-oneshot.ts <command> [options]
```

### `agent` — Run the agentic loop once

```bash
# Simple one-shot query
npm run oneshot -- agent -u "What files are in the src directory?"

# Override the system prompt
npm run oneshot -- agent -s "You are a concise assistant." -u "Summarise the README"

# Use a named agent profile
npm run oneshot -- agent --profile coder -u "Refactor src/config.ts"

# Stream output tokens as they arrive
npm run oneshot -- agent --stream -u "List all exported functions in src/index.ts"

# Machine-readable JSON output
npm run oneshot -- agent --json -u "What is 2 + 2?"
# → {"output":"2 + 2 equals 4"}
```

| Flag | Short | Description |
|---|---|---|
| `--user` | `-u` | User prompt / task **(required)** |
| `--system` | `-s` | Replace the system prompt for this invocation |
| `--profile` | `-p` | Agent profile to activate (e.g. `coder`, `planner`) |
| `--stream` | | Stream output tokens to stdout |
| `--json` | | Output `{"output":"..."}` as JSON |

### `websearch` — Invoke the web-search tool directly

```bash
npm run oneshot -- websearch -q "LangChain tool calling best practices"
npm run oneshot -- websearch --query "Bun compile" -n 3 --json
```

| Flag | Short | Description |
|---|---|---|
| `--query` | `-q` | Search query **(required)** |
| `--max-results` | `-n` | Maximum results to return |
| `--json` | | Output raw JSON result array |

### `web-fetch` — Invoke the web-fetch tool directly

```bash
npm run oneshot -- web-fetch -u "https://example.com"
npm run oneshot -- web-fetch --url "https://example.com" --json
```

| Flag | Short | Description |
|---|---|---|
| `--url` | `-u` | URL to fetch **(required)** |
| `--json` | | Output raw JSON `{ title, markdown, … }` |

### `list` — List registered capabilities

```bash
npm run oneshot -- list tools          # all registered tools
npm run oneshot -- list agentprofiles  # all agent profiles
npm run oneshot -- list skills         # all active skills
npm run oneshot -- list providers      # LLM and search provider status
```

Add `--json` for machine-readable output or `--verbose` for full metadata (file path, model, tools, etc.):

```bash
npm run oneshot -- list tools --json
npm run oneshot -- list skills --verbose
npm run oneshot -- list providers
```

| Capability | Description |
|---|---|
| `tools` | All registered tools (built-in + MCP + custom) with name, permission, source, description |
| `agentprofiles` | All loaded agent profiles with name, source, skills, description |
| `skills` | All active skills with name, source, description |
| `providers` | Configured LLM and search providers with their active status |

## Deployment

### Docker

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

MIT. See [LICENSE](LICENSE).