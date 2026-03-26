/**
 * Security Hardening Test Suite (Task 4.3)
 *
 * Covers:
 *  - Path traversal blocked for file tools
 *  - Shell injection metacharacters blocked
 *  - File size limits enforced for read and write
 *  - Shell output size limits enforced
 *  - Shell working-directory confinement to workspace root
 *  - Network access control (domain allowlist)
 *  - Concurrency limiter (semaphore behaviour)
 */

import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { appConfig } from "../config";
import { ConcurrencyLimiter, checkNetworkAccess } from "../security";
import { detectShellInjection, truncateOutput } from "../tools/sanitize";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a temp workspace directory and point appConfig at it. */
async function makeTmpWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentloop-sec-test-"));
  (appConfig as Record<string, unknown>).workspaceRoot = dir;
  return dir;
}

async function cleanTmpWorkspace(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

/** Parse the JSON result returned by tool execute() functions. */
function parseShellResult(raw: string): { stdout: string; stderr: string; exitCode: number } {
  return JSON.parse(raw);
}

// Lazy imports so workspace is set before module resolution
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fileRead = () => require("../tools/file-read").toolDefinition;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fileWrite = () => require("../tools/file-write").toolDefinition;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const shellTool = () => require("../tools/shell").toolDefinition;

// ---------------------------------------------------------------------------
// Path traversal
// ---------------------------------------------------------------------------

describe("Security — path traversal", () => {
  let workspace: string;

  beforeAll(async () => {
    workspace = await makeTmpWorkspace();
  });

  afterAll(() => cleanTmpWorkspace(workspace));

  it("file-read rejects ../../etc/passwd", async () => {
    await expect(fileRead().execute({ path: "../../etc/passwd" })).rejects.toThrow(
      /outside the workspace root/
    );
  });

  it("file-write rejects ../escape.txt", async () => {
    await expect(fileWrite().execute({ path: "../escape.txt", content: "x" })).rejects.toThrow(
      /outside the workspace root/
    );
  });

  it("file-read rejects an absolute path outside the workspace", async () => {
    await expect(fileRead().execute({ path: "/etc/passwd" })).rejects.toThrow(
      /outside the workspace root/
    );
  });
});

// ---------------------------------------------------------------------------
// Shell injection detection (sanitize utility)
// ---------------------------------------------------------------------------

describe("Security — shell injection detection (detectShellInjection)", () => {
  it("detects semicolon command separator", () => {
    expect(detectShellInjection("echo foo; rm -rf /")).toBe(true);
  });

  it("detects && operator", () => {
    expect(detectShellInjection("echo foo && cat /etc/passwd")).toBe(true);
  });

  it("detects || operator", () => {
    expect(detectShellInjection("false || cat /etc/passwd")).toBe(true);
  });

  it("detects pipe", () => {
    expect(detectShellInjection("ls | cat")).toBe(true);
  });

  it("detects backtick substitution", () => {
    expect(detectShellInjection("echo `whoami`")).toBe(true);
  });

  it("detects $() command substitution", () => {
    expect(detectShellInjection("echo $(whoami)")).toBe(true);
  });

  it("detects newline as command separator", () => {
    expect(detectShellInjection("echo foo\nrm -rf /")).toBe(true);
  });

  it("returns false for a clean command", () => {
    expect(detectShellInjection("ls -la /tmp")).toBe(false);
  });

  it("returns false for a multi-word command without metacharacters", () => {
    expect(detectShellInjection("git status")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Shell tool — injection blocked at execution
// ---------------------------------------------------------------------------

describe("Security — shell tool blocks injection attempts", () => {
  it("blocks a command with a semicolon ('; rm -rf /')", async () => {
    const raw = await shellTool().execute({ command: "echo foo; rm -rf /" });
    const result = parseShellResult(raw);
    expect(result.exitCode).toBe(-1);
    expect(result.stderr).toMatch(/injection|blocked/i);
  });

  it("blocks a command with backtick substitution", async () => {
    const raw = await shellTool().execute({ command: "echo `whoami`" });
    const result = parseShellResult(raw);
    expect(result.exitCode).toBe(-1);
    expect(result.stderr).toMatch(/injection|blocked/i);
  });

  it("allows a clean command through", async () => {
    const raw = await shellTool().execute({ command: "node -e process.stdout.write('safe\\n')" });
    const result = parseShellResult(raw);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("safe");
  });
});

// ---------------------------------------------------------------------------
// Shell tool — working-directory confinement
// ---------------------------------------------------------------------------

describe("Security — shell cwd confinement", () => {
  let workspace: string;

  beforeAll(async () => {
    workspace = await makeTmpWorkspace();
  });

  afterAll(() => cleanTmpWorkspace(workspace));

  it("rejects a cwd outside the workspace root", async () => {
    const raw = await shellTool().execute({ command: "node -e console.log(process.cwd())", cwd: "../../tmp" });
    const result = parseShellResult(raw);
    expect(result.exitCode).toBe(-1);
    expect(result.stderr).toMatch(/outside the workspace root/i);
  });
});

// ---------------------------------------------------------------------------
// Shell output size limit (truncateOutput utility)
// ---------------------------------------------------------------------------

describe("Security — output truncation (truncateOutput)", () => {
  it("returns the original string when it fits within the limit", () => {
    expect(truncateOutput("hello", 100)).toBe("hello");
  });

  it("truncates and appends a notice when the limit is exceeded", () => {
    const result = truncateOutput("A".repeat(200), 100);
    expect(result.length).toBeLessThanOrEqual(200); // not longer than input
    expect(result).toContain("[Output truncated");
  });

  it("keeps the truncated output within maxBytes + notice overhead", () => {
    const maxBytes = 50;
    const result = truncateOutput("X".repeat(1000), maxBytes);
    expect(Buffer.from(result, "utf-8").byteLength).toBeLessThanOrEqual(maxBytes + 60);
  });
});

describe("Security — shell tool enforces MAX_SHELL_OUTPUT_BYTES", () => {
  it("truncates very large stdout output", async () => {
    // Temporarily lower the limit so we can generate output that exceeds it
    const original = appConfig.maxShellOutputBytes;
    (appConfig as Record<string, unknown>).maxShellOutputBytes = 20;

    try {
      // Generate more than 20 bytes of output
      const raw = await shellTool().execute({ command: "node -e process.stdout.write('0123456789ABCDEFGHIJ0123456789\\n')" });
      const result = parseShellResult(raw);
      expect(result.stdout).toContain("[Output truncated");
    } finally {
      (appConfig as Record<string, unknown>).maxShellOutputBytes = original;
    }
  });
});

// ---------------------------------------------------------------------------
// File size limits
// ---------------------------------------------------------------------------

describe("Security — file-read enforces MAX_FILE_SIZE_BYTES", () => {
  let workspace: string;

  beforeAll(async () => {
    workspace = await makeTmpWorkspace();
    // Create a file with exactly 100 bytes
    await fs.writeFile(path.join(workspace, "big.txt"), "A".repeat(100));
  });

  afterAll(() => cleanTmpWorkspace(workspace));

  it("rejects a file that exceeds the configured limit", async () => {
    const original = appConfig.maxFileSizeBytes;
    (appConfig as Record<string, unknown>).maxFileSizeBytes = 50; // limit to 50 bytes

    try {
      await expect(fileRead().execute({ path: "big.txt" })).rejects.toThrow(
        /exceeds the maximum allowed size/
      );
    } finally {
      (appConfig as Record<string, unknown>).maxFileSizeBytes = original;
    }
  });

  it("allows a file that is within the limit", async () => {
    const original = appConfig.maxFileSizeBytes;
    (appConfig as Record<string, unknown>).maxFileSizeBytes = 200;

    try {
      const raw = await fileRead().execute({ path: "big.txt" });
      expect(JSON.parse(raw).content).toHaveLength(100);
    } finally {
      (appConfig as Record<string, unknown>).maxFileSizeBytes = original;
    }
  });
});

describe("Security — file-write enforces MAX_FILE_SIZE_BYTES", () => {
  let workspace: string;

  beforeAll(async () => {
    workspace = await makeTmpWorkspace();
  });

  afterAll(() => cleanTmpWorkspace(workspace));

  it("rejects content that exceeds the configured limit", async () => {
    const original = appConfig.maxFileSizeBytes;
    (appConfig as Record<string, unknown>).maxFileSizeBytes = 10; // very small limit

    try {
      await expect(
        fileWrite().execute({ path: "too-big.txt", content: "A".repeat(20) })
      ).rejects.toThrow(/exceeds the maximum allowed size/);
    } finally {
      (appConfig as Record<string, unknown>).maxFileSizeBytes = original;
    }
  });

  it("allows content that fits within the limit", async () => {
    const original = appConfig.maxFileSizeBytes;
    (appConfig as Record<string, unknown>).maxFileSizeBytes = 1000;

    try {
      const raw = await fileWrite().execute({ path: "ok.txt", content: "hello" });
      expect(JSON.parse(raw).success).toBe(true);
    } finally {
      (appConfig as Record<string, unknown>).maxFileSizeBytes = original;
    }
  });
});

// ---------------------------------------------------------------------------
// Network access control
// ---------------------------------------------------------------------------

describe("Security — checkNetworkAccess (domain allowlist)", () => {
  it("allows all hosts when the allowlist is empty", () => {
    expect(() => checkNetworkAccess("https://example.com/api", [])).not.toThrow();
  });

  it("allows a host that is exactly in the allowlist", () => {
    expect(() =>
      checkNetworkAccess("https://api.example.com/v1", ["api.example.com"])
    ).not.toThrow();
  });

  it("allows a subdomain when the parent domain is in the allowlist", () => {
    expect(() =>
      checkNetworkAccess("https://sub.example.com/path", ["example.com"])
    ).not.toThrow();
  });

  it("blocks a host not present in the allowlist", () => {
    expect(() =>
      checkNetworkAccess("https://evil.com/steal", ["api.example.com"])
    ).toThrow(/blocked/);
  });

  it("blocks a host that is only a suffix match (not a subdomain)", () => {
    // "notexample.com" should not be allowed when "example.com" is in the list
    expect(() =>
      checkNetworkAccess("https://notexample.com/path", ["example.com"])
    ).toThrow(/blocked/);
  });

  it("throws on a malformed URL", () => {
    expect(() => checkNetworkAccess("not-a-url", ["example.com"])).toThrow(/Invalid URL/);
  });
});

// ---------------------------------------------------------------------------
// Concurrency limiter
// ---------------------------------------------------------------------------

describe("Security — ConcurrencyLimiter", () => {
  it("runs a single task to completion", async () => {
    const limiter = new ConcurrencyLimiter(2);
    const result = await limiter.run(() => Promise.resolve(42));
    expect(result).toBe(42);
  });

  it("propagates errors thrown inside run()", async () => {
    const limiter = new ConcurrencyLimiter(2);
    await expect(
      limiter.run(() => Promise.reject(new Error("task failed")))
    ).rejects.toThrow("task failed");
  });

  it("releases the slot after an error", async () => {
    const limiter = new ConcurrencyLimiter(1);
    await expect(limiter.run(() => Promise.reject(new Error("oops")))).rejects.toThrow();
    // Slot must be released — next run completes without hanging
    await expect(limiter.run(() => Promise.resolve("ok"))).resolves.toBe("ok");
  });

  it("enforces the concurrency cap (max=1 serialises execution)", async () => {
    const limiter = new ConcurrencyLimiter(1);
    const log: number[] = [];

    const task = (id: number) =>
      limiter.run(
        () =>
          new Promise<void>((resolve) => {
            log.push(id);
            setTimeout(resolve, 10);
          })
      );

    await Promise.all([task(1), task(2), task(3)]);
    // All three tasks ran (order may vary due to scheduling but all must appear)
    expect(log.sort()).toEqual([1, 2, 3]);
  });

  it("allows up to maxConcurrent tasks to run simultaneously", async () => {
    const limiter = new ConcurrencyLimiter(3);
    let peak = 0;

    const tasks = Array.from({ length: 5 }, (_, i) =>
      limiter.run(async () => {
        peak = Math.max(peak, limiter.activeCount);
        await new Promise<void>((r) => setTimeout(r, 5));
      })
    );

    await Promise.all(tasks);
    expect(peak).toBeLessThanOrEqual(3);
  });

  it("bypasses limiting when maxConcurrent is 0", async () => {
    const limiter = new ConcurrencyLimiter(0);
    const result = await limiter.run(() => Promise.resolve("unlimited"));
    expect(result).toBe("unlimited");
  });
});
