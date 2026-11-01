from __future__ import annotations

import asyncio
import os
import shlex

from pydantic import BaseModel, Field
from pydantic_ai import RunContext

from agentloop.agent import AgentDeps
from agentloop.tools._common import json_dumps, resolve_workspace_path
from agentloop.tools.registry import tool_def
from agentloop.tools.sanitize import truncate_output


class CodeRunInput(BaseModel):
    command: str
    cwd: str | None = None
    timeout_ms: int | None = None
    env: dict[str, str] = Field(default_factory=dict)


@tool_def(name="code_run", description="Run a program without shell expansion", permissions="cautious")
async def code_run(ctx: RunContext[AgentDeps], args: CodeRunInput) -> str:
    cwd = resolve_workspace_path(ctx.deps, args.cwd or ".")
    proc = await asyncio.create_subprocess_exec(
        *shlex.split(args.command),
        cwd=str(cwd),
        env={**os.environ, **args.env},
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    timeout = (args.timeout_ms or ctx.deps.settings.tool_timeout_ms) / 1000
    try:
        stdout_b, stderr_b = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except TimeoutError:
        proc.kill()
        await proc.communicate()
        return json_dumps({"stdout": "", "stderr": f"Command timed out after {int(timeout * 1000)}ms", "exit_code": -1})
    limit = ctx.deps.settings.max_shell_output_bytes
    return json_dumps({
        "stdout": truncate_output(stdout_b.decode(errors="ignore"), limit),
        "stderr": truncate_output(stderr_b.decode(errors="ignore"), limit),
        "exit_code": proc.returncode,
    })
