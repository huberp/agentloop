# Getting Started

## Install

```bash
uv sync
cp .env.example .env
```

Set `MISTRAL_API_KEY` in `.env`.

## First command

```bash
agentloop agent -u "Explain this project"
```

## Offline tests

The test suite uses `pydantic_ai.models.test.TestModel`, so CI and local tests do not require a live LLM API call.

```bash
uv run pytest -q
```
