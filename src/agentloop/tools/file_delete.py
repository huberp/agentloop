from __future__ import annotations

import shutil

from pydantic import BaseModel
from pydantic_ai import RunContext

from agentloop.agent import AgentDeps
from agentloop.tools._common import json_dumps, resolve_workspace_path
from agentloop.tools.registry import tool_def


class FileDeleteInput(BaseModel):
    path: str
    missing_ok: bool = True


def _mutates(args: dict[str, object]) -> str | None:
    path = args.get("path")
    return str(path) if path is not None else None


@tool_def(
    name="file_delete",
    description="Delete a file or directory from the workspace",
    permissions="dangerous",
    mutates_file=_mutates,
)
async def file_delete(ctx: RunContext[AgentDeps], args: FileDeleteInput) -> str:
    path = resolve_workspace_path(ctx.deps, args.path)
    if not path.exists():
        return json_dumps({"success": args.missing_ok, "path": args.path})
    if path.is_dir():
        shutil.rmtree(path)
    else:
        path.unlink()
    return json_dumps({"success": True, "path": args.path})
