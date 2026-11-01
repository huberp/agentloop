# Configuration

`Settings` is defined in `src/agentloop/config.py` and backed by `pydantic-settings`.

| Field | Env var | Default |
|---|---|---|
| `mistral_api_key` | `MISTRAL_API_KEY` | `""` |
| `llm_provider` | `LLM_PROVIDER` | `mistral` |
| `llm_model` | `LLM_MODEL` | `mistral-large-latest` |
| `llm_temperature` | `LLM_TEMPERATURE` | `0.0` |
| `max_iterations` | `MAX_ITERATIONS` | `20` |
| `max_tokens_budget` | `MAX_TOKENS_BUDGET` | `4000` |
| `max_context_tokens` | `MAX_CONTEXT_TOKENS` | `8000` |
| `llm_retry_max` | `LLM_RETRY_MAX` | `3` |
| `llm_retry_base_delay_ms` | `LLM_RETRY_BASE_DELAY_MS` | `200` |
| `tool_timeout_ms` | `TOOL_TIMEOUT_MS` | `30000` |
| `auto_approve_all` | `AUTO_APPROVE_ALL` | `false` |
| `tool_allowlist` | `TOOL_ALLOWLIST` | `[]` |
| `tool_blocklist` | `TOOL_BLOCKLIST` | `[]` |
| `shell_command_blocklist` | `SHELL_COMMAND_BLOCKLIST` | `[]` |
| `max_concurrent_tools` | `MAX_CONCURRENT_TOOLS` | `5` |
| `workspace_root` | `WORKSPACE_ROOT` | `cwd` |
| `system_prompt_path` | `SYSTEM_PROMPT_PATH` | `""` |
| `skills_dir` | `SKILLS_DIR` | `""` |
| `agent_profiles_dir` | `AGENT_PROFILES_DIR` | `""` |
| `prompt_templates_dir` | `PROMPT_TEMPLATES_DIR` | `""` |
| `max_file_size_bytes` | `MAX_FILE_SIZE_BYTES` | `5000000` |
| `max_shell_output_bytes` | `MAX_SHELL_OUTPUT_BYTES` | `500000` |
| `network_allowed_domains` | `NETWORK_ALLOWED_DOMAINS` | `[]` |
| `web_search_provider` | `WEB_SEARCH_PROVIDER` | `duckduckgo` |
| `tavily_api_key` | `TAVILY_API_KEY` | `""` |
| `duckduckgo_max_results` | `DUCKDUCKGO_MAX_RESULTS` | `5` |
| `web_domain_blocklist` | `WEB_DOMAIN_BLOCKLIST` | `[]` |
| `web_domain_allowlist` | `WEB_DOMAIN_ALLOWLIST` | `[]` |
| `web_allow_http` | `WEB_ALLOW_HTTP` | `false` |
| `web_max_response_bytes` | `WEB_MAX_RESPONSE_BYTES` | `2000000` |
| `web_fetch_timeout_ms` | `WEB_FETCH_TIMEOUT_MS` | `10000` |
| `streaming_enabled` | `STREAMING_ENABLED` | `false` |
| `tracing_enabled` | `TRACING_ENABLED` | `false` |
| `trace_output_dir` | `TRACE_OUTPUT_DIR` | `traces` |
| `tracing_cost_per_input_token_usd` | `TRACING_COST_PER_INPUT_TOKEN_USD` | `0.0` |
| `tracing_cost_per_output_token_usd` | `TRACING_COST_PER_OUTPUT_TOKEN_USD` | `0.0` |
| `log_level` | `LOG_LEVEL` | `INFO` |
| `log_enabled` | `LOG_ENABLED` | `true` |
| `log_destination` | `LOG_DESTINATION` | `stdout` |
| `log_file` | `LOG_FILE` | `""` |
| `ui_mode` | `UI_MODE` | `cli` |
| `orchestrator` | `ORCHESTRATOR` | `default` |
| `plan_only` | `PLAN_ONLY` | `false` |
| `mcp_servers` | `MCP_SERVERS` | `[]` |

`mcp_servers` is parsed into `McpServerConfig` items with `name`, `transport`, `command`, `args`, and `url`.
Optional Logfire support uses `LOGFIRE_TOKEN` from the environment.
