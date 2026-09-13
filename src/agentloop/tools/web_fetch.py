from __future__ import annotations

from typing import Any

from pydantic import BaseModel
from pydantic_ai import RunContext
from pydantic_ai.common_tools.web_fetch import web_fetch_tool

from agentloop.agent import AgentDeps
from agentloop.tools._common import json_dumps
from agentloop.tools.registry import tool_def


class WebFetchInput(BaseModel):
    url: str


@tool_def(name="web_fetch", description="Fetch a web page as markdown", permissions="safe")
async def web_fetch(ctx: RunContext[AgentDeps], args: WebFetchInput) -> str:
    tool = web_fetch_tool(
        max_content_length=ctx.deps.settings.web_max_response_bytes,
        allow_local_urls=ctx.deps.settings.web_allow_http,
        timeout=max(1, ctx.deps.settings.web_fetch_timeout_ms // 1000),
        max_download_bytes=ctx.deps.settings.web_max_response_bytes,
        allowed_domains=ctx.deps.settings.web_domain_allowlist or None,
        blocked_domains=ctx.deps.settings.web_domain_blocklist or None,
    )
    result = await tool.function(args.url)
    if hasattr(result, "model_dump"):
        payload = result.model_dump()
    elif isinstance(result, dict):
        payload = dict(result)
    else:
        payload = {
            key: getattr(result, key)
            for key in ("url", "title", "content", "media_type", "identifier")
            if hasattr(result, key)
        }
    return json_dumps(payload)
