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
