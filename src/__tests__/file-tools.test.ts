import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { appConfig } from "../config";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a unique temp directory, set it as the workspace root, and return its path. */
async function makeTmpWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentloop-test-"));
  (appConfig as Record<string, unknown>).workspaceRoot = dir;
  return dir;
}

/** Remove a directory tree created by makeTmpWorkspace. */
async function cleanTmpWorkspace(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Lazy imports — tools are imported after `appConfig.workspaceRoot` is set so
// that each test group gets a fresh workspace before the module is resolved.
// We use `require()` so the import happens at call-time inside beforeAll/each.
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-require-imports
const fileRead = () => require("../tools/file-read").toolDefinition;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fileWrite = () => require("../tools/file-write").toolDefinition;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fileEdit = () => require("../tools/file-edit").toolDefinition;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fileDelete = () => require("../tools/file-delete").toolDefinition;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fileList = () => require("../tools/file-list").toolDefinition;

// ---------------------------------------------------------------------------
// file-read
// ---------------------------------------------------------------------------

describe("file-read — metadata", () => {
  it("has the correct name and permission level", () => {
    expect(fileRead().name).toBe("file-read");
    expect(fileRead().permissions).toBe("safe");
  });
});

describe("file-read — reading files", () => {
  let workspace: string;

  beforeAll(async () => {
    workspace = await makeTmpWorkspace();
    await fs.writeFile(path.join(workspace, "hello.txt"), "Hello, World!", "utf-8");
  });

  afterAll(() => cleanTmpWorkspace(workspace));

  it("returns content, size, and utf-8 encoding for a text file", async () => {
    const raw = await fileRead().execute({ path: "hello.txt" });
    const result = JSON.parse(raw);

    expect(result.content).toBe("Hello, World!");
    expect(result.encoding).toBe("utf-8");
    expect(result.sizeBytes).toBe(Buffer.byteLength("Hello, World!", "utf-8"));
  });

  it("accepts an explicit encoding override", async () => {
    const raw = await fileRead().execute({ path: "hello.txt", encoding: "base64" });
    const result = JSON.parse(raw);

    expect(result.encoding).toBe("base64");
    expect(Buffer.from(result.content, "base64").toString("utf-8")).toBe("Hello, World!");
  });

  it("auto-detects binary files as base64", async () => {
    // Write a buffer containing non-UTF-8 bytes (e.g., raw binary data)
    const binary = Buffer.from([0x00, 0x01, 0xff, 0xfe]);
    await fs.writeFile(path.join(workspace, "data.bin"), binary);

    const raw = await fileRead().execute({ path: "data.bin" });
    const result = JSON.parse(raw);

    expect(result.encoding).toBe("base64");
    expect(Buffer.from(result.content, "base64")).toEqual(binary);
  });

  it("rejects paths outside the workspace root", async () => {
    await expect(fileRead().execute({ path: "../../etc/passwd" })).rejects.toThrow(
      /outside the workspace root/
    );
  });
});

// ---------------------------------------------------------------------------
// file-write
// ---------------------------------------------------------------------------

describe("file-write — metadata", () => {
  it("has the correct name and permission level", () => {
    expect(fileWrite().name).toBe("file-write");
    expect(fileWrite().permissions).toBe("cautious");
  });
});

describe("file-write — writing files", () => {
  let workspace: string;

  beforeAll(async () => {
    workspace = await makeTmpWorkspace();
  });

  afterAll(() => cleanTmpWorkspace(workspace));

  it("creates a new file and reads it back with file-read", async () => {
    const writeRaw = await fileWrite().execute({ path: "new.txt", content: "created" });
    expect(JSON.parse(writeRaw).success).toBe(true);

    const readRaw = await fileRead().execute({ path: "new.txt" });
    expect(JSON.parse(readRaw).content).toBe("created");
  });

  it("overwrites an existing file", async () => {
    await fileWrite().execute({ path: "overwrite.txt", content: "first" });
    await fileWrite().execute({ path: "overwrite.txt", content: "second" });

    const readRaw = await fileRead().execute({ path: "overwrite.txt" });
    expect(JSON.parse(readRaw).content).toBe("second");
  });

  it("creates parent directories automatically", async () => {
    const writeRaw = await fileWrite().execute({
      path: "sub/dir/deep.txt",
      content: "nested",
    });
    expect(JSON.parse(writeRaw).success).toBe(true);

    const stat = await fs.stat(path.join(workspace, "sub/dir/deep.txt"));
    expect(stat.isFile()).toBe(true);
  });

  it("supports base64 encoded content", async () => {
    const original = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
    await fileWrite().execute({
      path: "binary.bin",
      content: original.toString("base64"),
      encoding: "base64",
    });

    const readRaw = await fileRead().execute({ path: "binary.bin", encoding: "base64" });
    const result = JSON.parse(readRaw);
    expect(Buffer.from(result.content, "base64")).toEqual(original);
  });

  it("rejects paths outside the workspace root", async () => {
    await expect(
      fileWrite().execute({ path: "../escape.txt", content: "x" })
    ).rejects.toThrow(/outside the workspace root/);
  });
});

// ---------------------------------------------------------------------------
// file-edit
// ---------------------------------------------------------------------------

describe("file-edit — metadata", () => {
  it("has the correct name and permission level", () => {
    expect(fileEdit().name).toBe("file-edit");
    expect(fileEdit().permissions).toBe("cautious");
  });
});

describe("file-edit — search-and-replace mode", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await makeTmpWorkspace();
    await fs.writeFile(path.join(workspace, "edit.txt"), "Hello old World", "utf-8");
  });

  afterEach(() => cleanTmpWorkspace(workspace));

  it("replaces the first occurrence of the search string", async () => {
    const raw = await fileEdit().execute({ path: "edit.txt", search: "old", replace: "new" });
    expect(JSON.parse(raw).success).toBe(true);

    const content = await fs.readFile(path.join(workspace, "edit.txt"), "utf-8");
    expect(content).toBe("Hello new World");
  });

  it("returns an error when the search string is not found", async () => {
    const raw = await fileEdit().execute({
      path: "edit.txt",
      search: "nonexistent",
      replace: "x",
    });
    const result = JSON.parse(raw);
    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
  });
});

describe("file-edit — line-range replacement mode", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await makeTmpWorkspace();
    await fs.writeFile(
      path.join(workspace, "lines.txt"),
      ["line1", "line2", "line3", "line4"].join("\n"),
      "utf-8"
    );
  });

  afterEach(() => cleanTmpWorkspace(workspace));

  it("replaces the specified line range", async () => {
    const raw = await fileEdit().execute({
      path: "lines.txt",
      startLine: 2,
      endLine: 3,
      newContent: "replaced",
    });
    expect(JSON.parse(raw).success).toBe(true);

    const content = await fs.readFile(path.join(workspace, "lines.txt"), "utf-8");
    expect(content).toBe(["line1", "replaced", "line4"].join("\n"));
  });

  it("returns an error when the line range is out of bounds", async () => {
    const raw = await fileEdit().execute({
      path: "lines.txt",
      startLine: 3,
      endLine: 99,
      newContent: "x",
    });
    const result = JSON.parse(raw);
    expect(result.success).toBe(false);
    expect(result.error).toContain("out of bounds");
  });
});

// ---------------------------------------------------------------------------
// file-delete
// ---------------------------------------------------------------------------

describe("file-delete — metadata", () => {
  it("has the correct name and permission level", () => {
    expect(fileDelete().name).toBe("file-delete");
    expect(fileDelete().permissions).toBe("dangerous");
  });
});

describe("file-delete — deleting files", () => {
  let workspace: string;

  beforeAll(async () => {
    workspace = await makeTmpWorkspace();
  });

  afterAll(() => cleanTmpWorkspace(workspace));

  it("deletes an existing file", async () => {
    await fs.writeFile(path.join(workspace, "todelete.txt"), "bye");

    const raw = await fileDelete().execute({ path: "todelete.txt" });
    expect(JSON.parse(raw).success).toBe(true);

    await expect(fs.access(path.join(workspace, "todelete.txt"))).rejects.toThrow();
  });

  it("throws when the file does not exist", async () => {
    await expect(fileDelete().execute({ path: "ghost.txt" })).rejects.toThrow();
  });

  it("rejects paths outside the workspace root", async () => {
    await expect(fileDelete().execute({ path: "../../secret" })).rejects.toThrow(
      /outside the workspace root/
    );
  });
});

// ---------------------------------------------------------------------------
// file-list
// ---------------------------------------------------------------------------

describe("file-list — metadata", () => {
  it("has the correct name and permission level", () => {
    expect(fileList().name).toBe("file-list");
    expect(fileList().permissions).toBe("safe");
  });
});

describe("file-list — listing directories", () => {
  let workspace: string;

  beforeAll(async () => {
    workspace = await makeTmpWorkspace();
    // Create a small fixture tree:
    //   workspace/
    //     a.ts
    //     b.js
    //     sub/
    //       c.ts
    await fs.writeFile(path.join(workspace, "a.ts"), "");
    await fs.writeFile(path.join(workspace, "b.js"), "");
    await fs.mkdir(path.join(workspace, "sub"));
    await fs.writeFile(path.join(workspace, "sub", "c.ts"), "");
  });

  afterAll(() => cleanTmpWorkspace(workspace));

  it("lists all entries in the workspace root (non-recursive)", async () => {
    const raw = await fileList().execute({ path: "." });
    const { entries } = JSON.parse(raw);

    const names = entries.map((e: { path: string }) => e.path);
    expect(names).toContain("a.ts");
    expect(names).toContain("b.js");
    expect(names).toContain("sub");
  });

  it("filters entries with a glob pattern", async () => {
    const raw = await fileList().execute({ path: ".", glob: "*.ts" });
    const { entries } = JSON.parse(raw);

    expect(entries.length).toBe(1);
    expect(entries[0].path).toBe("a.ts");
  });

  it("lists recursively and matches nested entries", async () => {
    const raw = await fileList().execute({ path: ".", recursive: true });
    const { entries } = JSON.parse(raw);

    // Normalize separators for cross-platform safety
    const names: string[] = entries.map((e: { path: string }) =>
      e.path.replace(/\\/g, "/")
    );
    expect(names).toContain("sub/c.ts");
  });

  it("applies a glob to recursive results", async () => {
    const raw = await fileList().execute({ path: ".", glob: "**/*.ts", recursive: true });
    const { entries } = JSON.parse(raw);

    expect(entries.every((e: { path: string }) => e.path.endsWith(".ts"))).toBe(true);
    expect(entries.length).toBe(2); // a.ts and sub/c.ts
  });

  it("includes sizeBytes for file entries", async () => {
    const raw = await fileList().execute({ path: ".", glob: "a.ts" });
    const { entries } = JSON.parse(raw);

    expect(entries[0].type).toBe("file");
    expect(typeof entries[0].sizeBytes).toBe("number");
  });

  it("rejects paths outside the workspace root", async () => {
    await expect(fileList().execute({ path: "../../" })).rejects.toThrow(
      /outside the workspace root/
    );
  });
});
