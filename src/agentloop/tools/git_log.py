from __future__ import annotations

from pydantic import BaseModel
from pydantic_ai import RunContext

from agentloop.agent import AgentDeps
from agentloop.tools._common import json_dumps
from agentloop.tools._git import get_repo
from agentloop.tools.registry import tool_def


class GitLogInput(BaseModel):
    cwd: str | None = None
    max_count: int = 10
    ref: str = "HEAD"


@tool_def(name="git_log", description="Show recent git commits", permissions="safe")
async def git_log(ctx: RunContext[AgentDeps], args: GitLogInput) -> str:
    repo = get_repo(ctx.deps, args.cwd)
    commits = [
        {
            "hexsha": commit.hexsha,
            "summary": commit.summary,
            "author": commit.author.name,
            "committed_datetime": commit.committed_datetime.isoformat(),
        }
        for commit in repo.iter_commits(args.ref, max_count=args.max_count)
    ]
    return json_dumps({"commits": commits})
