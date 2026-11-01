from __future__ import annotations

from pydantic import BaseModel
from pydantic_ai import RunContext

from agentloop.agent import AgentDeps
from agentloop.tools._common import json_dumps
from agentloop.tools._git import get_repo
from agentloop.tools.registry import tool_def


class GitStatusInput(BaseModel):
    cwd: str | None = None


@tool_def(name="git_status", description="Show git status for the workspace", permissions="safe")
async def git_status(ctx: RunContext[AgentDeps], args: GitStatusInput) -> str:
    repo = get_repo(ctx.deps, args.cwd)
    data = []
    for item in repo.index.diff(None):
        data.append({"status": item.change_type, "path": item.a_path or item.b_path})
    for path in repo.untracked_files:
        data.append({"status": "??", "path": path})
    return json_dumps({"entries": data, "is_clean": not data})
