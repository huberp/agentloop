from __future__ import annotations

import subprocess

from pydantic import BaseModel
from pydantic_ai import RunContext

from agentloop.agent import AgentDeps
from agentloop.tools._common import json_dumps, resolve_workspace_path
from agentloop.tools.registry import tool_def


class PatchInput(BaseModel):
    patch_text: str
    cwd: str = "."
    strip: int = 0


@tool_def(name="patch", description="Apply a unified diff patch in the workspace", permissions="dangerous")
async def patch(ctx: RunContext[AgentDeps], args: PatchInput) -> str:
    cwd = resolve_workspace_path(ctx.deps, args.cwd)
    commands = [["patch", f"-p{args.strip}"], ["git", "apply", "--whitespace=nowarn", "-"]]
    last_error = ""
    for command in commands:
        try:
            proc = subprocess.run(command, cwd=str(cwd), input=args.patch_text, text=True, capture_output=True, check=False)
        except FileNotFoundError:
            continue
        if proc.returncode == 0:
            return json_dumps({"success": True, "stdout": proc.stdout, "stderr": proc.stderr})
        last_error = proc.stderr or proc.stdout
    return json_dumps({"success": False, "error": last_error or "No patch command available"})
