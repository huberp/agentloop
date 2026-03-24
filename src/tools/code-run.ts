import { z } from "zod";
import { execFile } from "child_process";
import * as path from "path";
import type { ToolDefinition } from "./registry";
import { appConfig } from "../config";

/** Execution modes supported by the code-run tool. */
type ExecutionMode = "command" | "file";

const schema = z.object({
  mode: z
    .enum(["command", "file"])
    .describe(
      "Execution mode: 'command' runs a shell command string; 'file' runs a script file with the given interpreter"
    ),
  command: z
    .string()
    .optional()
    .describe("Shell command to execute (required when mode='command'; split by whitespace)"),
  file: z
    .string()
    .optional()
    .describe("Absolute path to the script file to run (required when mode='file')"),
  interpreter: z
    .string()
    .optional()
    .describe(
      "Interpreter executable for mode='file' (e.g. 'node', 'python3'). " +
        "Inferred from file extension when omitted."
    ),
  cwd: z.string().optional().describe("Working directory (defaults to process.cwd())"),
  env: z.record(z.string()).optional().describe("Extra environment variables merged into the process environment"),
  timeout: z
    .number()
    .optional()
    .describe("Timeout in milliseconds (overrides EXECUTION_TIMEOUT_MS / TOOL_TIMEOUT_MS)"),
});

/** Structured result returned by the code-run tool, serialised as JSON. */
interface CodeRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Map common file extensions to their default interpreter. */
const EXTENSION_INTERPRETER: Record<string, string> = {
  ".js": "node",
  ".ts": "ts-node",
  ".py": "python3",
  ".sh": "bash",
  ".rb": "ruby",
};

/** Resolve the interpreter for a script file, falling back to extension-based heuristic. */
function resolveInterpreter(filePath: string, explicit?: string): string | null {
  if (explicit) return explicit;
  const ext = path.extname(filePath).toLowerCase();
  return EXTENSION_INTERPRETER[ext] ?? null;
}

/** Spawn an executable with args and capture stdout/stderr/exitCode, respecting timeout. */
function spawnCaptured(
  executable: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeout: number }
): Promise<CodeRunResult> {
  return new Promise<CodeRunResult>((resolve) => {
    execFile(executable, args, options, (error, stdout, stderr) => {
      if (error?.killed) {
        resolve({
          stdout: "",
          stderr: `Execution timed out after ${options.timeout} milliseconds`,
          exitCode: -1,
        });
        return;
      }
      const exitCode = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
      resolve({ stdout, stderr, exitCode });
    });
  });
}

export const toolDefinition: ToolDefinition = {
  name: "code_run",
  description:
    "Execute code in a controlled local environment. " +
    "In 'command' mode, runs a shell command via execFile (no shell expansion; " +
    "the command string is split by whitespace — arguments containing spaces are not supported). " +
    "In 'file' mode, runs a script file with an explicit or auto-detected interpreter. " +
    "Returns stdout, stderr, and exit code as JSON. " +
    `Execution environment: ${appConfig.executionEnvironment}.`,
  schema,
  permissions: "dangerous",
  execute: async ({
    mode,
    command,
    file,
    interpreter,
    cwd,
    env,
    timeout,
  }: {
    mode: ExecutionMode;
    command?: string;
    file?: string;
    interpreter?: string;
    cwd?: string;
    env?: Record<string, string>;
    timeout?: number;
  }): Promise<string> => {
    const effectiveTimeout = timeout ?? appConfig.executionTimeoutMs;
    const effectiveCwd = cwd ?? process.cwd();
    const effectiveEnv: NodeJS.ProcessEnv = { ...process.env, ...env };

    let executable: string;
    let args: string[];

    if (mode === "command") {
      // Delegate to direct execFile — no shell; split command by whitespace
      if (!command?.trim()) {
        return JSON.stringify({ stdout: "", stderr: "No command provided", exitCode: -1 } as CodeRunResult);
      }
      [executable, ...args] = command.trim().split(/\s+/);
    } else {
      // mode === "file"
      if (!file?.trim()) {
        return JSON.stringify({ stdout: "", stderr: "No file path provided", exitCode: -1 } as CodeRunResult);
      }
      const resolvedInterpreter = resolveInterpreter(file, interpreter);
      if (!resolvedInterpreter) {
        return JSON.stringify({
          stdout: "",
          stderr: `Cannot determine interpreter for file: ${file}`,
          exitCode: -1,
        } as CodeRunResult);
      }
      executable = resolvedInterpreter;
      args = [file];
    }

    const result = await spawnCaptured(executable, args, {
      cwd: effectiveCwd,
      env: effectiveEnv,
      timeout: effectiveTimeout,
    });

    return JSON.stringify(result);
  },
};
