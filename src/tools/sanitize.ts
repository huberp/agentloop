/**
 * Input sanitization utilities shared by tool implementations.
 *
 * All LLM-generated inputs are treated as potentially malicious (Task 4.3).
 */

/**
 * Shell metacharacter patterns that indicate an injection attempt.
 *
 * The shell tool uses execFile (no shell spawned), so these characters are
 * not actually interpreted — but their presence signals that the caller
 * expects shell behaviour and may be trying to inject commands.
 */
const SHELL_INJECTION_PATTERNS: RegExp[] = [
  /;/,        // command separator
  /&&/,       // AND-conditional execution
  /\|\|/,     // OR-conditional execution
  /\|/,       // pipe
  /`/,        // backtick substitution
  /\$\(/,     // $( ) command substitution
  /\n/,       // newline as command separator
  /\r/,       // carriage return as command separator
  />/,        // stdout redirection (interpreted by cmd.exe on Windows)
  /</,        // stdin redirection (interpreted by cmd.exe on Windows)
];

/**
 * Returns true when `command` contains shell metacharacters that suggest an
 * injection attempt.  Call this before executing any shell-style command.
 */
export function detectShellInjection(command: string): boolean {
  return SHELL_INJECTION_PATTERNS.some((pattern) => pattern.test(command));
}

/**
 * Truncate a string to at most `maxBytes` UTF-8 bytes, appending a notice
 * when truncation occurs.  Used to cap shell stdout/stderr output size.
 */
export function truncateOutput(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf-8");
  if (buf.byteLength <= maxBytes) return text;
  const notice = `\n[Output truncated: exceeded ${maxBytes} bytes]`;
  const noticeBuf = Buffer.from(notice, "utf-8");
  // Slice to maxBytes minus the notice, then append the notice
  const truncated = buf.slice(0, maxBytes - noticeBuf.byteLength).toString("utf-8");
  return truncated + notice;
}
