from __future__ import annotations

from typing import Any

from pydantic import BaseModel
from pydantic_ai import RunContext
from pydantic_ai.common_tools.duckduckgo import duckduckgo_search_tool

from agentloop.agent import AgentDeps
from agentloop.tools._common import json_dumps
from agentloop.tools.registry import tool_def


class WebSearchInput(BaseModel):
    query: str
    max_results: int | None = None


@tool_def(name="web_search", description="Search the web using DuckDuckGo", permissions="safe")
async def web_search(ctx: RunContext[AgentDeps], args: WebSearchInput) -> str:
    tool = duckduckgo_search_tool(max_results=args.max_results or ctx.deps.settings.duckduckgo_max_results)
    results = await tool.function(args.query)
    normalized = [{"title": item.get("title"), "link": item.get("href"), "snippet": item.get("body")} for item in results]
    return json_dumps(normalized)
