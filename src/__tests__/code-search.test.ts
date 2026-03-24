import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { appConfig } from "../config";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a temporary workspace directory and point appConfig at it. */
async function makeTmpWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentloop-code-search-"));
  (appConfig as Record<string, unknown>).workspaceRoot = dir;
  return dir;
}

/** Remove a temporary workspace created by makeTmpWorkspace. */
async function cleanTmpWorkspace(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

/** Parse the JSON string returned by the code-search tool. */
function parseResult(raw: string): { matches: Array<{ file: string; line: number; column: number; content: string; context: string[] }>; truncated: boolean } {
  return JSON.parse(raw);
}

// Lazy import so the workspace root is set before the module is loaded.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const codeSearch = () => require("../tools/code-search").toolDefinition;

// ---------------------------------------------------------------------------
// Fixture files used across multiple test groups
// ---------------------------------------------------------------------------

/**
 * Create a small multi-file fixture tree:
 *
 *   workspace/
 *     src/
 *       hello.ts    — contains a function definition and a literal string
 *       utils.ts    — contains another function definition
 *     notes.txt     — plain-text file with the literal "hello" word
 */
async function createFixture(workspace: string): Promise<void> {
  await fs.mkdir(path.join(workspace, "src"), { recursive: true });

  await fs.writeFile(
    path.join(workspace, "src", "hello.ts"),
    [
      "// greeting module",
      "export function sayHello(name: string): string {",
      '  return `Hello, ${name}!`;',
      "}",
      "",
      "export function greetAll(names: string[]): void {",
      "  names.forEach((n) => console.log(sayHello(n)));",
      "}",
    ].join("\n"),
    "utf-8"
  );

  await fs.writeFile(
    path.join(workspace, "src", "utils.ts"),
    [
      "// utility helpers",
      "export function clamp(value: number, min: number, max: number): number {",
      "  return Math.min(Math.max(value, min), max);",
      "}",
    ].join("\n"),
    "utf-8"
  );

  await fs.writeFile(
    path.join(workspace, "notes.txt"),
    ["Meeting notes", "Say hello to the team.", "Action items pending."].join("\n"),
    "utf-8"
  );
}

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

describe("code-search — metadata", () => {
  it("has the correct name and permission level", () => {
    expect(codeSearch().name).toBe("code-search");
    expect(codeSearch().permissions).toBe("safe");
  });
});

// ---------------------------------------------------------------------------
// (a) Literal search finds the expected match
// ---------------------------------------------------------------------------

describe("code-search — (a) literal search", () => {
  let workspace: string;

  beforeAll(async () => {
    workspace = await makeTmpWorkspace();
    await createFixture(workspace);
  });

  afterAll(() => cleanTmpWorkspace(workspace));

  it("finds a known literal string and returns file, line, and content", async () => {
    const raw = await codeSearch().execute({
      pattern: "sayHello",
      mode: "literal",
      path: ".",
      maxResults: 50,
      contextLines: 0,
    });
    const { matches } = parseResult(raw);

    expect(matches.length).toBeGreaterThan(0);
    // The match in hello.ts is on the function-definition line.
    const hit = matches.find((m: { file: string }) => m.file.includes("hello.ts"));
    expect(hit).toBeDefined();
    expect(hit!.content).toContain("sayHello");
    expect(hit!.line).toBeGreaterThan(0);
  });

  it("scopes the search to a subdirectory", async () => {
    const raw = await codeSearch().execute({
      pattern: "hello",
      mode: "literal",
      path: "src",
      maxResults: 50,
      contextLines: 0,
    });
    const { matches } = parseResult(raw);

    // notes.txt lives outside 'src', so it should not appear.
    const inNotes = matches.some((m: { file: string }) => m.file.includes("notes.txt"));
    expect(inNotes).toBe(false);
  });

  it("includes surrounding context lines when contextLines > 0", async () => {
    const raw = await codeSearch().execute({
      pattern: "sayHello",
      mode: "literal",
      path: ".",
      maxResults: 50,
      contextLines: 1,
    });
    const { matches } = parseResult(raw);

    const hit = matches.find((m: { file: string }) => m.file.includes("hello.ts"));
    expect(hit).toBeDefined();
    // At least one context line should be present around the match.
    expect(hit!.context.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// (b) Regex search finds function definitions
// ---------------------------------------------------------------------------

describe("code-search — (b) regex search", () => {
  let workspace: string;

  beforeAll(async () => {
    workspace = await makeTmpWorkspace();
    await createFixture(workspace);
  });

  afterAll(() => cleanTmpWorkspace(workspace));

  it("finds all TypeScript function definitions with /function\\s+\\w+/", async () => {
    const raw = await codeSearch().execute({
      pattern: "function\\s+\\w+",
      mode: "regex",
      path: "src",
      maxResults: 50,
      contextLines: 0,
    });
    const { matches } = parseResult(raw);

    // hello.ts has 2 function definitions, utils.ts has 1 → at least 3 total.
    expect(matches.length).toBeGreaterThanOrEqual(3);
    expect(matches.every((m: { content: string }) => /function\s+\w+/.test(m.content))).toBe(true);
  });

  it("returns correct line numbers for regex matches", async () => {
    const raw = await codeSearch().execute({
      pattern: "sayHello",
      mode: "regex",
      path: "src",
      maxResults: 50,
      contextLines: 0,
    });
    const { matches } = parseResult(raw);

    for (const m of matches) {
      expect(m.line).toBeGreaterThan(0);
      expect(m.column).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// (c) Respects maxResults
// ---------------------------------------------------------------------------

describe("code-search — (c) maxResults cap", () => {
  let workspace: string;

  beforeAll(async () => {
    workspace = await makeTmpWorkspace();
    // Write a file with many matching lines.
    const lines = Array.from({ length: 20 }, (_, i) => `const x${i} = "hello";`);
    await fs.writeFile(path.join(workspace, "many.ts"), lines.join("\n"), "utf-8");
  });

  afterAll(() => cleanTmpWorkspace(workspace));

  it("caps results at the specified maxResults value", async () => {
    const raw = await codeSearch().execute({
      pattern: "hello",
      mode: "literal",
      path: ".",
      maxResults: 5,
      contextLines: 0,
    });
    const { matches, truncated } = parseResult(raw);

    expect(matches.length).toBeLessThanOrEqual(5);
    expect(truncated).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (d) No matches returns an empty array
// ---------------------------------------------------------------------------

describe("code-search — (d) no matches", () => {
  let workspace: string;

  beforeAll(async () => {
    workspace = await makeTmpWorkspace();
    await fs.writeFile(path.join(workspace, "empty.ts"), "const x = 1;\n", "utf-8");
  });

  afterAll(() => cleanTmpWorkspace(workspace));

  it("returns an empty matches array when the pattern is not found", async () => {
    const raw = await codeSearch().execute({
      pattern: "THIS_PATTERN_WILL_NEVER_MATCH_XYZ",
      mode: "literal",
      path: ".",
      maxResults: 50,
      contextLines: 0,
    });
    const { matches, truncated } = parseResult(raw);

    expect(matches).toEqual([]);
    expect(truncated).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (e) File-name glob mode
// ---------------------------------------------------------------------------

describe("code-search — (e) glob mode", () => {
  let workspace: string;

  beforeAll(async () => {
    workspace = await makeTmpWorkspace();
    await createFixture(workspace);
  });

  afterAll(() => cleanTmpWorkspace(workspace));

  it("returns files matching the glob pattern without content search", async () => {
    const raw = await codeSearch().execute({
      pattern: "**/*.ts",
      mode: "glob",
      path: ".",
      maxResults: 50,
      contextLines: 0,
    });
    const { matches } = parseResult(raw);

    // All results must be .ts files.
    expect(matches.length).toBeGreaterThan(0);
    expect(matches.every((m: { file: string }) => m.file.endsWith(".ts"))).toBe(true);
    // notes.txt must not appear.
    expect(matches.some((m: { file: string }) => m.file.endsWith(".txt"))).toBe(false);
    // line and column are 0 for glob hits.
    expect(matches.every((m: { line: number; column: number }) => m.line === 0 && m.column === 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (f) .gitignore is respected (fallback path)
// ---------------------------------------------------------------------------

describe("code-search — (f) .gitignore respected", () => {
  let workspace: string;

  beforeAll(async () => {
    workspace = await makeTmpWorkspace();
    // Create a file that should be found and one inside an ignored directory.
    await fs.writeFile(path.join(workspace, "visible.ts"), 'const x = "findme";\n', "utf-8");
    await fs.mkdir(path.join(workspace, "dist"), { recursive: true });
    await fs.writeFile(path.join(workspace, "dist", "bundle.ts"), 'const x = "findme";\n', "utf-8");
    await fs.writeFile(path.join(workspace, ".gitignore"), "dist\n", "utf-8");
  });

  afterAll(() => cleanTmpWorkspace(workspace));

  it("does not return results from gitignore-d directories", async () => {
    const raw = await codeSearch().execute({
      pattern: "findme",
      mode: "literal",
      path: ".",
      maxResults: 50,
      contextLines: 0,
    });
    const { matches } = parseResult(raw);

    const inDist = matches.some((m: { file: string }) => m.file.startsWith("dist/") || m.file.startsWith("dist\\"));
    expect(inDist).toBe(false);

    // The visible file must still appear.
    const inVisible = matches.some((m: { file: string }) => m.file === "visible.ts");
    expect(inVisible).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (g) fileGlob filter
// ---------------------------------------------------------------------------

describe("code-search — (g) fileGlob filter", () => {
  let workspace: string;

  beforeAll(async () => {
    workspace = await makeTmpWorkspace();
    await createFixture(workspace);
  });

  afterAll(() => cleanTmpWorkspace(workspace));

  it("restricts content search to files matching fileGlob", async () => {
    const raw = await codeSearch().execute({
      pattern: "hello",
      mode: "literal",
      path: ".",
      maxResults: 50,
      contextLines: 0,
      fileGlob: "**/*.ts",
    });
    const { matches } = parseResult(raw);

    // notes.txt contains "hello" but is excluded by the *.ts glob.
    expect(matches.every((m: { file: string }) => m.file.endsWith(".ts"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (h) Path traversal is rejected
// ---------------------------------------------------------------------------

describe("code-search — (h) path traversal rejection", () => {
  let workspace: string;

  beforeAll(async () => {
    workspace = await makeTmpWorkspace();
  });

  afterAll(() => cleanTmpWorkspace(workspace));

  it("throws when the search path escapes the workspace root", async () => {
    await expect(
      codeSearch().execute({
        pattern: "anything",
        mode: "literal",
        path: "../../etc",
        maxResults: 50,
        contextLines: 0,
      })
    ).rejects.toThrow(/outside the workspace root/);
  });
});
