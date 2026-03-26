# Extending AgentLoop

This guide explains how to add a custom tool, create a subagent workflow, and connect an external MCP server.

---

## Adding a Custom Tool

Tools are just TypeScript files that export a `toolDefinition` constant. The ToolRegistry auto-discovers any `.ts` or `.js` file in `src/tools/` whose name is not `registry.*` or a test file.

### Step 1 — Create the tool file

Create `src/tools/my-tool.ts`:

```ts
import { z } from "zod";
import type { ToolDefinition } from "./registry";

// 1. Define the input schema with Zod
const schema = z.object({
  message: z.string().describe("The message to echo back"),
  repeat: z
    .number()
    .int()
    .min(1)
    .max(10)
    .optional()
    .default(1)
    .describe("How many times to repeat the message (1–10)"),
});

// 2. Export the toolDefinition constant
export const toolDefinition: ToolDefinition = {
  // Name the LLM will use to call this tool
  name: "echo",

  // Description shown to the LLM in the system prompt
  description: "Echo a message back, optionally repeating it multiple times.",

  schema,

  // "safe" | "cautious" | "dangerous"
  // safe     → always approved
  // cautious → approved with audit log
  // dangerous → requires user confirmation (or AUTO_APPROVE_ALL=true)
  permissions: "safe",

  // Type signature must match the Zod schema above
  execute: async ({
    message,
    repeat = 1,
  }: {
    message: string;
    repeat?: number;
  }): Promise<string> => {
    const lines = Array.from({ length: repeat }, () => message);
    return lines.join("\n");
  },
};
```

That's it. The next time you run `npm run start`, the tool is auto-registered and available to the LLM.

### Verification

```bash
npm run start
# Then in the REPL:
User: Repeat "hello world" three times
Agent: [calls echo tool with { message: "hello world", repeat: 3 }]
```

To verify registration programmatically:

```ts
import { toolRegistry } from "./src/index";
// After ensureInitialized() has resolved:
console.log(toolRegistry.list().map(t => t.name));
// Should include "echo"
```

---

### ToolDefinition Reference

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | `string` | yes | Unique tool name. Used by the LLM to call the tool. |
| `description` | `string` | yes | Shown to the LLM. Be specific — it guides tool selection. |
| `schema` | `z.ZodTypeAny` | yes | Input schema for validation and LLM function-calling metadata. |
| `execute` | `(args: any) => Promise<string>` | yes | Tool implementation. Must return a string. |
| `permissions` | `"safe" \| "cautious" \| "dangerous"` | no | Defaults to `"safe"`. |
| `timeout` | `number` | no | Per-tool timeout override in ms (falls back to `TOOL_TIMEOUT_MS`). |
| `mutatesFile` | `(args) => string \| undefined` | no | Return the file path this call will write to. Used by parallel subagent conflict detection. |

---

### Security Guidelines for Custom Tools

- **File access:** Use `resolveSafe(appConfig.workspaceRoot, relativePath)` from `src/tools/file-utils.ts` for any path resolution. This prevents path traversal.
- **Shell commands:** Use `detectShellInjection(command)` from `src/tools/sanitize.ts` to reject injection metacharacters.
- **Network requests:** Call `checkNetworkAccess(url, appConfig.networkAllowedDomains)` from `src/security.ts` before any outbound HTTP request.
- **Large outputs:** Use `truncateOutput(text, appConfig.maxShellOutputBytes)` from `src/tools/sanitize.ts` to stay within size limits.

---

## Creating a Subagent Workflow

Subagents are isolated agent loops with their own message history, a restricted tool set, and an iteration budget. Use them to delegate focused sub-tasks.

### Running a single subagent

```ts
import { runSubagent } from "./src/subagents/runner";
import { toolRegistry } from "./src/index";
import type { SubagentDefinition } from "./src/subagents/types";

const definition: SubagentDefinition = {
  name: "file-analyzer",
  tools: ["file-read", "file-list"],    // only these tools are exposed
  maxIterations: 5,
  systemPrompt: "You are a file analysis specialist. Be concise.",
  sharedContext: { targetDirectory: "src/tools" },
};

const result = await runSubagent(definition, "List all tool files and count them.", toolRegistry);
console.log(result.output);           // final text from the subagent
console.log(result.filesModified);    // files written during the run
```

### Running subagents in parallel

```ts
import { SubagentManager } from "./src/subagents/manager";
import { toolRegistry } from "./src/index";
import type { ParallelTask } from "./src/subagents/types";

const manager = new SubagentManager(toolRegistry);

const tasks: ParallelTask[] = [
  {
    definition: { name: "reader", tools: ["file-read"], maxIterations: 3 },
    task: "Summarize package.json",
  },
  {
    definition: { name: "searcher", tools: ["code-search"], maxIterations: 3 },
    task: "Find all TODO comments in src/",
  },
];

const { results, conflicts } = await manager.runParallel(tasks);
// conflicts lists files written by more than one subagent
```

---

## Using the Planner and Orchestrator

For complex multi-step tasks, use the `Planner` to break a goal into steps and the `Orchestrator` to execute them.

```ts
import { Planner } from "./src/subagents/planner";
import { executePlan } from "./src/orchestrator";
import { toolRegistry } from "./src/index";
import { createLLM } from "./src/llm";
import { appConfig } from "./src/config";

const llm = createLLM(appConfig);
const planner = new Planner(llm);

// Step 1: generate a plan
const plan = await planner.plan("Refactor the calculate tool to add support for units.");

// Step 2: execute it
const result = await executePlan(plan, toolRegistry, llm, {
  onStepFailure: "retry",   // "retry" | "skip" | "abort"
});

console.log(result.success);      // true if no step failed
result.stepResults.forEach(s => console.log(s.status, s.description));
```

---

## Connecting an MCP Server

AgentLoop can connect to any [Model Context Protocol](https://modelcontextprotocol.io/) server at startup. Tools from MCP servers appear alongside built-in tools; the LLM cannot tell the difference.

### Via environment variable

Set `MCP_SERVERS` in `.env`:

```env
# stdio: spawn a subprocess
MCP_SERVERS=[{"name":"my-tools","transport":"stdio","command":"npx","args":["my-mcp-server"]}]

# sse: connect to a remote HTTP/SSE endpoint
MCP_SERVERS=[{"name":"remote","transport":"sse","url":"https://tools.example.com/sse"}]
```

### Programmatically

```ts
import { McpClient } from "./src/mcp/client";
import { registerMcpTools } from "./src/mcp/bridge";
import { toolRegistry } from "./src/index";

await registerMcpTools(
  [{ name: "my-server", transport: "stdio", command: "my-mcp-server", args: [] }],
  toolRegistry
);
// All tools from "my-server" are now in toolRegistry
```

### Sampling support

If the MCP server wants to invoke the LLM (sampling), register a handler before connecting:

```ts
const client = new McpClient({ name: "smart-server", transport: "stdio", command: "..." });
client.setSamplingHandler(async (messages) => {
  // messages is Array<{ role, content }>
  const result = await myLlm.invoke(messages);
  return result.content as string;
});
await client.connect();
```

---

## Adding a New LLM Provider

The LLM factory in `src/llm.ts` contains a `switch` block for provider selection. To add a new one:

1. Install the LangChain provider package, e.g. `npm install @langchain/openai`.
2. Add a `case` to the switch in `src/llm.ts`:

```ts
case "openai":
  model = new ChatOpenAI({
    apiKey: config.openAiApiKey,     // add to appConfig and .env.example
    model: config.llmModel || "gpt-4o",
    temperature: config.llmTemperature,
  });
  break;
```

3. Add the corresponding config key and env var to `src/config.ts` and `.env.example`.
