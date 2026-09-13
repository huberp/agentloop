from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Literal

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, PydanticBaseSettingsSource, SettingsConfigDict

from agentloop.mcp import McpServerConfig


class JsonConfigSettingsSource(PydanticBaseSettingsSource):
    def __init__(self, settings_cls: type[BaseSettings], path: Path) -> None:
        super().__init__(settings_cls)
        self.path = path

    def get_field_value(self, field: Any, field_name: str) -> tuple[Any, str, bool]:
        data = self()
        return data.get(field_name), field_name, False

    def __call__(self) -> dict[str, Any]:
        if not self.path.exists():
            return {}
        raw = json.loads(self.path.read_text())
        return {str(key): value for key, value in raw.items()}

class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_nested_delimiter="__",
        extra="ignore",
        validate_default=True,
    )

    mistral_api_key: SecretStr = SecretStr("")
    llm_provider: str = "mistral"
    llm_model: str = "mistral-large-latest"
    llm_temperature: float = 0.0
    max_iterations: int = 20
    max_tokens_budget: int = 4000
    max_context_tokens: int = 8000
    llm_retry_max: int = 3
    llm_retry_base_delay_ms: int = 200

    tool_timeout_ms: int = 30000
    auto_approve_all: bool = False
    tool_allowlist: list[str] = Field(default_factory=list)
    tool_blocklist: list[str] = Field(default_factory=list)
    shell_command_blocklist: list[str] = Field(default_factory=list)
    max_concurrent_tools: int = 5

    workspace_root: Path = Field(default_factory=Path.cwd)
    system_prompt_path: str = ""
    skills_dir: str = ""
    agent_profiles_dir: str = ""
    prompt_templates_dir: str = ""

    max_file_size_bytes: int = 5_000_000
    max_shell_output_bytes: int = 500_000
    network_allowed_domains: list[str] = Field(default_factory=list)

    web_search_provider: Literal["duckduckgo", "tavily", "none"] = "duckduckgo"
    tavily_api_key: SecretStr = SecretStr("")
    duckduckgo_max_results: int = 5

    web_domain_blocklist: list[str] = Field(default_factory=list)
    web_domain_allowlist: list[str] = Field(default_factory=list)
    web_allow_http: bool = False
    web_max_response_bytes: int = 2_000_000
    web_fetch_timeout_ms: int = 10000

    streaming_enabled: bool = False

    tracing_enabled: bool = False
    trace_output_dir: str = "traces"
    tracing_cost_per_input_token_usd: float = 0.0
    tracing_cost_per_output_token_usd: float = 0.0

    log_level: str = "INFO"
    log_enabled: bool = True
    log_destination: Literal["stdout", "stderr"] = "stdout"
    log_file: str = ""

    ui_mode: Literal["cli", "tui"] = "cli"
    orchestrator: Literal["default"] = "default"
    plan_only: bool = False
    mcp_servers: list[McpServerConfig] = Field(default_factory=list)

    @classmethod
    def settings_customise_sources(
        cls,
        settings_cls: type[BaseSettings],
        init_settings: PydanticBaseSettingsSource,
        env_settings: PydanticBaseSettingsSource,
        dotenv_settings: PydanticBaseSettingsSource,
        file_secret_settings: PydanticBaseSettingsSource,
    ) -> tuple[PydanticBaseSettingsSource, ...]:
        root = Path.cwd()
        return (
            init_settings,
            env_settings,
            dotenv_settings,
            JsonConfigSettingsSource(settings_cls, root / 'docs/examples/user-config.json'),
            JsonConfigSettingsSource(settings_cls, root / 'docs/examples/repo-config.json'),
            file_secret_settings,
        )


settings = Settings()
