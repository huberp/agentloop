from __future__ import annotations

import base64

from pydantic import BaseModel
from pydantic_ai import RunContext

from agentloop.agent import AgentDeps
from agentloop.tools._common import detect_text_encoding, ensure_file_size, json_dumps, resolve_workspace_path
from agentloop.tools.registry import tool_def


class FileReadInput(BaseModel):
    path: str
    start_line: int | None = None
    end_line: int | None = None
    encoding: str | None = None


@tool_def(name="file_read", description="Read a file from the workspace", permissions="safe")
async def file_read(ctx: RunContext[AgentDeps], args: FileReadInput) -> str:
    path = resolve_workspace_path(ctx.deps, args.path)
    size = ensure_file_size(path, ctx.deps.settings)
    data = path.read_bytes()
    encoding = args.encoding or detect_text_encoding(data)
    if encoding == "base64":
        content = base64.b64encode(data).decode("ascii")
    else:
        content = data.decode("utf-8")
        if args.start_line is not None or args.end_line is not None:
            lines = content.splitlines()
            start = max((args.start_line or 1) - 1, 0)
            end = args.end_line if args.end_line is not None else len(lines)
            content = "\n".join(lines[start:end])
    return json_dumps({"path": args.path, "content": content, "encoding": encoding, "size_bytes": size})
