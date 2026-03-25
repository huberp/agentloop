# Security Model

This document describes the security threat model and mitigations implemented in AgentLoop (Task 4.3).

## Threat Model

AgentLoop executes LLM-generated tool calls. Because the model may produce
malicious or erroneous inputs — whether due to prompt injection, adversarial
instructions in retrieved documents, or simple hallucination — **all
LLM-generated tool arguments must be treated as untrusted**.

The primary attack vectors are:

| Threat | Affected tools | Mitigation |
|---|---|---|
| Path traversal (`../../etc/passwd`) | All file tools, shell cwd | `resolveSafe` — resolves path and rejects escapes |
| Shell injection (`;`, `&&`, `\|`, `` ` ``, `$()`) | `shell`, `code_run` | `detectShellInjection` — blocks metacharacters before exec |
| Resource exhaustion (huge files, unbounded output) | `file-read`, `file-write`, `shell` | `MAX_FILE_SIZE_BYTES`, `MAX_SHELL_OUTPUT_BYTES` limits |
| Concurrency-based exhaustion (too many parallel tools) | all tools | `ConcurrencyLimiter` semaphore |
| Unauthorised network access | future HTTP/fetch tools | `checkNetworkAccess` domain allowlist |
| Dangerous tool execution | all tools | `ToolPermissionManager` blocklist/allowlist/confirmation |

---

## Mitigations in Detail

### 1. Workspace Isolation (Path Traversal Prevention)

All file operations (`file-read`, `file-write`, `file-edit`, `file-delete`,
`file-list`) and the working-directory (`cwd`) parameter of `shell` and
`code_run` are resolved through `resolveSafe` (`src/tools/file-utils.ts`).

`resolveSafe` calls `path.resolve()` and then asserts that the result lies
**inside** `WORKSPACE_ROOT`.  Any path that resolves outside the root — including
`../../etc/passwd`, absolute paths, or symlink tricks — raises an error before
any filesystem operation is attempted.

**Configuration:** `WORKSPACE_ROOT` (default: `process.cwd()`).

### 2. Shell Injection Detection

The `shell` tool uses `execFile` (not `exec`), which never spawns a system
shell, so shell metacharacters in the command string are not interpreted by the
OS.  Despite this, the presence of metacharacters (`;`, `&&`, `||`, `|`,
`` ` ``, `$(`, `\n`, `\r`) in the command string is treated as a strong signal
of injection intent and the command is **rejected before execution**.

This is implemented in `detectShellInjection` (`src/tools/sanitize.ts`) and
called by the `shell` tool's `execute` function.

**Why reject even safe metacharacters?**  The tool's documented contract is
that it runs a single executable with arguments split by whitespace.  Any
metacharacter indicates the caller is trying to use shell features that the
tool intentionally does not support.

### 3. Resource Limits

#### File size (`MAX_FILE_SIZE_BYTES`, default 10 MB)

`file-read` checks `stat.size` **before** reading the file and raises if the
size exceeds the limit.  `file-write` computes the byte length of the decoded
content buffer **before** writing.

This prevents the agent from reading enormous files into memory (denial of
service) or writing unbounded output to disk.

#### Shell output (`MAX_SHELL_OUTPUT_BYTES`, default 1 MB)

The stdout and stderr of every `shell` command are passed through
`truncateOutput` (`src/tools/sanitize.ts`), which slices the UTF-8 byte
representation at `MAX_SHELL_OUTPUT_BYTES` and appends a notice.  This bounds
the size of the `ToolMessage` injected back into the LLM context.

#### Concurrent tool executions (`MAX_CONCURRENT_TOOLS`, default 10)

All tool invocations in both the standard and streaming agent loops pass through
a `ConcurrencyLimiter` semaphore (`src/security.ts`).  When the number of
active executions reaches `MAX_CONCURRENT_TOOLS`, additional invocations queue
and wait for a slot to become free.  Setting the value to `0` disables the
limit entirely.

### 4. Network Access Controls

`checkNetworkAccess(url, allowedDomains)` (`src/security.ts`) validates that the
hostname of a URL is permitted by the configured allowlist.  A hostname matches
if it is **exactly** in the list, or if it is a subdomain of a listed domain.

When `NETWORK_ALLOWED_DOMAINS` is empty (the default), all hosts are permitted.

This function must be called by any tool that makes outbound HTTP requests.
Currently no bundled tools make direct network requests; the control is in place
for future tools (e.g., `web-fetch`, `web-search`).

**Configuration:** `NETWORK_ALLOWED_DOMAINS` — comma-separated list of
permitted hostnames (e.g., `api.openai.com,docs.python.org`).

### 5. Tool Permission Manager

`ToolPermissionManager` (`src/security.ts`) enforces three layers of access
control before any tool is executed:

1. **Blocklist** — tools in `TOOL_BLOCKLIST` are always rejected.
2. **Allowlist** — when `TOOL_ALLOWLIST` is non-empty, only listed tools run.
3. **Permission level** — `"safe"` (auto-approved), `"cautious"` (auto-approved
   with audit log), `"dangerous"` (requires user confirmation unless
   `AUTO_APPROVE_ALL=true`).

---

## Configuration Reference

| Variable | Default | Description |
|---|---|---|
| `WORKSPACE_ROOT` | `process.cwd()` | Root directory for all file and shell operations |
| `MAX_FILE_SIZE_BYTES` | `10485760` (10 MB) | Maximum file size allowed for read/write |
| `MAX_SHELL_OUTPUT_BYTES` | `1048576` (1 MB) | Maximum shell stdout/stderr size |
| `MAX_CONCURRENT_TOOLS` | `10` | Max simultaneous tool executions (0 = unlimited) |
| `NETWORK_ALLOWED_DOMAINS` | *(empty — allow all)* | Comma-separated domain allowlist for network tools |
| `TOOL_ALLOWLIST` | *(empty — allow all)* | Comma-separated list of permitted tool names |
| `TOOL_BLOCKLIST` | *(empty)* | Comma-separated list of always-blocked tool names |
| `AUTO_APPROVE_ALL` | `false` | Skip confirmation prompts for dangerous tools |
| `SHELL_COMMAND_BLOCKLIST` | *(empty)* | Extra blocked command patterns for the shell tool |

---

## Security Test Suite

Dedicated security tests live in `src/__tests__/security-hardening.test.ts`
and cover:

- Path traversal attempts for `file-read` and `file-write`
- Shell injection metacharacter detection (`detectShellInjection`)
- Shell tool blocking injection attempts at execution time
- Shell `cwd` confinement to workspace root
- Shell output truncation (`truncateOutput`)
- File size limit enforcement for `file-read` and `file-write`
- Network domain allowlist enforcement (`checkNetworkAccess`)
- Concurrency limiter semantics (`ConcurrencyLimiter`)

Run with:

```bash
npx jest --testPathPatterns="security-hardening"
```
