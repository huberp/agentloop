from __future__ import annotations

from pydantic import BaseModel
from pydantic_ai import RunContext

from agentloop.agent import AgentDeps
from agentloop.tools._common import json_dumps
from agentloop.tools._git import get_repo
from agentloop.tools.registry import tool_def


class GitBranchInput(BaseModel):
    cwd: str | None = None
    create: str | None = None
    delete: str | None = None


@tool_def(name="git_branch", description="List, create, or delete git branches", permissions="cautious")
async def git_branch(ctx: RunContext[AgentDeps], args: GitBranchInput) -> str:
    repo = get_repo(ctx.deps, args.cwd)
    if args.create:
        repo.git.branch(args.create)
    if args.delete:
        repo.git.branch("-D", args.delete)
    return json_dumps({"current": repo.active_branch.name, "branches": [head.name for head in repo.heads]})
