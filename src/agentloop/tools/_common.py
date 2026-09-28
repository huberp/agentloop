from __future__ import annotations

import asyncio
import json
import shutil
import subprocess
from pathlib import Path
from typing import Any

from agentloop.agent import AgentDeps
from agentloop.config import Settings
from agentloop.errors import ToolExecutionError
from agentloop.tools.sanitize import safe_path

DEFAULT_EXCLUDE_DIRS = {
    ".git",
    ".venv",
    "__pycache__",
    "node_modules",
    "dist",
    "build",
    "target",
    "coverage",
}


async def run_with_timeout(coro: Any, timeout_ms: int) -> Any:
    try:
        return await asyncio.wait_for(coro, timeout=timeout_ms / 1000)
    except TimeoutError as exc:
        raise ToolExecutionError(f"Tool timed out after {timeout_ms}ms") from exc


def resolve_workspace_path(deps: AgentDeps, path: str) -> Path:
    return safe_path(deps.workspace_root, path)


def ensure_file_size(path: Path, settings: Settings) -> int:
    size = path.stat().st_size
    if size > settings.max_file_size_bytes:
        raise ToolExecutionError(
            f'File "{path}" is {size} bytes which exceeds {settings.max_file_size_bytes} bytes'
        )
    return size


def detect_text_encoding(data: bytes) -> str:
    try:
        data.decode("utf-8")
    except UnicodeDecodeError:
        return "base64"
    return "utf-8"


def json_dumps(payload: Any) -> str:
    return json.dumps(payload, ensure_ascii=False)


def command_exists(name: str) -> bool:
    return shutil.which(name) is not None


def run_sync(command: list[str], *, cwd: Path | None = None, input_text: str | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        cwd=str(cwd) if cwd else None,
        input=input_text,
        text=True,
        capture_output=True,
        check=False,
    )
