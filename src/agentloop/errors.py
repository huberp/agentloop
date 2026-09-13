class LLMAPIError(RuntimeError):
    """Raised when the configured LLM provider call fails."""


class ToolExecutionError(RuntimeError):
    """Raised when a tool fails during execution."""


class ToolBlockedError(RuntimeError):
    """Raised when policy prevents a tool from running."""
