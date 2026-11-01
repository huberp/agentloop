from __future__ import annotations

from pathlib import Path

from agentloop.config import Settings


def test_settings_defaults(tmp_path: Path) -> None:
    settings = Settings(workspace_root=tmp_path)
    assert settings.llm_provider == "mistral"
    assert settings.workspace_root == tmp_path


def test_settings_mcp_parsing(tmp_path: Path) -> None:
    settings = Settings(
        workspace_root=tmp_path,
        mcp_servers=[{"name": "demo", "transport": "stdio", "command": "echo"}],
    )
    assert settings.mcp_servers[0].command == "echo"


def test_settings_empty_string_list_env_values(monkeypatch: object, tmp_path: Path) -> None:
    monkeypatch.setenv("TOOL_ALLOWLIST", "")
    monkeypatch.setenv("TOOL_BLOCKLIST", "")
    monkeypatch.setenv("SHELL_COMMAND_BLOCKLIST", "")

    settings = Settings(_env_file=None, workspace_root=tmp_path)

    assert settings.tool_allowlist == []
    assert settings.tool_blocklist == []
    assert settings.shell_command_blocklist == []


def test_settings_csv_list_env_values(monkeypatch: object, tmp_path: Path) -> None:
    monkeypatch.setenv("TOOL_ALLOWLIST", "file_read, file_write ,shell")

    settings = Settings(_env_file=None, workspace_root=tmp_path)

    assert settings.tool_allowlist == ["file_read", "file_write", "shell"]


def test_settings_empty_mcp_servers_env_value(monkeypatch: object, tmp_path: Path) -> None:
    monkeypatch.setenv("MCP_SERVERS", "")

    settings = Settings(_env_file=None, workspace_root=tmp_path)

    assert settings.mcp_servers == []
