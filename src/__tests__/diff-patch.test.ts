import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { appConfig } from "../config";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a unique temp directory and set it as the workspace root. */
async function makeTmpWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentloop-diff-test-"));
  (appConfig as Record<string, unknown>).workspaceRoot = dir;
  return dir;
}

async function cleanTmpWorkspace(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

// Lazy imports so workspaceRoot is set before module resolution.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const diffTool = () => require("../tools/diff").toolDefinition;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const patchTool = () => require("../tools/patch").toolDefinition;

// ---------------------------------------------------------------------------
// diff — metadata
// ---------------------------------------------------------------------------

describe("diff — metadata", () => {
  it("has the correct name and permission level", () => {
    expect(diffTool().name).toBe("diff");
    expect(diffTool().permissions).toBe("safe");
  });
});

// ---------------------------------------------------------------------------
// diff — string mode
// ---------------------------------------------------------------------------

describe("diff — string mode", () => {
  it("returns a valid unified diff for two different strings", async () => {
    const patch = await diffTool().execute({ original: "hello", modified: "hello world" });

    // A unified diff always starts with "--- "
    expect(patch).toContain("--- ");
    expect(patch).toContain("+++ ");
    expect(patch).toContain("hello world");
  });

  it("returns an empty (header-only) diff when strings are identical", async () => {
    const patch = await diffTool().execute({ original: "same", modified: "same" });

    // No hunk markers when content is identical
    expect(patch).not.toContain("@@");
  });

  it("uses custom labels in the diff header", async () => {
    const patch = await diffTool().execute({
      original: "a",
      modified: "b",
      originalLabel: "v1.txt",
      modifiedLabel: "v2.txt",
    });

    expect(patch).toContain("v1.txt");
    expect(patch).toContain("v2.txt");
  });
});

// ---------------------------------------------------------------------------
// diff — file mode
// ---------------------------------------------------------------------------

describe("diff — file mode", () => {
  let workspace: string;

  beforeAll(async () => {
    workspace = await makeTmpWorkspace();
    await fs.writeFile(path.join(workspace, "orig.txt"), "line1\nline2\n", "utf-8");
    await fs.writeFile(path.join(workspace, "mod.txt"), "line1\nline2 changed\n", "utf-8");
  });

  afterAll(() => cleanTmpWorkspace(workspace));

  it("diffs two workspace files and returns a valid unified diff", async () => {
    const patch = await diffTool().execute({
      original: "orig.txt",
      modified: "mod.txt",
      mode: "files",
    });

    expect(patch).toContain("--- ");
    expect(patch).toContain("+++ ");
    expect(patch).toContain("line2 changed");
  });

  it("rejects file paths outside the workspace root", async () => {
    await expect(
      diffTool().execute({ original: "../../etc/passwd", modified: "mod.txt", mode: "files" })
    ).rejects.toThrow(/outside the workspace root/);
  });
});

// ---------------------------------------------------------------------------
// patch — metadata
// ---------------------------------------------------------------------------

describe("patch — metadata", () => {
  it("has the correct name and permission level", () => {
    expect(patchTool().name).toBe("patch");
    expect(patchTool().permissions).toBe("cautious");
  });
});

// ---------------------------------------------------------------------------
// patch — applying patches
// ---------------------------------------------------------------------------

describe("patch — applying patches", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await makeTmpWorkspace();
  });

  afterEach(() => cleanTmpWorkspace(workspace));

  it("applying the diff of original→modified produces the modified content", async () => {
    const original = "hello\n";
    const modified = "hello world\n";

    await fs.writeFile(path.join(workspace, "target.txt"), original, "utf-8");

    // Generate diff via diff tool then apply it
    const patch = await diffTool().execute({ original, modified });
    const raw = await patchTool().execute({ path: "target.txt", patch });
    expect(JSON.parse(raw).success).toBe(true);

    const result = await fs.readFile(path.join(workspace, "target.txt"), "utf-8");
    expect(result).toBe(modified);
  });

  it("applying a bad patch (hunk mismatch) returns an error and does not modify the file", async () => {
    const content = "unchanged\n";
    await fs.writeFile(path.join(workspace, "stable.txt"), content, "utf-8");

    // A patch whose hunk context doesn't match the file triggers applyPatch → false
    const mismatchPatch =
      "--- original\n+++ modified\n@@ -1 +1 @@\n-wrong line\n+new line\n";
    const raw = await patchTool().execute({ path: "stable.txt", patch: mismatchPatch });
    const result = JSON.parse(raw);
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();

    // File should be untouched
    const after = await fs.readFile(path.join(workspace, "stable.txt"), "utf-8");
    expect(after).toBe(content);
  });

  it("rejects paths outside the workspace root", async () => {
    await expect(
      patchTool().execute({ path: "../../secret", patch: "" })
    ).rejects.toThrow(/outside the workspace root/);
  });
});
