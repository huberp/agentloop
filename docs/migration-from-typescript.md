# Migration from TypeScript

Agentloop moved from the previous TypeScript agent stack to Python/PydanticAI.

| Removed | Replacement |
|---|---|
| prior message/tool loop | PydanticAI `Agent` |
| prior graph orchestration runtime | `agentloop.orchestrator` |
| Zod schemas | Pydantic models |
| Jest + ts-jest | `pytest` + `pytest-asyncio` |
| pino logging | `structlog` |
| npm dotenv config layer | `pydantic-settings` |

Behavioral differences:

- tool validation errors now come from Pydantic instead of Zod
- streaming uses `agent.run_stream()`
- MCP is configured through typed Python models
