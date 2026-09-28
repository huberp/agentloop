from __future__ import annotations

import logging
from typing import Literal

from fastmcp.client.transports import SSETransport, StdioTransport, StreamableHttpTransport
from pydantic import BaseModel, Field
from pydantic_ai.mcp import MCPToolset

logger = logging.getLogger(__name__)


class McpServerConfig(BaseModel):
    name: str
    transport: Literal["stdio", "sse", "http"]
    command: str | None = None
    args: list[str] = Field(default_factory=list)
    url: str | None = None


def build_mcp_servers(configs: list[McpServerConfig]) -> list[MCPToolset]:
    servers: list[MCPToolset] = []
    for config in configs:
        if config.transport == "stdio":
            if not config.command:
                logger.warning("Skipping MCP server without command: %s", config.name)
                continue
            servers.append(MCPToolset(StdioTransport(config.command, config.args), id=config.name))
            continue
        if not config.url:
            logger.warning("Skipping MCP server without url: %s", config.name)
            continue
        transport = SSETransport(config.url) if config.transport == "sse" else StreamableHttpTransport(config.url)
        servers.append(MCPToolset(transport, id=config.name))
    return servers
