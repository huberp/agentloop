/**
 * Docker-based execution sandbox (Task 4.4).
 *
 * Runs untrusted code inside an ephemeral Docker container with:
 *  - Host workspace mounted read-only  → container cannot modify host files.
 *  - Network disabled (--network none) → container cannot reach the internet.
 *  - Container auto-removed on exit (--rm).
 *  - Host environment variables NOT inherited; only explicit `env` is injected.
 */

import { execFile } from "child_process";
import * as path from "path";

/** Path inside the container where the host workspace is mounted read-only. */
export const CONTAINER_WORKSPACE = "/workspace";

/** Result of a sandboxed execution — mirrors the shape returned by code-run. */
export interface SandboxResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Options for running a command inside a Docker sandbox. */
export interface SandboxOptions {
  /** Executable to invoke inside the container (must exist in the image). */
  executable: string;
  /** Arguments for the executable. Paths must already be container-relative. */
  args: string[];
  /** Absolute host path used as the working directory (mapped to its container equivalent). */
  cwd: string;
  /** Extra environment variables injected into the container (host env is NOT inherited). */
  env?: Record<string, string>;
  /** Execution timeout in milliseconds; the container is killed and exitCode -1 is returned on expiry. */
  timeout: number;
  /** Absolute host path of the workspace root — mounted read-only at CONTAINER_WORKSPACE. */
  workspaceRoot: string;
  /** Docker image to run (default: node:20-alpine). */
  image?: string;
}

/**
 * Map a host absolute path to its equivalent path inside the container.
 *
 * Returns the container-side path when `hostPath` is within `workspaceRoot`,
 * or `null` when it is outside the workspace (and therefore not accessible).
 */
export function mapHostPathToContainer(hostPath: string, workspaceRoot: string): string | null {
  const root = path.resolve(workspaceRoot);
  const resolved = path.resolve(hostPath);

  if (resolved === root) return CONTAINER_WORKSPACE;

  if (resolved.startsWith(root + path.sep)) {
    const rel = path.relative(root, resolved);
    // Use forward slashes for the container path regardless of host OS
    return `${CONTAINER_WORKSPACE}/${rel.split(path.sep).join("/")}`;
  }

  return null;
}

/**
 * Run a command inside a minimal, ephemeral Docker container.
 *
 * The workspace is mounted read-only so host files cannot be altered.
 * Network access is disabled for additional isolation.
 */
export async function runInDocker(options: SandboxOptions): Promise<SandboxResult> {
  const {
    executable,
    args,
    cwd,
    env = {},
    timeout,
    workspaceRoot,
    image = "node:20-alpine",
  } = options;

  const resolvedRoot = path.resolve(workspaceRoot);
  const containerCwd = mapHostPathToContainer(cwd, resolvedRoot) ?? CONTAINER_WORKSPACE;

  const dockerArgs: string[] = [
    "run",
    "--rm",
    "--network", "none",
    "-v", `${resolvedRoot}:${CONTAINER_WORKSPACE}:ro`,
    "-w", containerCwd,
  ];

  // Inject only caller-supplied env vars; host environment is intentionally excluded
  for (const [key, value] of Object.entries(env)) {
    dockerArgs.push("-e", `${key}=${value}`);
  }

  dockerArgs.push(image, executable, ...args);

  return new Promise<SandboxResult>((resolve) => {
    // SIGKILL force-kills the docker CLI immediately when the timeout fires, preventing
    // the default 10-second graceful stop delay. The container is cleaned up by the Docker
    // daemon once it detects the client disconnect; the --rm flag ensures auto-removal.
    execFile("docker", dockerArgs, { timeout, killSignal: "SIGKILL" }, (error, stdout, stderr) => {
      if (error?.killed) {
        resolve({
          stdout: "",
          stderr: `Execution timed out after ${timeout} milliseconds`,
          exitCode: -1,
        });
        return;
      }
      const exitCode = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
      resolve({ stdout, stderr, exitCode });
    });
  });
}
