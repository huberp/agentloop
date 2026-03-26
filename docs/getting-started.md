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

### Plan and execute a multi-step task

The `plan-and-run` tool lets you hand a high-level goal to the planner, which
breaks it into steps and runs each one as an isolated subagent.

```
User: Plan and run: add a CONTRIBUTING.md that explains the project structure,
      coding conventions, and how to run the tests
```

The agent calls `plan-and-run`, which:
1. Sends the goal to the **planner subagent** — it returns a structured list of
   steps (read existing docs, draft the file, write it to disk, verify).
2. Passes the plan to the **orchestrator**, which executes each step in sequence.
3. Reports per-step success or failure back to the conversation.

```
Agent: ✓ Step 1: Read README.md and docs/ to understand project structure
       ✓ Step 2: Draft CONTRIBUTING.md content
       ✓ Step 3: Write CONTRIBUTING.md to the workspace root
       ✓ Step 4: Verify the file was created

       Completed successfully.
```

For larger or riskier tasks you can ask the planner to stop after planning:

```
User: Generate a plan to refactor the error-handling in src/orchestrator.ts,
      but don't execute it yet — just show me the steps
```

```
Agent: Here is the proposed plan:
  1. [low]    Read src/orchestrator.ts to understand current error handling
  2. [medium] Identify steps that swallow errors without logging
  3. [medium] Rewrite those sections to use the shared logger
  4. [low]    Run the test suite to confirm no regressions
```

You can then trigger execution with a follow-up:

```
User: Looks good. Go ahead and execute it.
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

- [usage.md](usage.md) — subagents, planner, orchestrator, and parallel execution examples
- [tools.md](tools.md) — catalog of every built-in tool
- [configuration.md](configuration.md) — all environment variables and defaults
- [extending.md](extending.md) — add custom tools, subagents, and MCP servers
- [architecture.md](architecture.md) — system design and Mermaid diagrams
- [security.md](security.md) — threat model and security controls
- [testing.md](testing.md) — testing strategy and `MockChatModel` usage
