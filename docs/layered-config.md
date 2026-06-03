# Layered JSON Configuration

agentloop supports a **layered JSON configuration system** alongside the existing environment variable and CLI override workflow.

## Overview

Configuration is resolved in this order (later layers override earlier ones):

1. **Built-in defaults** — sensible defaults for all settings
2. **User-level JSON** — `~/.agentloop/config.json` (applies to all repos on a machine)
3. **Repo-level JSON** — `<repo>/.agentloop/config.json` (applies only inside one repository)
4. **Environment variables** — secrets and operational overrides
5. **CLI flags** — e.g. `--api-key`

## Config file locations

| Level | Path | Purpose |
|---|---|---|
| User | `~/.agentloop/config.json` | Personal defaults for all repositories |
| Repo | `.agentloop/config.json` (relative to working directory) | Project-specific settings |

Both files are optional. If a file does not exist, it is silently skipped.

## Structured config schema

Config files use a structured JSON format with typed nested sections:

```json
{
  "llm": {
    "provider": "mistral",
    "activeModel": "default",
    "temperature": 0.7,
    "model": "",
    "maxIterations": 20,
    "maxTokensBudget": 0,
    "maxContextTokens": 28000,
    "retryMax": 3,
    "retryBaseDelayMs": 500,
    "streamingEnabled": false
  },
  "models": [
    {
      "id": "default",
      "provider": "mistral",
      "model": "mistral-small-latest",
      "temperature": 0.2,
      "maxTokens": 4096,
      "apiKeyEnv": "MISTRAL_API_KEY",
      "enabled": true
    }
  ],
  "tools": {
    "timeoutMs": 30000,
    "allowlist": [],
    "blocklist": [],
    "maxConcurrent": 10,
    "shellCommandBlocklist": [],
    "autoApproveAll": false
  },
  "execution": {
    "timeoutMs": 60000,
    "environment": "local",
    "sandboxMode": "none",
    "dockerImage": "node:20-alpine"
  },
  "paths": {
    "workspaceRoot": null,
    "instructionsRoot": null,
    "promptTemplatesDir": "",
    "promptHistoryFile": "",
    "skillsDir": "",
    "agentProfilesDir": "",
    "systemPromptPath": ""
  },
  "prompts": {
    "contextRefreshMs": 5000,
    "runtimeContextEnabled": true
  },
  "search": {
    "provider": "duckduckgo",
    "tavilyMaxResults": 5,
    "langsearchMaxResults": 5,
    "duckduckgoMaxResults": 5,
    "duckduckgoMinDelayMs": 1000,
    "duckduckgoRetryMax": 2,
    "duckduckgoRetryBaseDelayMs": 400,
    "duckduckgoRateLimitPenaltyMs": 1000,
    "duckduckgoCacheTtlMs": 300000,
    "duckduckgoCacheMaxEntries": 128,
    "duckduckgoServeStaleOnError": true
  },
  "observability": {
    "tracingEnabled": false,
    "traceOutputDir": "./traces",
    "tracingCostPerInputTokenUsd": 0,
    "tracingCostPerOutputTokenUsd": 0,
    "logLevel": "info",
    "logEnabled": true,
    "logDestination": "stdout",
    "logFile": "",
    "logName": "agentloop",
    "logTimestamp": true
  },
  "security": {
    "maxFileSizeBytes": 10485760,
    "maxShellOutputBytes": 1048576,
    "networkAllowedDomains": []
  },
  "webFetch": {
    "domainBlocklist": [],
    "domainAllowlist": [],
    "allowHttp": false,
    "maxResponseBytes": 5242880,
    "maxContentChars": 20000,
    "userAgent": "AgentLoop/1.0",
    "fetchTimeoutMs": 15000
  }
}
```

All sections are optional — you only need to include the fields you want to override.

## Models configuration

The `models` array supports multiple named model configurations:

```json
{
  "llm": {
    "activeModel": "default"
  },
  "models": [
    {
      "id": "default",
      "provider": "mistral",
      "model": "mistral-small-latest",
      "temperature": 0.2
    },
    {
      "id": "strong",
      "provider": "mistral",
      "model": "mistral-large-latest",
      "temperature": 0.1
    }
  ]
}
```

### Model merge behavior

When both user and repo configs define models, they are merged by `id`:

- If the repo defines a model with the same `id` as the user config, fields are merged (repo wins per-field)
- If the repo introduces a new `id`, it is appended
- Base models are preserved unless overridden
- Order is deterministic: user models first, then new repo models

**Example:**

User config (`~/.agentloop/config.json`):
```json
{
  "models": [
    { "id": "default", "provider": "mistral", "model": "mistral-small-latest", "temperature": 0.2 }
  ]
}
```

Repo config (`.agentloop/config.json`):
```json
{
  "models": [
    { "id": "default", "provider": "mistral", "model": "mistral-medium-latest" },
    { "id": "strong", "provider": "mistral", "model": "mistral-large-latest", "temperature": 0.1 }
  ]
}
```

Result:
- `default` model uses `mistral-medium-latest` (repo override) with `temperature: 0.2` (preserved from user)
- `strong` model is added from repo config

## Merge behavior (general)

| Type | Behavior |
|---|---|
| Objects | Deep recursive merge |
| Scalars | Later layer replaces earlier |
| `models` array | Merge by `id` |
| Other arrays | Later layer replaces entirely |

## Secrets and API keys

**Do not put API keys in JSON config files.** Use environment variables:

```bash
# In .env or shell environment
MISTRAL_API_KEY=your-key-here
TAVILY_API_KEY=your-tavily-key
LANGSEARCH_API_KEY=your-langsearch-key
```

The `--api-key` CLI flag continues to work:

```bash
npx agentloop --api-key sk-your-key
```

## Error handling

- **Invalid JSON** → clear error with file path
- **Unknown config keys** → error listing unknown keys and valid alternatives
- **Invalid model entries** → error identifying which model entry is invalid
- **Missing files** → silently skipped (not an error)

## Migration from `.env`-only config

The new JSON config system is **fully backward compatible**. Your existing `.env`-based setup continues to work without changes.

To gradually migrate:

1. **Keep secrets in `.env`** — API keys should stay in environment variables
2. **Move non-secret settings to JSON** — Create `~/.agentloop/config.json` for personal defaults
3. **Add repo-specific overrides** — Create `.agentloop/config.json` in your repo for project settings
4. **Remove env vars** — Once settings are in JSON, you can remove the corresponding env vars

Environment variables always override JSON config, so both can coexist during migration.

### Example migration

Before (`.env` only):
```env
LLM_PROVIDER=mistral
LLM_TEMPERATURE=0.3
TOOL_TIMEOUT_MS=60000
MISTRAL_API_KEY=sk-your-key
```

After (JSON + env for secrets):

`~/.agentloop/config.json`:
```json
{
  "llm": { "provider": "mistral", "temperature": 0.3 },
  "tools": { "timeoutMs": 60000 }
}
```

`.env`:
```env
MISTRAL_API_KEY=sk-your-key
```

## Environment variable reference

All existing environment variables continue to work. See [configuration.md](configuration.md) for the full list.

Environment variables map to JSON config sections as follows:

| Env var | JSON path |
|---|---|
| `LLM_PROVIDER` | `llm.provider` |
| `LLM_MODEL` | `llm.model` |
| `LLM_TEMPERATURE` | `llm.temperature` |
| `MAX_ITERATIONS` | `llm.maxIterations` |
| `TOOL_TIMEOUT_MS` | `tools.timeoutMs` |
| `TOOL_ALLOWLIST` | `tools.allowlist` |
| `TOOL_BLOCKLIST` | `tools.blocklist` |
| `EXECUTION_TIMEOUT_MS` | `execution.timeoutMs` |
| `SANDBOX_MODE` | `execution.sandboxMode` |
| `WEB_SEARCH_PROVIDER` | `search.provider` |
| `TRACING_ENABLED` | `observability.tracingEnabled` |
| `LOG_LEVEL` | `observability.logLevel` |

(See `src/config/load.ts` for the complete mapping.)
