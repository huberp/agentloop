from __future__ import annotations

import logging
import sys
from typing import Any

import structlog

from agentloop.config import settings


def _configure_logging() -> None:
    target = sys.stdout if settings.log_destination == "stdout" else sys.stderr
    logging.basicConfig(level=getattr(logging, settings.log_level.upper(), logging.INFO), stream=target)
    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso"),
            structlog.processors.JSONRenderer(),
        ],
        wrapper_class=structlog.make_filtering_bound_logger(
            getattr(logging, settings.log_level.upper(), logging.INFO)
        ),
        logger_factory=structlog.PrintLoggerFactory(file=target),
        cache_logger_on_first_use=True,
    )


_configure_logging()


def get_logger(name: str | None = None) -> structlog.stdlib.BoundLogger:
    return structlog.get_logger(name or "agentloop")
