import * as path from "path";

const FIXTURES = path.join(__dirname, "fixtures");

/** Load a fresh toolDefinition so tests don't inherit mutated module state from other suites. */
function loadToolDefinition() {
  jest.resetModules();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("../tools/code-run").toolDefinition as typeof import("../tools/code-run").toolDefinition;
}

/** Parse the JSON string returned by the code-run tool. */
function parseResult(raw: string): { stdout: string; stderr: string; exitCode: number } {
  return JSON.parse(raw);
}

function expectTrimmedStdout(result: { stdout: string }) {
  expect(result.stdout.trim()).toBe("42");
}

describe("code_run tool — metadata", () => {
  it("has the correct name and permission level", () => {
    const toolDefinition = loadToolDefinition();
    expect(toolDefinition.name).toBe("code_run");
    expect(toolDefinition.permissions).toBe("dangerous");
  });
});

describe("code_run tool — mode: command", () => {
  it("(a) runs node -e and returns stdout with exitCode 0", async () => {
    const toolDefinition = loadToolDefinition();
    const raw = await toolDefinition.execute({
      mode: "command",
      command: `node -e console.log(42)`,
    });
    const result = parseResult(raw);

    expectTrimmedStdout(result);
    expect(result.exitCode).toBe(0);
  });

  it("returns error when no command is provided", async () => {
    const toolDefinition = loadToolDefinition();
    const raw = await toolDefinition.execute({ mode: "command", command: "" });
    const result = parseResult(raw);

    expect(result.exitCode).toBe(-1);
    expect(result.stderr).toContain("No command provided");
  });
});

describe("code_run tool — mode: file", () => {
  it("(a) runs a valid Node.js script file and captures stdout", async () => {
    const toolDefinition = loadToolDefinition();
    const raw = await toolDefinition.execute({
      mode: "file",
      file: path.join(FIXTURES, "hello.js"),
      interpreter: "node",
    });
    const result = parseResult(raw);

    expectTrimmedStdout(result);
    expect(result.exitCode).toBe(0);
  });

  it("(b) running a script with a syntax error returns stderr and non-zero exit code", async () => {
    const toolDefinition = loadToolDefinition();
    const raw = await toolDefinition.execute({
      mode: "file",
      file: path.join(FIXTURES, "broken.js"),
      interpreter: "node",
    });
    const result = parseResult(raw);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.length).toBeGreaterThan(0);
  });

  it("infers interpreter from .js extension when not provided", async () => {
    const toolDefinition = loadToolDefinition();
    const raw = await toolDefinition.execute({
      mode: "file",
      file: path.join(FIXTURES, "hello.js"),
    });
    const result = parseResult(raw);

    expectTrimmedStdout(result);
    expect(result.exitCode).toBe(0);
  });

  it("returns error when no file path is provided", async () => {
    const toolDefinition = loadToolDefinition();
    const raw = await toolDefinition.execute({ mode: "file" });
    const result = parseResult(raw);

    expect(result.exitCode).toBe(-1);
    expect(result.stderr).toContain("No file path provided");
  });

  it("returns error when interpreter cannot be determined", async () => {
    const toolDefinition = loadToolDefinition();
    const raw = await toolDefinition.execute({
      mode: "file",
      file: "/some/script.unknownext",
    });
    const result = parseResult(raw);

    expect(result.exitCode).toBe(-1);
    expect(result.stderr).toContain("Cannot determine interpreter");
  });
});

describe("code_run tool — (c) timeout enforcement", () => {
  it("kills a long-running command and reports a timeout error", async () => {
    const toolDefinition = loadToolDefinition();
    const raw = await toolDefinition.execute({
      mode: "command",
      command: "node -e setTimeout(function(){},9999)",
      timeout: 100,
    });
    const result = parseResult(raw);

    expect(result.exitCode).toBe(-1);
    expect(result.stderr).toContain("timed out");
  }, 5000 /* jest timeout */);
});
