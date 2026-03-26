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
| [docs/architecture.md](docs/architecture.md) | System overview, agent loop flow, Mermaid diagrams |
| [docs/tools.md](docs/tools.md) | Catalog of all 16 built-in tools with inputs, outputs, and examples |
| [docs/configuration.md](docs/configuration.md) | All 43 environment variables with defaults and descriptions |
| [docs/extending.md](docs/extending.md) | Add a custom tool, create subagents, connect MCP servers |
| [docs/security.md](docs/security.md) | Threat model and security mitigations |
| [docs/testing.md](docs/testing.md) | Testing strategy and `MockChatModel` usage |

## Scripts

| Command | Description |
|---|---|
| `npm run start` | Start the interactive CLI agent |
| `npm test` | Run the full unit/integration test suite (no API key needed) |
| `npm run test:e2e` | Run end-to-end scenarios |
| `npm run bench` | Run performance benchmarks |

## License

MIT. See [LICENSE](LICENSE).