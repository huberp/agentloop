import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const mockLogger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
jest.mock("../logger", () => ({ logger: mockLogger }));

jest.mock("../config", () => ({
  appConfig: {
    promptHistoryFile: "",
    logger: { level: "silent", enabled: false, destination: "stdout", name: "test", timestamp: false },
  },
}));

import { PromptRegistry } from "../prompts/registry";
import { appConfig } from "../config";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

function makeTmpFile(): string {
  return path.join(tmpDir, `history-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-ver-test-"));
  (appConfig as Record<string, unknown>).promptHistoryFile = "";
  jest.clearAllMocks();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// versions()
// ---------------------------------------------------------------------------

describe("PromptRegistry — versions()", () => {
  it("returns [] for unknown template name", () => {
    const reg = new PromptRegistry();
    expect(reg.versions("nonexistent")).toEqual([]);
  });

  it("returns both versions when two are registered, newest first", () => {
    const reg = new PromptRegistry();
    reg.register({ name: "sys", description: "", template: "v1 text", variables: [], version: "1.0.0" });
    reg.register({ name: "sys", description: "", template: "v2 text", variables: [], version: "1.1.0" });
    const vs = reg.versions("sys");
    expect(vs).toHaveLength(2);
    expect(vs[0].version).toBe("1.1.0");
    expect(vs[1].version).toBe("1.0.0");
  });

  it("orders three versions correctly: 2.0.0 > 1.10.0 > 1.2.0", () => {
    const reg = new PromptRegistry();
    reg.register({ name: "t", description: "", template: "a", variables: [], version: "1.10.0" });
    reg.register({ name: "t", description: "", template: "b", variables: [], version: "2.0.0" });
    reg.register({ name: "t", description: "", template: "c", variables: [], version: "1.2.0" });
    const vs = reg.versions("t");
    expect(vs.map((v) => v.version)).toEqual(["2.0.0", "1.10.0", "1.2.0"]);
  });

  it("active template is updated to the latest version", () => {
    const reg = new PromptRegistry();
    reg.register({ name: "sys", description: "", template: "old", variables: [], version: "1.0.0" });
    reg.register({ name: "sys", description: "", template: "new", variables: [], version: "1.1.0" });
    expect(reg.get("sys")?.template).toBe("new");
  });
});

// ---------------------------------------------------------------------------
// diff()
// ---------------------------------------------------------------------------

describe("PromptRegistry — diff()", () => {
  it("returns a non-empty unified diff string containing @@", () => {
    const reg = new PromptRegistry();
    reg.register({
      name: "system",
      description: "",
      template: "You are a helpful assistant.",
      variables: [],
      version: "1.0.0",
    });
    reg.register({
      name: "system",
      description: "",
      template: "You are a helpful and concise assistant.",
      variables: [],
      version: "1.1.0",
    });
    const result = reg.diff("system", "1.0.0", "1.1.0");
    expect(result.length).toBeGreaterThan(0);
    expect(result).toContain("@@");
  });

  it("throws if template name has no version history", () => {
    const reg = new PromptRegistry();
    expect(() => reg.diff("missing", "1.0.0", "1.1.0")).toThrow("missing");
  });

  it("throws if v1 version is not found", () => {
    const reg = new PromptRegistry();
    reg.register({ name: "sys", description: "", template: "text", variables: [], version: "1.0.0" });
    expect(() => reg.diff("sys", "0.9.0", "1.0.0")).toThrow("0.9.0");
  });

  it("throws if v2 version is not found", () => {
    const reg = new PromptRegistry();
    reg.register({ name: "sys", description: "", template: "text", variables: [], version: "1.0.0" });
    expect(() => reg.diff("sys", "1.0.0", "2.0.0")).toThrow("2.0.0");
  });
});

// ---------------------------------------------------------------------------
// Persistence — saveHistory / loadHistory
// ---------------------------------------------------------------------------

describe("PromptRegistry — saveHistory / loadHistory", () => {
  it("saveHistory writes a JSON file with version history", async () => {
    const file = makeTmpFile();
    (appConfig as Record<string, unknown>).promptHistoryFile = file;
    const reg = new PromptRegistry();
    reg.register({ name: "sys", description: "d", template: "hello", variables: [], version: "1.0.0" });
    await reg.saveHistory();
    const raw = fs.readFileSync(file, "utf-8");
    const data = JSON.parse(raw);
    expect(data).toHaveProperty("sys");
    expect(data.sys).toHaveLength(1);
    expect(data.sys[0].version).toBe("1.0.0");
  });

  it("loadHistory restores version history and sets active template to newest", async () => {
    const file = makeTmpFile();
    (appConfig as Record<string, unknown>).promptHistoryFile = file;

    // Build and persist with reg1
    const reg1 = new PromptRegistry();
    reg1.register({ name: "sys", description: "d", template: "v1", variables: [], version: "1.0.0" });
    reg1.register({ name: "sys", description: "d", template: "v2", variables: [], version: "1.1.0" });
    await reg1.saveHistory();

    // Restore into a fresh registry
    const reg2 = new PromptRegistry();
    await reg2.loadHistory();

    expect(reg2.get("sys")?.template).toBe("v2");
    const vs = reg2.versions("sys");
    expect(vs).toHaveLength(2);
    expect(vs[0].version).toBe("1.1.0");
    expect(vs[1].version).toBe("1.0.0");
  });

  it("loadHistory is a no-op when promptHistoryFile is empty string", async () => {
    (appConfig as Record<string, unknown>).promptHistoryFile = "";
    const reg = new PromptRegistry();
    await expect(reg.loadHistory()).resolves.toBeUndefined();
    expect(reg.list()).toHaveLength(0);
  });

  it("loadHistory is a no-op when the file does not exist", async () => {
    (appConfig as Record<string, unknown>).promptHistoryFile = path.join(tmpDir, "nonexistent.json");
    const reg = new PromptRegistry();
    await expect(reg.loadHistory()).resolves.toBeUndefined();
    expect(reg.list()).toHaveLength(0);
  });

  it("saveHistory is a no-op when promptHistoryFile is empty string", async () => {
    (appConfig as Record<string, unknown>).promptHistoryFile = "";
    const reg = new PromptRegistry();
    reg.register({ name: "t", description: "", template: "x", variables: [], version: "1.0.0" });
    await expect(reg.saveHistory()).resolves.toBeUndefined();
    // No file should have been created
    const files = fs.readdirSync(tmpDir);
    expect(files).toHaveLength(0);
  });

  it("diff() works correctly after restoring from loadHistory", async () => {
    const file = makeTmpFile();
    (appConfig as Record<string, unknown>).promptHistoryFile = file;

    const reg1 = new PromptRegistry();
    reg1.register({ name: "p", description: "", template: "old content", variables: [], version: "1.0.0" });
    reg1.register({ name: "p", description: "", template: "new content", variables: [], version: "2.0.0" });
    await reg1.saveHistory();

    const reg2 = new PromptRegistry();
    await reg2.loadHistory();

    const patch = reg2.diff("p", "1.0.0", "2.0.0");
    expect(patch).toContain("@@");
    expect(patch).toContain("old content");
    expect(patch).toContain("new content");
  });
});

// ---------------------------------------------------------------------------
// Backward compatibility — templates without version field
// ---------------------------------------------------------------------------

describe("PromptRegistry — backward compat (no version)", () => {
  it("registers and retrieves templates without version field", () => {
    const reg = new PromptRegistry();
    reg.register({ name: "t", description: "desc", template: "text", variables: [] });
    expect(reg.get("t")?.template).toBe("text");
  });

  it("versions() returns [] for template registered without version", () => {
    const reg = new PromptRegistry();
    reg.register({ name: "t", description: "", template: "text", variables: [] });
    expect(reg.versions("t")).toEqual([]);
  });

  it("render works normally for un-versioned templates", () => {
    const reg = new PromptRegistry();
    reg.register({ name: "t", description: "", template: "Hello {{name}}", variables: ["name"] });
    expect(reg.render("t", { name: "World" })).toBe("Hello World");
  });

  it("list() includes both versioned and un-versioned templates", () => {
    const reg = new PromptRegistry();
    reg.register({ name: "a", description: "", template: "a", variables: [], version: "1.0.0" });
    reg.register({ name: "b", description: "", template: "b", variables: [] });
    expect(reg.list().map((t) => t.name).sort()).toEqual(["a", "b"]);
  });
});

// ---------------------------------------------------------------------------
// Startup logging — logActiveTemplates via loadHistory
// ---------------------------------------------------------------------------

describe("PromptRegistry — startup logging after loadHistory", () => {
  it("logs info for each versioned template after loadHistory", async () => {
    const file = makeTmpFile();
    (appConfig as Record<string, unknown>).promptHistoryFile = file;

    const reg1 = new PromptRegistry();
    reg1.register({ name: "system", description: "", template: "template body", variables: [], version: "2.0.0" });
    await reg1.saveHistory();

    jest.clearAllMocks();

    const reg2 = new PromptRegistry();
    await reg2.loadHistory();

    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ templateName: "system", version: "2.0.0" }),
      "Prompt template active",
    );
  });

  it("does not emit info logs for templates without a version", async () => {
    const file = makeTmpFile();
    (appConfig as Record<string, unknown>).promptHistoryFile = file;

    // Write a history file that contains a template without a version field
    const historyWithoutVersion = { unversioned: [{ name: "unversioned", description: "", template: "txt", variables: [] }] };
    fs.writeFileSync(file, JSON.stringify(historyWithoutVersion), "utf-8");

    jest.clearAllMocks();
    const reg = new PromptRegistry();
    await reg.loadHistory();

    const activeLogCalls = mockLogger.info.mock.calls.filter(
      ([, msg]: [unknown, string]) => msg === "Prompt template active",
    );
    expect(activeLogCalls).toHaveLength(0);
  });

  it("logs multiple templates when multiple versioned templates are loaded", async () => {
    const file = makeTmpFile();
    (appConfig as Record<string, unknown>).promptHistoryFile = file;

    const reg1 = new PromptRegistry();
    reg1.register({ name: "sys", description: "", template: "sys", variables: [], version: "1.0.0" });
    reg1.register({ name: "code", description: "", template: "code", variables: [], version: "2.1.0" });
    await reg1.saveHistory();

    jest.clearAllMocks();
    const reg2 = new PromptRegistry();
    await reg2.loadHistory();

    const activeLogCalls = mockLogger.info.mock.calls.filter(
      ([, msg]: [unknown, string]) => msg === "Prompt template active",
    );
    expect(activeLogCalls).toHaveLength(2);
  });
});
