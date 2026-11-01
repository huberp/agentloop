from __future__ import annotations

import json
from pathlib import Path
from typing import Annotated, Any, Literal

from pydantic import Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, NoDecode, PydanticBaseSettingsSource, SettingsConfigDict

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
    tool_allowlist: Annotated[list[str], NoDecode] = Field(default_factory=list)
    tool_blocklist: Annotated[list[str], NoDecode] = Field(default_factory=list)
    shell_command_blocklist: Annotated[list[str], NoDecode] = Field(default_factory=list)
    max_concurrent_tools: int = 5

    workspace_root: Path = Field(default_factory=Path.cwd)
    system_prompt_path: str = ""
    skills_dir: str = ""
    agent_profiles_dir: str = ""
    prompt_templates_dir: str = ""

    max_file_size_bytes: int = 5_000_000
    max_shell_output_bytes: int = 500_000
    network_allowed_domains: Annotated[list[str], NoDecode] = Field(default_factory=list)

    web_search_provider: Literal["duckduckgo", "tavily", "none"] = "duckduckgo"
    tavily_api_key: SecretStr = SecretStr("")
    duckduckgo_max_results: int = 5

    web_domain_blocklist: Annotated[list[str], NoDecode] = Field(default_factory=list)
    web_domain_allowlist: Annotated[list[str], NoDecode] = Field(default_factory=list)
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
    mcp_servers: Annotated[list[McpServerConfig], NoDecode] = Field(default_factory=list)

    @staticmethod
    def _parse_string_list(value: Any) -> list[str]:
        if value is None:
            return []
        if isinstance(value, list):
            return [str(item).strip() for item in value if str(item).strip()]
        if isinstance(value, str):
            raw = value.strip()
            if not raw:
                return []
            try:
                parsed = json.loads(raw)
            except json.JSONDecodeError:
                parsed = None
            if isinstance(parsed, list):
                return [str(item).strip() for item in parsed if str(item).strip()]
            return [item.strip() for item in raw.split(",") if item.strip()]
        return [str(value).strip()] if str(value).strip() else []

    @field_validator(
        "tool_allowlist",
        "tool_blocklist",
        "shell_command_blocklist",
        "network_allowed_domains",
        "web_domain_blocklist",
        "web_domain_allowlist",
        mode="before",
    )
    @classmethod
    def _validate_string_list_fields(cls, value: Any) -> list[str]:
        return cls._parse_string_list(value)

    @field_validator("mcp_servers", mode="before")
    @classmethod
    def _validate_mcp_servers(cls, value: Any) -> Any:
        if value is None:
            return []
        if isinstance(value, str):
            raw = value.strip()
            if not raw:
                return []
            try:
                return json.loads(raw)
            except json.JSONDecodeError as exc:
                raise ValueError("mcp_servers must be a JSON array") from exc
        return value

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
