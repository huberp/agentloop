# Architecture

```mermaid
graph TD
  CLI[Click CLI] --> Executor[AgentExecutor]
  Executor --> Agent[PydanticAI Agent]
  Executor --> Profiles[AgentProfileRegistry]
  Executor --> Tools[ToolRegistry]
  Executor --> MCP[MCP toolsets]
  Executor --> Tracing[Logfire / FileTracer]
  Agent --> History[list[ModelMessage]]
  Agent --> Skills[SkillsCapability]
```

## Runtime flow

1. Load settings from `.env`, env vars, and JSON overrides.
2. Discover tools from `src/agentloop/tools/`.
3. Load agent profiles and skills.
4. Build a PydanticAI `Agent` with local tools and MCP toolsets.
5. Run non-streaming with `agent.run(...)` or streaming with `agent.run_stream(...)`.
6. Record usage and trace events.
