from __future__ import annotations

import fnmatch

from pydantic import BaseModel, Field
from pydantic_ai import RunContext

from agentloop.agent import AgentDeps
from agentloop.tools._common import DEFAULT_EXCLUDE_DIRS, json_dumps, resolve_workspace_path
from agentloop.tools.registry import tool_def


class FileListInput(BaseModel):
    path: str = "."
    glob: str | None = None
    recursive: bool = False
    exclude: list[str] = Field(default_factory=list)


@tool_def(name="file_list", description="List files in the workspace", permissions="safe")
async def file_list(ctx: RunContext[AgentDeps], args: FileListInput) -> str:
    base = resolve_workspace_path(ctx.deps, args.path)
    excluded = DEFAULT_EXCLUDE_DIRS | set(args.exclude)
    pattern = args.glob
    entries: list[dict[str, object]] = []
    iterator = base.rglob("*") if args.recursive else base.iterdir()
    for item in iterator:
        rel = item.relative_to(base).as_posix()
        if any(part in excluded for part in item.parts):
            continue
        if pattern and not fnmatch.fnmatch(rel, pattern):
            continue
        payload: dict[str, object] = {"path": rel, "type": "directory" if item.is_dir() else "file"}
        if item.is_file():
            payload["size_bytes"] = item.stat().st_size
        entries.append(payload)
    return json_dumps({"entries": entries})
