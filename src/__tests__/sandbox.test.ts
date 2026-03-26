/**
 * Sandbox Tests (Task 4.4)
 *
 * Covers:
 *  - mapHostPathToContainer path-mapping logic (unit tests, always run)
 *  - runInDocker: code runs correctly inside the container          (integration — skipped without Docker)
 *  - runInDocker: filesystem changes in container don't affect host (integration — skipped without Docker)
 *  - code_run tool dispatches to Docker when sandboxMode="docker"   (integration — skipped without Docker)
 *
 * Integration tests are skipped when the Docker daemon is not reachable so that
 * CI environments without Docker installed still pass.
 */

import { execSync } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { runInDocker, mapHostPathToContainer, CONTAINER_WORKSPACE } from "../sandbox/docker";
import { appConfig } from "../config";

// ---------------------------------------------------------------------------
// Docker availability check (synchronous — runs once at module load time)
// ---------------------------------------------------------------------------

function isDockerAvailable(): boolean {
  try {
    execSync("docker info", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const DOCKER_AVAILABLE = isDockerAvailable();

// ---------------------------------------------------------------------------
// Unit tests — path mapping (no Docker required)
// ---------------------------------------------------------------------------

describe("sandbox/docker — mapHostPathToContainer", () => {
  it("maps a file inside workspaceRoot to the container path", () => {
    expect(mapHostPathToContainer("/ws/foo/bar.ts", "/ws")).toBe(`${CONTAINER_WORKSPACE}/foo/bar.ts`);
  });

  it("maps the workspaceRoot itself to CONTAINER_WORKSPACE", () => {
    expect(mapHostPathToContainer("/ws", "/ws")).toBe(CONTAINER_WORKSPACE);
  });

  it("returns null for paths outside workspaceRoot", () => {
    expect(mapHostPathToContainer("/etc/passwd", "/ws")).toBeNull();
  });

  it("handles nested workspace roots correctly", () => {
    expect(mapHostPathToContainer("/ws/a/b/c.js", "/ws")).toBe(`${CONTAINER_WORKSPACE}/a/b/c.js`);
  });
});

// ---------------------------------------------------------------------------
// Integration tests — require Docker daemon
// ---------------------------------------------------------------------------

describe("sandbox/docker — runInDocker integration", () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentloop-sandbox-test-"));
  });

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("(a) runs code inside the container and returns correct stdout", async () => {
    if (!DOCKER_AVAILABLE) {
      console.warn("Skipping: Docker not available");
      return;
    }

    const result = await runInDocker({
      executable: "node",
      args: ["-e", "console.log(42)"],
      cwd: tmpDir,
      timeout: 60_000,
      workspaceRoot: tmpDir,
    });

    expect(result.stdout.trim()).toBe("42");
    expect(result.exitCode).toBe(0);
  }, 120_000);

  it("(b) filesystem changes inside the container do not affect the host", async () => {
    if (!DOCKER_AVAILABLE) {
      console.warn("Skipping: Docker not available");
      return;
    }

    const hostFile = path.join(tmpDir, "should-not-exist.txt");

    // Attempt a write to the read-only workspace mount inside the container.
    // The write will fail due to the :ro mount but we catch the error so exit code is 0.
    const result = await runInDocker({
      executable: "node",
      args: [
        "-e",
        "try{require('fs').writeFileSync('/workspace/should-not-exist.txt','x')}catch(e){}",
      ],
      cwd: tmpDir,
      timeout: 60_000,
      workspaceRoot: tmpDir,
    });

    expect(result.exitCode).toBe(0);

    // The file must NOT exist on the host — the workspace was read-only
    const exists = await fs.access(hostFile).then(() => true).catch(() => false);
    expect(exists).toBe(false);
  }, 120_000);

  it("reports a timeout error when the container runs too long", async () => {
    if (!DOCKER_AVAILABLE) {
      console.warn("Skipping: Docker not available");
      return;
    }

    const result = await runInDocker({
      executable: "node",
      args: ["-e", "setTimeout(()=>{},60000)"],
      cwd: tmpDir,
      timeout: 500,
      workspaceRoot: tmpDir,
    });

    expect(result.exitCode).toBe(-1);
    expect(result.stderr).toContain("timed out");
  }, 120_000);
});

// ---------------------------------------------------------------------------
// Integration test — code_run tool dispatches to Docker
// ---------------------------------------------------------------------------

describe("code_run tool — SANDBOX_MODE=docker", () => {
  let originalSandboxMode: "none" | "docker";
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentloop-sandbox-tool-test-"));
    originalSandboxMode = appConfig.sandboxMode;
    (appConfig as Record<string, unknown>).sandboxMode = "docker";
    (appConfig as Record<string, unknown>).workspaceRoot = tmpDir;
  });

  afterAll(async () => {
    (appConfig as Record<string, unknown>).sandboxMode = originalSandboxMode;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("(a) code_run routes execution through Docker and returns correct output", async () => {
    if (!DOCKER_AVAILABLE) {
      console.warn("Skipping: Docker not available");
      return;
    }

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { toolDefinition } = require("../tools/code-run");
    const raw = await toolDefinition.execute({
      mode: "command",
      command: "node -e console.log(42)",
    });
    const result = JSON.parse(raw);

    expect(result.stdout.trim()).toBe("42");
    expect(result.exitCode).toBe(0);
  }, 120_000);
});
