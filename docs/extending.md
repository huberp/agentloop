# Extending Agentloop

## Add a tool

Create a new file in `src/agentloop/tools/` and decorate an async function with `@tool_def`.

## Add a profile

Drop a `*.agent.json` file into `src/agentloop/agents/builtin/` or a directory pointed to by `AGENT_PROFILES_DIR`.

## Add a skill

Create `src/agentloop/skills/builtin/<skill-name>/SKILL.md` with YAML frontmatter plus `## Description` and `## Instructions` sections.

## Parallel orchestration

Use `run_parallel_steps()` with independent `PlanStep` entries and avoid duplicate `mutates_paths` values.

## MCP

Configure `MCP_SERVERS` entries and Agentloop will build MCP toolsets for stdio, SSE, or HTTP transports.
