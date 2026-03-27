# Copilot Instructions

## Runtime Configuration
- Read runtime configuration from dotenv-backed settings in `src/config.ts`.
- Do not read `process.env` directly in business logic files when a value exists in `appConfig`.
- Keep `.env.example` in sync whenever new configuration keys are introduced.

## Tooling Architecture
- Each tool lives in its own file under `src/tools/` and exports a `toolDefinition: ToolDefinition` object.
- `ToolRegistry.loadFromDirectory()` in `src/tools/registry.ts` auto-discovers all `.ts` files that export `toolDefinition`. Adding a new tool file requires no other edits.
- Tools are bound to the LLM in `src/index.ts` via `llm.bindTools(toolRegistry.toLangChainTools())` during the lazy `ensureInitialized()` call.
- Preserve the two-step tool flow:
  1. Model requests tool calls.
  2. Runtime executes tools and appends `ToolMessage` entries before final model response.
- Do not reintroduce backward compatibility hacks for missing `bindTools` unless explicitly required.

## MCP Integration
- MCP client is in `src/mcp/client.ts` (`McpClient` class) and `src/mcp/bridge.ts` (`registerMcpTools`).
- Configure servers via `MCP_SERVERS` env var (JSON array of `{ name, transport, command?, args?, url? }`).
- MCP tools are registered into the `ToolRegistry` during `ensureInitialized()` alongside built-in tools.

## Security Layer
- `ToolPermissionManager` in `src/security.ts` enforces blocklist/allowlist and per-tool permission levels (`"safe"/"cautious"/"dangerous"`) before every tool execution.
- `ToolBlockedError` from `src/errors.ts` is thrown on rejection and injected as a `ToolMessage` by `src/index.ts` so the LLM can reason about it.
- Configure via `AUTO_APPROVE_ALL`, `TOOL_ALLOWLIST`, `TOOL_BLOCKLIST` env vars.

## Agent Profiles and Skills
- Agent profiles are JSON files under `src/agents/builtin/` (and optionally `AGENT_PROFILES_DIR`).
- Skills are Markdown files under `src/skills/builtin/` (and optionally `SKILLS_DIR`).
- Both are auto-loaded during `ensureInitialized()`. Profiles can restrict which tools are active, override model/temperature, and set iteration limits.
- `activateProfile()` in `src/agents/activator.ts` converts a profile into an `AgentRuntimeConfig`.

## Orchestrator and Subagents
- `executePlan()` in `src/orchestrator.ts` runs multi-step plans: simple steps via `runSubagent()` directly, complex steps via `SubagentManager`.
- Supports `resumeFrom` (1-based), `onStepFailure` (`retry/skip/abort`), and a pluggable `CheckpointStore`.
- Subagent runner is in `src/subagents/runner.ts`; planner is in `src/subagents/planner.ts`.

## Streaming Support
- `streamWithTools()` in `src/streaming.ts` is the streaming-capable agent loop.
- `agentExecutor.stream` in `src/index.ts` is the public API; it delegates to `streamWithTools`.
- Enable via `STREAMING_ENABLED=true`; the CLI prints tokens as they arrive.

## Observability
- `Tracer` interface and `FileTracer`/`NoopTracer` implementations are in `src/observability.ts`.
- Inject a custom tracer in tests with `setTracer()` exported from `src/index.ts`.
- Configure via `TRACING_ENABLED`, `TRACE_OUTPUT_DIR`, `TRACING_COST_PER_INPUT_TOKEN_USD`, `TRACING_COST_PER_OUTPUT_TOKEN_USD`.

## Logging Guidelines
- Use the shared logger from `src/logger.ts`.
- Log tool lifecycle events with structured fields:
  - invocation: tool name, call id, arguments
  - completion: tool name, call id, response
- Keep logger output machine-readable and avoid ad hoc string-only logs.
- Default destination is stdout; destination and verbosity must stay configurable via dotenv values.

## Security and Reliability
- Avoid `eval` in production tool implementations.
- When adding external API tools, validate input and handle failures explicitly.
- Prefer deterministic outputs for tests and mocked tool responses.

## Testing
- Run tests with `npx jest`; use `--testPathPatterns` (not `--testPathPattern`) for filtering in Jest v30+.
- Keep `src/__tests__/index.test.ts` compatible with current runtime behavior, including `bindTools` mocking.
- When tool execution behavior changes, add or update tests for:
  - no-tool response path
  - tool-called path
  - tool response re-injection path
- `ts-jest` with `isolatedModules: true` in `tsconfig.json` is required to prevent OOM during tests.
- ESM-only transitive deps are shimmed via `moduleNameMapper` in `package.json` (see `tests/jest-shims/`).

## Documentation
- Update `README.md` after changing dependencies, runtime architecture, config keys, or logging behavior.
