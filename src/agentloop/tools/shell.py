from __future__ import annotations

import asyncio
import os
import shlex

from pydantic import BaseModel, Field
from pydantic_ai import RunContext

from agentloop.agent import AgentDeps
from agentloop.tools._common import json_dumps, resolve_workspace_path
from agentloop.tools.registry import tool_def
from agentloop.tools.sanitize import detect_shell_injection, truncate_output

DEFAULT_COMMAND_BLOCKLIST = (
    "rm -rf /",
    "rm -rf /*",
    "mkfs",
    "dd if=",
    ":(){:|:&};:",
    "chmod -R 777 /",
    "chmod 777 /",
)


class ShellInput(BaseModel):
    command: str
    cwd: str | None = None
    env: dict[str, str] = Field(default_factory=dict)
    timeout: int | None = None


@tool_def(name="shell", description="Execute a shell command safely", permissions="dangerous")
async def shell(ctx: RunContext[AgentDeps], args: ShellInput) -> str:
    command = " ".join(args.command.strip().split())
    if not command:
        return json_dumps({"stdout": "", "stderr": "No command provided", "exit_code": -1})
    if any(pattern in command for pattern in (*DEFAULT_COMMAND_BLOCKLIST, *ctx.deps.settings.shell_command_blocklist)):
        return json_dumps({"stdout": "", "stderr": f'Command blocked by blocklist: "{command}"', "exit_code": -1})
    if detect_shell_injection(command):
        return json_dumps({
            "stdout": "",
            "stderr": f'Command blocked: shell injection metacharacters detected in "{command}"',
            "exit_code": -1,
        })
    cwd = resolve_workspace_path(ctx.deps, args.cwd or ".")
    proc = await asyncio.create_subprocess_exec(
        *shlex.split(command),
        cwd=str(cwd),
        env={**os.environ, **args.env},
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    timeout = (args.timeout or ctx.deps.settings.tool_timeout_ms) / 1000
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
