from __future__ import annotations

from pydantic import BaseModel
from pydantic_ai import RunContext

from agentloop.agent import AgentDeps
from agentloop.tools._common import json_dumps
from agentloop.tools._git import get_repo
from agentloop.tools.registry import tool_def


class GitCommitInput(BaseModel):
    message: str
    cwd: str | None = None
    add_all: bool = True


@tool_def(name="git_commit", description="Create a git commit", permissions="dangerous")
async def git_commit(ctx: RunContext[AgentDeps], args: GitCommitInput) -> str:
    repo = get_repo(ctx.deps, args.cwd)
    if args.add_all:
        repo.git.add(A=True)
    commit = repo.index.commit(args.message)
    return json_dumps({"hexsha": commit.hexsha, "summary": commit.summary})
