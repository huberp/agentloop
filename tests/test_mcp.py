from __future__ import annotations

from pydantic_ai.mcp import MCPToolset

from agentloop.config import Settings
from agentloop.mcp import McpServerConfig, build_mcp_servers


def test_mcp_settings_parse(tmp_path) -> None:
    settings = Settings(
        workspace_root=tmp_path,
        mcp_servers=[{"name": "demo", "transport": "stdio", "command": "python", "args": ["server.py"]}],
    )
    assert settings.mcp_servers[0].command == "python"


def test_build_mcp_servers_supports_stdio_and_http() -> None:
    servers = build_mcp_servers(
        [
            McpServerConfig(name="stdio", transport="stdio", command="python", args=["server.py"]),
            McpServerConfig(name="http", transport="http", url="http://localhost:8000/mcp"),
            McpServerConfig(name="sse", transport="sse", url="http://localhost:8001/sse"),
        ]
    )
    assert len(servers) == 3
    assert all(isinstance(server, MCPToolset) for server in servers)


def test_build_mcp_servers_skips_invalid_configs() -> None:
    servers = build_mcp_servers(
        [
            McpServerConfig(name="missing-cmd", transport="stdio"),
            McpServerConfig(name="missing-url", transport="http"),
        ]
    )
    assert servers == []
