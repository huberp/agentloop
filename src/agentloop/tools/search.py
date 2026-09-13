from __future__ import annotations

from pydantic import BaseModel
from pydantic_ai import RunContext

from agentloop.agent import AgentDeps
from agentloop.tools.registry import tool_def
from agentloop.tools.web_search import WebSearchInput, web_search


class SearchInput(BaseModel):
    query: str
    max_results: int | None = None


@tool_def(name="search", description="Alias for web_search", permissions="safe")
async def search(ctx: RunContext[AgentDeps], args: SearchInput) -> str:
    return await web_search(ctx, WebSearchInput(query=args.query, max_results=args.max_results))
