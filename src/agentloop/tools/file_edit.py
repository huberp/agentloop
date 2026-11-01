from __future__ import annotations

from pydantic import BaseModel
from pydantic_ai import RunContext

from agentloop.agent import AgentDeps
from agentloop.errors import ToolExecutionError
from agentloop.tools._common import json_dumps, resolve_workspace_path
from agentloop.tools.registry import tool_def


class FileEditInput(BaseModel):
    path: str
    search: str | None = None
    replace: str | None = None
    start_line: int | None = None
    end_line: int | None = None
    new_content: str | None = None


def _mutates(args: dict[str, object]) -> str | None:
    path = args.get("path")
    return str(path) if path is not None else None


@tool_def(
    name="file_edit",
    description="Edit a file by search/replace or line range replacement",
    permissions="cautious",
    mutates_file=_mutates,
)
async def file_edit(ctx: RunContext[AgentDeps], args: FileEditInput) -> str:
    path = resolve_workspace_path(ctx.deps, args.path)
    original = path.read_text()
    if args.search is not None and args.replace is not None:
        if not args.search:
            raise ToolExecutionError("Search string must not be empty")
        if args.search not in original:
            raise ToolExecutionError(f'Search string not found in "{args.path}"')
        updated = original.replace(args.search, args.replace, 1)
    elif args.start_line is not None and args.end_line is not None and args.new_content is not None:
        lines = original.splitlines()
        start = args.start_line - 1
        end = args.end_line
        if start < 0 or end > len(lines):
            raise ToolExecutionError(
                f"Line range {args.start_line}-{args.end_line} is out of bounds for {args.path}"
            )
        lines[start:end] = args.new_content.splitlines()
        updated = "\n".join(lines)
    else:
        raise ToolExecutionError(
            "Provide either search+replace or start_line+end_line+new_content"
        )
    path.write_text(updated)
    return json_dumps({"success": True, "path": args.path})
