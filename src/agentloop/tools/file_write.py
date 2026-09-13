from __future__ import annotations

import base64

from pydantic import BaseModel
from pydantic_ai import RunContext

from agentloop.agent import AgentDeps
from agentloop.errors import ToolExecutionError
from agentloop.tools._common import json_dumps, resolve_workspace_path
from agentloop.tools.registry import tool_def


class FileWriteInput(BaseModel):
    path: str
    content: str
    encoding: str = "utf-8"
    append: bool = False


def _mutates(args: dict[str, object]) -> str | None:
    path = args.get("path")
    return str(path) if path is not None else None


@tool_def(
    name="file_write",
    description="Create or overwrite a file in the workspace",
    permissions="cautious",
    mutates_file=_mutates,
)
async def file_write(ctx: RunContext[AgentDeps], args: FileWriteInput) -> str:
    path = resolve_workspace_path(ctx.deps, args.path)
    data = args.content.encode("utf-8") if args.encoding == "utf-8" else base64.b64decode(args.content)
    if len(data) > ctx.deps.settings.max_file_size_bytes:
        raise ToolExecutionError(
            f"Content exceeds maximum file size of {ctx.deps.settings.max_file_size_bytes} bytes"
        )
    path.parent.mkdir(parents=True, exist_ok=True)
    mode = "ab" if args.append else "wb"
    with path.open(mode) as handle:
        handle.write(data)
    return json_dumps({"success": True, "path": args.path, "bytes_written": len(data)})
