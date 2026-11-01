from __future__ import annotations

import difflib

from pydantic import BaseModel
from pydantic_ai import RunContext

from agentloop.agent import AgentDeps
from agentloop.tools.registry import tool_def


class DiffInput(BaseModel):
    before: str
    after: str
    fromfile: str = "before"
    tofile: str = "after"


@tool_def(name="diff", description="Create a unified diff between two strings", permissions="safe")
async def diff(ctx: RunContext[AgentDeps], args: DiffInput) -> str:
    del ctx
    lines = difflib.unified_diff(
        args.before.splitlines(keepends=True),
        args.after.splitlines(keepends=True),
        fromfile=args.fromfile,
        tofile=args.tofile,
    )
    return "".join(lines)
