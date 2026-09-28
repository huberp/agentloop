# Agentloop

[![PydanticAI](https://img.shields.io/badge/PydanticAI-powered-7c3aed)](https://ai.pydantic.dev)

Agentloop is a Python agent runtime built on PydanticAI. It provides a Click CLI, structured tool registry, MCP integration, agent profiles, skills, orchestration, and Logfire-compatible observability.

## Requirements

- Python 3.11+
- `uv` recommended
- `MISTRAL_API_KEY` in `.env`

## Quick start

```bash
uv sync
cp .env.example .env
agentloop --help
agentloop agent -u "Summarize this repository"
```

## CLI

```bash
agentloop agent -u "2 + 2" --json
agentloop agent -u "List project files" --stream
agentloop websearch -q "pydantic ai"
agentloop web-fetch -u "https://example.com"
agentloop list tools --json
```

## Programmatic API

```python
from agentloop import AgentExecutor

executor = AgentExecutor()
await executor.initialize()
print(await executor.invoke("Summarize this project"))

async for token in executor.stream("What changed recently?"):
    print(token, end="", flush=True)
```

## Configuration

Settings are loaded from, in order:

1. constructor / CLI overrides
2. environment variables
3. `.env`
4. `docs/examples/user-config.json`
5. `docs/examples/repo-config.json`
6. defaults in `src/agentloop/config.py`

## Development

```bash
uv run pytest -q
uv run python -m agentloop --help
```

See `docs/` for architecture, tools, testing, configuration, and migration notes.
