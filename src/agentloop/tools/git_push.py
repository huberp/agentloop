from __future__ import annotations

from pydantic import BaseModel
from pydantic_ai import RunContext

from agentloop.agent import AgentDeps
from agentloop.tools._common import json_dumps
from agentloop.tools._git import get_repo
from agentloop.tools.registry import tool_def


class GitPushInput(BaseModel):
    cwd: str | None = None
    remote: str = "origin"
    branch: str | None = None


@tool_def(name="git_push", description="Push commits to a git remote", permissions="dangerous")
async def git_push(ctx: RunContext[AgentDeps], args: GitPushInput) -> str:
    repo = get_repo(ctx.deps, args.cwd)
    branch = args.branch or repo.active_branch.name
    output = repo.git.push(args.remote, branch)
    return json_dumps({"remote": args.remote, "branch": branch, "output": output})
