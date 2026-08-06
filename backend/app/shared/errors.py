"""Typed errors and the single response envelope.

Every failure the client sees has the same shape:

    {"error": {"code": "...", "message": "...", "requestId": "..."}}

Codes are defined here, not invented at a call site. See
.claude/skills/api-contracts/SKILL.md.
"""

from __future__ import annotations

from typing import Any


class AppError(Exception):
    """Base for anything we deliberately return to a caller."""

    code = "INTERNAL"
    status = 500

    def __init__(self, message: str, *, detail: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.detail = detail or {}

    def envelope(self, request_id: str) -> dict:
        body: dict[str, Any] = {
            "error": {
                "code": self.code,
                "message": self.message,
                "requestId": request_id,
            }
        }
        if self.detail:
            body["error"]["detail"] = self.detail
        return body


class ValidationFailed(AppError):
    code = "VALIDATION_FAILED"
    status = 400


class DistrictNotFound(AppError):
    code = "DISTRICT_NOT_FOUND"
    status = 404

    def __init__(self, name: str, suggestions: list[str] | None = None) -> None:
        hint = ""
        if suggestions:
            hint = f' Did you mean {" or ".join(repr(s) for s in suggestions[:3])}?'
        super().__init__(
            f"No district named {name!r}.{hint}",
            detail={"suggestions": suggestions or []},
        )


class LeadUnavailable(AppError):
    code = "LEAD_UNAVAILABLE"
    status = 404

    def __init__(self, lead: int, available: list[int] | None = None) -> None:
        super().__init__(
            f"Forecast hour {lead} was not published for this cycle.",
            detail={"available": available or []},
        )


class NotConfigured(AppError):
    """An upstream env var is blank.

    Returned instead of guessing a URL or fabricating data. Data sources are
    being supplied incrementally, so an honest gap is more useful than a
    plausible fake.
    """

    code = "NOT_CONFIGURED"
    status = 501

    def __init__(self, setting: str, what: str) -> None:
        super().__init__(
            f"{setting} is not set, so {what} is unavailable.",
            detail={"setting": setting},
        )


class UpstreamError(AppError):
    code = "UPSTREAM_ERROR"
    status = 502


class UpstreamTimeout(AppError):
    code = "UPSTREAM_TIMEOUT"
    status = 504


class Busy(AppError):
    """Concurrency limit reached. Better than queueing without bound and
    letting every request time out together."""

    code = "BUSY"
    status = 503

    def __init__(self, retry_after_s: int = 10) -> None:
        super().__init__(
            "The service is at its concurrency limit, please retry.",
            detail={"retryAfter": retry_after_s},
        )
