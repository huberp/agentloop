import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { toolDefinition } from "../tools/shell";
import { appConfig } from "../config";

/** Parse the JSON string returned by the shell tool. */
function parseResult(raw: string): { stdout: string; stderr: string; exitCode: number } {
  return JSON.parse(raw);
}

describe("shell tool — metadata", () => {
  it("has the correct name and permission level", () => {
    expect(toolDefinition.name).toBe("shell");
    expect(toolDefinition.permissions).toBe("dangerous");
  });
});

describe("shell tool — (a) successful command", () => {
  let workspace: string;

  beforeAll(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), "agentloop-shell-test-"));
    (appConfig as Record<string, unknown>).workspaceRoot = workspace;
  });

  afterAll(async () => {
    await fs.rm(workspace, { recursive: true, force: true });
  });

  it("returns stdout and exitCode 0 for 'echo hello'", async () => {
    const raw = await toolDefinition.execute({ command: "echo hello" });
    const result = parseResult(raw);

    expect(result.stdout.trim()).toBe("hello");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("accepts a configurable working directory within the workspace", async () => {
    // Create a sub-directory inside the workspace to use as cwd
    const subdir = path.join(workspace, "subdir");
    await fs.mkdir(subdir, { recursive: true });

    const raw = await toolDefinition.execute({ command: "pwd", cwd: "subdir" });
    const result = parseResult(raw);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(subdir);
  });

  it("rejects a cwd that escapes the workspace root", async () => {
    const raw = await toolDefinition.execute({ command: "pwd", cwd: "../../tmp" });
    const result = parseResult(raw);

    expect(result.exitCode).toBe(-1);
    expect(result.stderr).toMatch(/outside the workspace root/i);
  });

  it("merges extra environment variables into the process", async () => {
    // printenv reads directly from the process environment — no shell needed
    const raw = await toolDefinition.execute({
      command: "printenv AGENTLOOP_TEST_VAR",
      env: { AGENTLOOP_TEST_VAR: "hello_env" },
    });
    const result = parseResult(raw);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hello_env");
  });
});

describe("shell tool — (b) failing command", () => {
  it("returns non-zero exitCode and stderr for a failing command", async () => {
    // 'false' always exits with code 1 on POSIX systems
    const raw = await toolDefinition.execute({ command: "false" });
    const result = parseResult(raw);

    expect(result.exitCode).not.toBe(0);
  });

  it("returns stderr content for a command that writes to stderr", async () => {
    // ls on a non-existent path writes an error to stderr and exits non-zero
    const raw = await toolDefinition.execute({ command: "ls /path/does/not/exist/xyz123" });
    const result = parseResult(raw);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.length).toBeGreaterThan(0);
  });

  it("captures exit code when executable is not found", async () => {
    const raw = await toolDefinition.execute({ command: "this_command_does_not_exist_xyz" });
    const result = parseResult(raw);

    // ENOENT is treated as exitCode 1
    expect(result.exitCode).not.toBe(0);
  });
});

describe("shell tool — (c) blocked command", () => {
  it("rejects 'rm -rf /' before execution", async () => {
    const raw = await toolDefinition.execute({ command: "rm -rf /" });
    const result = parseResult(raw);

    expect(result.exitCode).toBe(-1);
    expect(result.stderr).toContain("blocked");
    expect(result.stdout).toBe("");
  });

  it("rejects commands containing 'mkfs'", async () => {
    const raw = await toolDefinition.execute({ command: "mkfs.ext4 /dev/sda" });
    const result = parseResult(raw);

    expect(result.exitCode).toBe(-1);
    expect(result.stderr).toContain("blocked");
  });

  it("rejects commands containing 'dd if='", async () => {
    const raw = await toolDefinition.execute({ command: "dd if=/dev/zero of=/dev/sda" });
    const result = parseResult(raw);

    expect(result.exitCode).toBe(-1);
    expect(result.stderr).toContain("blocked");
  });

  it("allows benign commands not on the blocklist", async () => {
    const raw = await toolDefinition.execute({ command: "echo safe" });
    const result = parseResult(raw);

    expect(result.exitCode).toBe(0);
  });
});

describe("shell tool — (d) timeout", () => {
  it("kills the process and returns a timeout error when the timeout is exceeded", async () => {
    // 'sleep 5' exceeds our 100 ms timeout
    const raw = await toolDefinition.execute({ command: "sleep 5", timeout: 100 });
    const result = parseResult(raw);

    expect(result.exitCode).toBe(-1);
    expect(result.stderr).toContain("timed out");
  }, 5000 /* jest timeout — give the test up to 5 s */);
});
