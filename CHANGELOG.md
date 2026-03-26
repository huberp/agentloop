# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Multi-stage `Dockerfile` for containerized deployment (builder + runner stages).
- `.dockerignore` to minimise Docker build context.
- `npm run build` / `npm run build:clean` / `npm run start:prod` scripts.
- GitHub Actions CI workflow (`.github/workflows/ci.yml`): test → build → artifact upload.
- Optional npm-publish job (commented out; see instructions in `ci.yml`).
- `declaration`, `declarationMap`, and `sourceMap` compiler options in `tsconfig.json`.
- Package scoped to `@huberp/agentloop` with `files`, `main`, and `types` fields.

## [1.0.0] - 2026-03-26

### Added

#### Phase 1 – Core Agent Loop
- TypeScript project scaffold with `ts-jest` and strict mode enabled.
- Mistral LLM integration via `@langchain/mistralai`.
- Agentic loop (`executeWithTools`) with configurable `MAX_ITERATIONS` guard.
- `InMemoryChatMessageHistory` for multi-turn conversation state.
- Dotenv-backed `appConfig` in `src/config.ts` as the single source of runtime config.
- Structured logger (`src/logger.ts`) backed by Pino with machine-readable JSON output.
- `ToolRegistry` with auto-discovery from `src/tools/` directory.
- Tool permission manager: allowlist / blocklist / auto-approve modes.
- Per-tool concurrency limiter and timeout (`TOOL_TIMEOUT_MS`).
- Context trimming to stay within `MAX_CONTEXT_TOKENS` before each LLM call.
- LLM retry with exponential back-off (`LLM_RETRY_MAX`, `LLM_RETRY_BASE_DELAY_MS`).

#### Phase 2 – Built-in Tools
- `shell` tool with configurable `SHELL_COMMAND_BLOCKLIST`.
- `file-read`, `file-write`, `file-list`, `file-edit`, `file-delete` tools with workspace-root path sandboxing.
- `code-run` tool for executing code snippets (Node.js / Python).
- `code-search` tool (ripgrep-backed regex search across the workspace).
- `calculate` tool (mathjs-powered safe expression evaluator).
- `diff` and `patch` tools for structured file diffing and patching.
- `git-status`, `git-log`, `git-diff`, `git-commit` tools via `simple-git`.
- `search` tool for workspace-scoped full-text search.
- Input sanitisation helpers in `src/tools/sanitize.ts`.

#### Phase 3 – Streaming & Observability
- Streaming agent loop (`executeWithToolsStream`) using `streamWithTools`.
- `STREAMING_ENABLED` config flag.
- Invocation tracer (`src/observability.ts`) with per-call cost and token accounting.
- `FileTracer` writes structured NDJSON trace files to a configurable `TRACE_OUTPUT_DIR`.
- `NoopTracer` used when tracing is disabled (zero overhead).

#### Phase 4 – Security & Sandboxing
- Security-hardening module (`src/security.ts`): path traversal prevention, size limits, dangerous-pattern rejection.
- Docker sandbox mode for `code-run` (`SANDBOX_MODE=docker`, `SANDBOX_DOCKER_IMAGE`).
- MCP client integration (`src/mcp/`): connects to external MCP servers on startup via `MCP_SERVERS` JSON config.

#### Phase 5 – Prompts & Skills
- `PromptRegistry` with file-based template loading, variable substitution, and tag filtering.
- Prompt version history persisted to `PROMPT_HISTORY_FILE`.
- Dynamic prompt context injection (workspace snapshot, active tools, instructions) with TTL cache.
- `SkillRegistry` with builtin skills and runtime `SKILLS_DIR` loading.
- Instruction file loader (`.instructions.md`, `AGENTS.md`) via `src/instructions/loader.ts`.

#### Phase 6 – Agent Profiles & Orchestration
- `AgentProfileRegistry`: YAML/JSON agent profile files with per-profile model, temperature, tool allowlist, and max-iterations overrides.
- Builtin agent profiles shipped in `src/agents/builtin/`.
- Subagent manager, planner, and runner (`src/subagents/`).
- Coordinator for multi-agent task routing.

[Unreleased]: https://github.com/huberp/agentloop/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/huberp/agentloop/releases/tag/v1.0.0
