"""Structured logging with redaction.

Never log a connection string, a token or an Authorization header. The
redaction list below is the mechanism, so nobody has to remember at each call
site.
"""

from __future__ import annotations

import logging
import re
import sys

import structlog

# Anything matching these gets masked before it reaches an output stream.
_REDACT_PATTERNS = [
    re.compile(r"(postgres(?:ql)?://[^:]+:)([^@]+)(@)", re.I),
    re.compile(r"(password\s*=\s*)(\S+)", re.I),
    re.compile(r"(Bearer\s+)([A-Za-z0-9._\-]+)", re.I),
    re.compile(r"(api[_-]?key[\"']?\s*[:=]\s*[\"']?)([^\s\"',]+)", re.I),
]


def _redact(_logger, _name, event_dict):
    for key, value in list(event_dict.items()):
        if not isinstance(value, str):
            continue
        for pattern in _REDACT_PATTERNS:
            value = pattern.sub(r"\1***\3" if pattern.groups >= 3 else r"\1***", value)
        event_dict[key] = value
    return event_dict


def configure_logging(level: str = "info") -> None:
    logging.basicConfig(
        format="%(message)s",
        stream=sys.stdout,
        level=getattr(logging, level.upper(), logging.INFO),
    )

    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso"),
            _redact,
            structlog.processors.StackInfoRenderer(),
            structlog.processors.format_exc_info,
            structlog.dev.ConsoleRenderer(colors=False),
        ],
        wrapper_class=structlog.make_filtering_bound_logger(
            getattr(logging, level.upper(), logging.INFO)
        ),
        cache_logger_on_first_use=True,
    )


logger = structlog.get_logger("cbd")
