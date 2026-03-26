# Architecture

## System Overview

AgentLoop is a TypeScript runtime that implements a tool-using agentic loop on top of [LangChain](https://js.langchain.com/) and [Mistral AI](https://mistral.ai/). The agent receives a natural-language task, calls tools iteratively until the task is complete, and returns a final text response.

```mermaid
graph TD
    User([User / CLI]) -->|input| Main
    Main[src/index.ts<br>AgentExecutor] -->|initialize| Init[ensureInitialized]
    Init -->|load| ToolReg[ToolRegistry<br>src/tools/registry.ts]
    Init -->|connect| MCP[MCP Bridge<br>src/mcp/bridge.ts]
    Init -->|bindTools| LLM[LLM<br>src/llm.ts]
    Init -->|load| Skills[SkillRegistry]
    Init -->|load| Agents[AgentProfileRegistry]
    Main -->|loop| AgentLoop[Agentic Loop]
    AgentLoop -->|invoke| LLM
    LLM -->|tool_calls| ToolExec[Tool Execution]
    ToolExec -->|checkPermission| PermMgr[ToolPermissionManager<br>src/security.ts]
    ToolExec -->|run| ToolReg
    ToolExec -->|ToolMessage| AgentLoop
    AgentLoop -->|no tool_calls| Main
    Main -->|output| User
```

---

## Agent Loop Flow

The main loop in `src/index.ts` follows this sequence on every invocation:

```mermaid
sequenceDiagram
    participant User
    participant AL as Agent Loop
    participant LLM
    participant Tool as Tool(s)

    User->>AL: executeWithTools(input)
    AL->>AL: ensureInitialized()
    AL->>AL: build SystemMessage + trim context
    loop Until no tool_calls or MAX_ITERATIONS
        AL->>LLM: invoke(messages)
        LLM-->>AL: AIMessage
        alt has tool_calls
            loop For each tool call
                AL->>Tool: checkPermission + invoke
                Tool-->>AL: ToolMessage
            end
        else no tool_calls
            AL-->>User: { output }
        end
    end
    AL-->>User: { output } (MAX_ITERATIONS warning)
```

**Key behaviours:**

- `ensureInitialized()` runs exactly once — it loads all tools from `src/tools/`, connects MCP servers, binds them to the LLM with `bindTools()`, and loads prompt templates, skills and agent profiles.
- Each LLM call is wrapped in an exponential back-off retry (`src/retry.ts`) and an `AbortController`-based timeout.
- Tool calls are executed through `ToolPermissionManager` (blocklist / allowlist / permission level) and `ConcurrencyLimiter`.
- Tool results are re-injected as `ToolMessage` entries so the LLM can reason about them in the next iteration.
- The context window is trimmed to `MAX_CONTEXT_TOKENS` tokens before each LLM call (`src/context.ts`).
- Every invocation produces a structured trace via `Tracer` (`src/observability.ts`) when `TRACING_ENABLED=true`.

---

## Module Map

| Module | Responsibility |
|---|---|
| `src/config.ts` | Dotenv initialization; exports `appConfig` with all runtime settings |
| `src/index.ts` | Main agentic loop, streaming variant, CLI REPL, `agentExecutor` export |
| `src/llm.ts` | `createLLM()` factory; provider switch block |
| `src/tools/registry.ts` | `ToolRegistry` class; `loadFromDirectory()` for dynamic tool discovery |
| `src/tools/*.ts` | Individual tool definitions; each exports a `toolDefinition` constant |
| `src/security.ts` | `ToolPermissionManager`, `ConcurrencyLimiter`, `checkNetworkAccess` |
| `src/context.ts` | Token counting and context trimming |
| `src/retry.ts` | `withRetry()`, `invokeWithTimeout()` |
| `src/streaming.ts` | `streamWithTools()` — streaming agent loop with chunk assembly |
| `src/observability.ts` | `Tracer`, `FileTracer`, `NoopTracer`, per-invocation JSON traces |
| `src/mcp/client.ts` | `McpClient` — MCP SDK wrapper for stdio/SSE transports |
| `src/mcp/bridge.ts` | `registerMcpTools()` — translates MCP tools into `ToolDefinition` entries |
| `src/subagents/runner.ts` | `runSubagent()` — isolated agent loop for a single subagent |
| `src/subagents/manager.ts` | `SubagentManager` — sequential and parallel subagent execution |
| `src/subagents/planner.ts` | LLM-driven planner that produces a `Plan` from a goal description |
| `src/orchestrator.ts` | `executePlan()` — plan execution with retry/skip/abort and checkpointing |
| `src/prompts/system.ts` | `getSystemPrompt()` — assembles the runtime system prompt |
| `src/prompts/registry.ts` | `PromptRegistry` — versioned prompt template storage |
| `src/prompts/context.ts` | `getCachedPromptContext()` — TTL-cached runtime context injection |
| `src/skills/registry.ts` | `SkillRegistry` — loads and exposes skill definitions |
| `src/agents/registry.ts` | `AgentProfileRegistry` — loads agent profile JSON/YAML files |
| `src/agents/activator.ts` | `activateProfile()` — applies a profile's overrides to runtime config |
| `src/workspace.ts` | `analyzeWorkspace()` — detects language, framework, and lifecycle commands |
| `src/logger.ts` | Structured Pino logger; configured from `appConfig.logger` |
| `src/errors.ts` | `ToolExecutionError`, `ToolBlockedError` typed error classes |

---

## Subagent Architecture

Subagents are isolated agent loops that run a focused task with a restricted tool set. They do not share message history with the parent and communicate only through their return value.

```mermaid
graph TD
    Parent[Parent Agent Loop] -->|runSubagent| SubRunner[runSubagent<br>src/subagents/runner.ts]
    Parent -->|runParallel| SubMgr[SubagentManager<br>src/subagents/manager.ts]
    SubMgr -->|Promise.allSettled| S1[Subagent 1]
    SubMgr -->|Promise.allSettled| S2[Subagent 2]
    SubMgr -->|Promise.allSettled| SN[Subagent N]
    SubMgr -->|conflict detection| ConflictInfo[ConflictInfo]
    SubRunner -->|isolated loop| IsolatedLLM[LLM + filtered tools]
    IsolatedLLM -->|SubagentResult| Parent

    style S1 fill:#e8f4f8
    style S2 fill:#e8f4f8
    style SN fill:#e8f4f8
```

**Parallel execution conflict detection:** `SubagentManager.runParallel()` uses the optional `mutatesFile` hook on each `ToolDefinition` to track which files each subagent wrote to. Conflicts (same file modified by more than one subagent) are reported in `ParallelResult.conflicts`.

---

## Plan Execution (Orchestrator)

The orchestrator executes a `Plan` — a sequence of `PlanStep` objects — produced by `Planner`. Each step runs as a subagent with an iteration budget derived from its `estimatedComplexity`.

```mermaid
graph LR
    Goal[Goal string] --> Planner[Planner<br>src/subagents/planner.ts]
    Planner -->|Plan| Orchestrator[executePlan<br>src/orchestrator.ts]
    Orchestrator --> Step1[Step 1<br>low → 3 iter]
    Orchestrator --> Step2[Step 2<br>medium → 5 iter]
    Orchestrator --> StepN[Step N<br>high → 10 iter]
    Step1 -->|StepResult| Checkpoint[Checkpoint<br>save after each step]
    Checkpoint -->|resume| Orchestrator
```

Failure strategies per step: `retry` (default), `skip`, or `abort`.

---

## MCP Integration

The Model Context Protocol (MCP) bridge connects to external tool servers at startup and registers their tools in the local `ToolRegistry` so the agent loop treats them identically to built-in tools.

```mermaid
graph LR
    Config[MCP_SERVERS config] --> Bridge[registerMcpTools<br>src/mcp/bridge.ts]
    Bridge --> Client1[McpClient stdio]
    Bridge --> Client2[McpClient sse]
    Client1 -->|listTools| External1[External MCP Server]
    Client2 -->|listTools| External2[Remote MCP Endpoint]
    Bridge -->|register| ToolReg[ToolRegistry]
```

Each MCP tool's JSON Schema is converted to a Zod schema at registration time. The `McpClient` also supports sampling callbacks (MCP server requests an LLM completion) and resource/prompt discovery.

---

## Streaming Mode

When `STREAMING_ENABLED=true`, the agent loop switches to `streamWithTools()` in `src/streaming.ts`. The LLM is called via `.stream()`, text chunks are yielded immediately, and `ToolCallChunk` fragments are accumulated until a complete tool call is assembled before execution.

```mermaid
sequenceDiagram
    participant CLI
    participant Stream as streamWithTools
    participant LLM
    participant Tool

    CLI->>Stream: executeWithToolsStream(input)
    loop Until done
        Stream->>LLM: stream(messages)
        loop chunks
            alt text chunk
                LLM-->>CLI: yield text
            else tool call chunk
                LLM-->>Stream: accumulate
            end
        end
        Stream->>Tool: execute accumulated tool calls
        Tool-->>Stream: ToolMessage
    end
    Stream-->>CLI: (generator exhausted)
```
