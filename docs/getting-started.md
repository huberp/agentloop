# Getting Started

This guide takes you from a fresh clone to a running agent in under 10 minutes.

---

## Prerequisites

| Requirement | Version |
|---|---|
| Node.js | 20 or later |
| npm | bundled with Node.js |
| Mistral API key | [console.mistral.ai](https://console.mistral.ai) |

---

## 1. Clone and Install

```bash
git clone https://github.com/huberp/agentloop.git
cd agentloop
npm install
```

---

## 2. Configure the Environment

Copy the example environment file and open it in your editor:

```bash
cp .env.example .env
```

Set your Mistral API key — this is the only required value:

```env
MISTRAL_API_KEY=your_mistral_api_key_here
```

All other values have sensible defaults. See [configuration.md](configuration.md) for the full reference.

---

## 3. Start the CLI

```bash
npm run start
```

You should see:

```
Agent: Hello! I'm ready to help. Type 'exit' to quit.
User:
```

Type a message and press **Enter**. Type `exit` to quit.

---

## 4. Example Workflows

### Ask a simple question

```
User: What is the square root of 144?
Agent: The square root of 144 is 12.
```

### Explore the current workspace

```
User: List the TypeScript files in src/tools
Agent: [calls file-list tool, returns list of .ts files]
```

### Read a file

```
User: Show me the contents of package.json
Agent: [calls file-read tool and summarizes]
```

### Check git status

```
User: What files have been changed in this repository?
Agent: [calls git-status and reports the changes]
```

### Run a calculation

```
User: Calculate (12 * 8) + (3^4)
Agent: Result of (12 * 8) + (3^4): 177
```

---

## 5. Enable Streaming (Optional)

To see tokens printed as they arrive, set in `.env`:

```env
STREAMING_ENABLED=true
```

---

## 6. Run the Tests

```bash
npm test
```

The test suite runs entirely offline using `MockChatModel` — no API key is needed.

---

## 7. Connect an MCP Server (Optional)

To add an MCP tool server, set `MCP_SERVERS` in `.env`:

```env
MCP_SERVERS=[{"name":"my-server","transport":"stdio","command":"npx","args":["my-mcp-server"]}]
```

AgentLoop connects at startup and registers all tools provided by the server. See [extending.md](extending.md) for details.

---

## 8. Next Steps

- [tools.md](tools.md) — catalog of every built-in tool
- [configuration.md](configuration.md) — all environment variables and defaults
- [extending.md](extending.md) — add custom tools, subagents, and MCP servers
- [architecture.md](architecture.md) — system design and Mermaid diagrams
- [security.md](security.md) — threat model and security controls
- [testing.md](testing.md) — testing strategy and `MockChatModel` usage
