from __future__ import annotations

from pydantic import BaseModel
from pydantic_ai import RunContext

from agentloop.agent import AgentDeps
from agentloop.tools._git import get_repo
from agentloop.tools.registry import tool_def


class GitDiffInput(BaseModel):
    cwd: str | None = None
    ref: str = "HEAD"
    staged: bool = False


@tool_def(name="git_diff", description="Show git diff for working tree or index", permissions="safe")
async def git_diff(ctx: RunContext[AgentDeps], args: GitDiffInput) -> str:
    repo = get_repo(ctx.deps, args.cwd)
    if args.staged:
        return repo.git.diff("--cached", args.ref)
    return repo.git.diff(args.ref)
