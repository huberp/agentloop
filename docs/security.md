# Security

Agentloop enforces policy before tool execution.

- `safe_path()` blocks path traversal outside the workspace root.
- `detect_shell_injection()` rejects suspicious shell metacharacters.
- `PermissionManager` enforces allowlists, blocklists, and approval rules.
- `ConcurrencyLimiter` caps simultaneous tool execution.
- `web_fetch` can restrict allowed or blocked domains.
