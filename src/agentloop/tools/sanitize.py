from __future__ import annotations

import re
from pathlib import Path

from agentloop.errors import ToolExecutionError

SHELL_INJECTION_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r";"),
    re.compile(r"&&"),
    re.compile(r"\|\|"),
    re.compile(r"\|"),
    re.compile(r"`"),
    re.compile(r"\$\("),
    re.compile(r"[\r\n]"),
    re.compile(r">"),
    re.compile(r"<"),
)


def safe_path(workspace_root: Path, requested: str) -> Path:
    root = workspace_root.resolve()
    candidate = Path(requested)
    resolved = candidate.resolve() if candidate.is_absolute() else (root / candidate).resolve()
    if root != resolved and root not in resolved.parents:
        raise ToolExecutionError(f"Path traversal detected: {requested}")
    return resolved


def detect_shell_injection(command: str) -> bool:
    return any(pattern.search(command) for pattern in SHELL_INJECTION_PATTERNS)


def truncate_output(text: str, max_bytes: int) -> str:
    data = text.encode("utf-8")
    if len(data) <= max_bytes:
        return text
    notice = f"\n[Output truncated: exceeded {max_bytes} bytes]".encode("utf-8")
    kept = max(0, max_bytes - len(notice))
    return data[:kept].decode("utf-8", errors="ignore") + notice.decode("utf-8")
