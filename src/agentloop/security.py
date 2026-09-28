from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any, Literal
from urllib.parse import urlparse

from agentloop.config import Settings
from agentloop.tools.sanitize import detect_shell_injection

Decision = Literal["allow", "block", "confirm"]


class PermissionManager:
    def __init__(self, settings: Settings, *, interactive: bool = False) -> None:
        self.settings = settings
        self.interactive = interactive

    def check(
        self,
        tool_name: str,
        args: dict[str, Any],
        *,
        permissions: str = "safe",
    ) -> Decision:
        if tool_name in self.settings.tool_blocklist:
            return "block"
        if self.settings.tool_allowlist and tool_name not in self.settings.tool_allowlist:
            return "block"
        if self._has_shell_injection(args):
            return "block"
        if self.settings.auto_approve_all:
            return "allow"
        if permissions == "safe":
            return "allow"
        return "confirm" if self.interactive else "block"

    def check_network_access(self, url: str) -> None:
        allowed = self.settings.network_allowed_domains
        if not allowed:
            return
        hostname = urlparse(url).hostname or ""
        if any(hostname == domain or hostname.endswith(f".{domain}") for domain in allowed):
            return
        raise ValueError(f'Network access to "{hostname}" is blocked')

    def _has_shell_injection(self, value: Any) -> bool:
        if isinstance(value, str):
            return detect_shell_injection(value)
        if isinstance(value, dict):
            return any(self._has_shell_injection(item) for item in value.values())
        if isinstance(value, (list, tuple, set)):
            return any(self._has_shell_injection(item) for item in value)
        return False


class ConcurrencyLimiter:
    def __init__(self, max_concurrent: int) -> None:
        self._sem = asyncio.Semaphore(max_concurrent) if max_concurrent > 0 else None
        self._active_count = 0

    @property
    def active_count(self) -> int:
        return self._active_count

    @asynccontextmanager
    async def acquire(self) -> AsyncIterator[None]:
        if self._sem is None:
            yield
            return
        async with self._sem:
            self._active_count += 1
            try:
                yield
            finally:
                self._active_count -= 1
