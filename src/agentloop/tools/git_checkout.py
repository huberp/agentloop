from __future__ import annotations

from pydantic import BaseModel
from pydantic_ai import RunContext

from agentloop.agent import AgentDeps
from agentloop.tools._common import json_dumps
from agentloop.tools._git import get_repo
from agentloop.tools.registry import tool_def


class GitCheckoutInput(BaseModel):
    ref: str
    cwd: str | None = None
    create: bool = False


@tool_def(name="git_checkout", description="Checkout a git branch or ref", permissions="dangerous")
async def git_checkout(ctx: RunContext[AgentDeps], args: GitCheckoutInput) -> str:
    repo = get_repo(ctx.deps, args.cwd)
    if args.create:
        repo.git.checkout("-b", args.ref)
    else:
        repo.git.checkout(args.ref)
    return json_dumps({"current": repo.active_branch.name})
