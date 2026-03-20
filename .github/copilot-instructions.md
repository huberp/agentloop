# Copilot Instructions

## Runtime Configuration
- Read runtime configuration from dotenv-backed settings in `src/config.ts`.
- Do not read `process.env` directly in business logic files when a value exists in `appConfig`.
- Keep `.env.example` in sync whenever new configuration keys are introduced.

## Tooling Architecture
- Define tools in `src/tools.ts` using LangChain `tool()`.
- Bind tools in `src/index.ts` using `llm.bindTools(tools)`.
- Preserve the two-step tool flow:
  1. Model requests tool calls.
  2. Runtime executes tools and appends `ToolMessage` entries before final model response.
- Do not reintroduce backward compatibility hacks for missing `bindTools` unless explicitly required.

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
- Keep `src/__tests__/index.test.ts` compatible with current runtime behavior, including `bindTools` mocking.
- When tool execution behavior changes, add or update tests for:
  - no-tool response path
  - tool-called path
  - tool response re-injection path

## Documentation
- Update `README.md` after changing dependencies, runtime architecture, config keys, or logging behavior.
