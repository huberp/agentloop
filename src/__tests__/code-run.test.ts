import * as path from "path";
import { toolDefinition } from "../tools/code-run";

const FIXTURES = path.join(__dirname, "fixtures");

/** Parse the JSON string returned by the code-run tool. */
function parseResult(raw: string): { stdout: string; stderr: string; exitCode: number } {
  return JSON.parse(raw);
}

describe("code_run tool — metadata", () => {
  it("has the correct name and permission level", () => {
    expect(toolDefinition.name).toBe("code_run");
    expect(toolDefinition.permissions).toBe("dangerous");
  });
});

describe("code_run tool — mode: command", () => {
  it("(a) runs node -e and returns stdout with exitCode 0", async () => {
    const raw = await toolDefinition.execute({
      mode: "command",
      command: `node -e console.log(42)`,
    });
    const result = parseResult(raw);

    expect(result.stdout.trim()).toBe("42");
    expect(result.exitCode).toBe(0);
  });

  it("returns error when no command is provided", async () => {
    const raw = await toolDefinition.execute({ mode: "command", command: "" });
    const result = parseResult(raw);

    expect(result.exitCode).toBe(-1);
    expect(result.stderr).toContain("No command provided");
  });
});

describe("code_run tool — mode: file", () => {
  it("(a) runs a valid Node.js script file and captures stdout", async () => {
    const raw = await toolDefinition.execute({
      mode: "file",
      file: path.join(FIXTURES, "hello.js"),
      interpreter: "node",
    });
    const result = parseResult(raw);

    expect(result.stdout.trim()).toBe("42");
    expect(result.exitCode).toBe(0);
  });

  it("(b) running a script with a syntax error returns stderr and non-zero exit code", async () => {
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
    const raw = await toolDefinition.execute({
      mode: "file",
      file: path.join(FIXTURES, "hello.js"),
    });
    const result = parseResult(raw);

    expect(result.stdout.trim()).toBe("42");
    expect(result.exitCode).toBe(0);
  });

  it("returns error when no file path is provided", async () => {
    const raw = await toolDefinition.execute({ mode: "file" });
    const result = parseResult(raw);

    expect(result.exitCode).toBe(-1);
    expect(result.stderr).toContain("No file path provided");
  });

  it("returns error when interpreter cannot be determined", async () => {
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
