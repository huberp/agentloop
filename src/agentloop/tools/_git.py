from __future__ import annotations

from pathlib import Path

from git import Repo

from agentloop.agent import AgentDeps
from agentloop.tools._common import resolve_workspace_path


def get_repo(deps: AgentDeps, cwd: str | None = None) -> Repo:
    base = resolve_workspace_path(deps, cwd or ".")
    return Repo(Path(base), search_parent_directories=True)
