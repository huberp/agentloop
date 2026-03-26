import { z } from "zod";
import { execFile } from "child_process";
import type { ToolDefinition } from "./registry";
import { appConfig } from "../config";
import { resolveSafe } from "./file-utils";
import { detectShellInjection, truncateOutput } from "./sanitize";

/** Built-in blocked command patterns checked against the full command string before execution. */
const DEFAULT_COMMAND_BLOCKLIST = [
  "rm -rf /",
  "rm -rf /*",
  "mkfs",
  "dd if=",
  ":(){:|:&};:", // fork bomb
  "chmod -R 777 /",
  "chmod 777 /",
];

const schema = z.object({
  command: z.string().describe("Shell command to execute (split by whitespace; no shell expansion)"),
  cwd: z.string().optional().describe("Working directory (defaults to process.cwd())"),
  env: z.record(z.string()).optional().describe("Extra environment variables merged into the process environment"),
  timeout: z.number().optional().describe("Timeout in milliseconds (overrides TOOL_TIMEOUT_MS)"),
});

/** Structured result returned by the shell tool, serialised as JSON. */
interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Returns true if the command matches any pattern in the blocklist. */
function isBlocked(command: string, blocklist: string[]): boolean {
  const normalized = command.trim().replace(/\s+/g, " ");
  return blocklist.some((pattern) => normalized.includes(pattern));
}

export const toolDefinition: ToolDefinition = {
  name: "shell",
  description:
    "Execute a shell command via execFile (no shell injection risk). Returns stdout, stderr, and exit code as JSON. " +
    "The command string is split by whitespace to derive the executable and its arguments; " +
    "arguments that contain spaces are not supported through this field.",
  schema,
  permissions: "dangerous",
  execute: async ({
    command,
    cwd,
    env,
    timeout,
  }: {
    command: string;
    cwd?: string;
    env?: Record<string, string>;
    timeout?: number;
  }): Promise<string> => {
    // Merge built-in defaults with any user-configured blocked patterns
    const blocklist = [...DEFAULT_COMMAND_BLOCKLIST, ...appConfig.shellCommandBlocklist];

    if (isBlocked(command, blocklist)) {
      const result: ShellResult = {
        stdout: "",
        stderr: `Command blocked by blocklist: "${command}"`,
        exitCode: -1,
      };
      return JSON.stringify(result);
    }

    // Reject commands that contain shell injection metacharacters
    if (detectShellInjection(command)) {
      const result: ShellResult = {
        stdout: "",
        stderr: `Command blocked: shell injection metacharacters detected in "${command}"`,
        exitCode: -1,
      };
      return JSON.stringify(result);
    }

    if (!command.trim()) {
      return JSON.stringify({ stdout: "", stderr: "No command provided", exitCode: -1 } as ShellResult);
    }

    // Confine the working directory to the workspace root (path traversal prevention)
    let effectiveCwd: string;
    if (cwd) {
      try {
        effectiveCwd = resolveSafe(appConfig.workspaceRoot, cwd);
      } catch {
        return JSON.stringify({
          stdout: "",
          stderr: `Working directory "${cwd}" is outside the workspace root`,
          exitCode: -1,
        } as ShellResult);
      }
    } else {
      effectiveCwd = process.cwd();
    }

    const effectiveTimeout = timeout ?? appConfig.toolTimeoutMs;
    const isWindows = process.platform === "win32";

    // On Windows dispatch through cmd.exe so shell built-ins work.
    // On POSIX split by whitespace and pass directly to execFile (no shell spawned).
    const [executable, args]: [string, string[]] = isWindows
      ? ["cmd.exe", ["/c", command.trim()]]
      : (() => { const [exe, ...rest] = command.trim().split(/\s+/); return [exe, rest]; })()

    return new Promise<string>((resolve) => {
      execFile(
        executable,
        args,
        {
          cwd: effectiveCwd,
          env: { ...process.env, ...env },
          timeout: effectiveTimeout,
        },
        (error, stdout, stderr) => {
          if (error?.killed) {
            // Process was killed by the timeout mechanism
            resolve(
              JSON.stringify({
                stdout: "",
                stderr: `Command timed out after ${effectiveTimeout}ms`,
                exitCode: -1,
              } as ShellResult)
            );
            return;
          }

          // error.code is the numeric exit code when the process exits non-zero
          const exitCode =
            error === null ? 0 : typeof error.code === "number" ? error.code : 1;

          // Cap stdout and stderr to MAX_SHELL_OUTPUT_BYTES each
          const cappedStdout = truncateOutput(stdout, appConfig.maxShellOutputBytes);
          const cappedStderr = truncateOutput(stderr, appConfig.maxShellOutputBytes);

          resolve(JSON.stringify({ stdout: cappedStdout, stderr: cappedStderr, exitCode } as ShellResult));
        }
      );
    });
  },
};
