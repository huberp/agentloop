---
name: security-auditor
description: OWASP Top 10 checks, input validation, dependency auditing, secret detection
version: 1.0.0
slot: section
tools: shell
---

## Security Audit Guidelines

- **OWASP Top 10**: systematically check for injection (SQL, command, path traversal), broken access control, cryptographic failures, insecure design, and misconfigured security headers.
- **Input validation**: all user-supplied or LLM-supplied inputs must be validated at the system boundary; prefer allowlist over blocklist approaches.
- **Dependency freshness**: run `npm audit` or equivalent to identify known CVEs; flag any dependency more than 2 major versions behind its latest release.
- **Secret detection**: scan for hardcoded API keys, tokens, passwords, and private keys; use environment variables or secret managers for all credentials.
- **Path traversal prevention**: resolve all file paths under a trusted root using `path.resolve()` and reject paths that escape the root.
- **Least privilege**: tools and agents should request only the permissions they need; `shell` tool usage must be logged and ideally require confirmation.
