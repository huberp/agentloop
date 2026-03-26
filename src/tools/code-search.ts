import * as fs from "fs/promises";
import * as path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { z } from "zod";
import type { ToolDefinition } from "./registry";
import { appConfig } from "../config";
import { resolveSafe, globToRegExp } from "./file-utils";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single search result entry returned by the code-search tool. */
export interface SearchMatch {
  file: string;      // path relative to the searched directory
  line: number;      // 1-based line number (0 for glob-mode file hits)
  column: number;    // 1-based column of the first match (0 for glob-mode)
  content: string;   // full text of the matched line (empty for glob-mode)
  context: string[]; // surrounding lines (up to contextLines before and after)
}

/** Structured result serialised as JSON by the tool. */
interface CodeSearchResult {
  matches: SearchMatch[];
  /** True if results were capped by maxResults. */
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const schema = z.object({
  pattern: z
    .string()
    .describe(
      "Pattern to search for. Interpreted as a literal string, regular expression, " +
        "or file-name glob depending on the 'mode' parameter."
    ),
  mode: z
    .enum(["literal", "regex", "glob"])
    .default("literal")
    .describe(
      "'literal' = exact string match, 'regex' = regular expression search, " +
        "'glob' = file-name glob (returns matching file paths, not content lines)"
    ),
  path: z
    .string()
    .default(".")
    .describe("Directory to search in, relative to the workspace root."),
  maxResults: z
    .number()
    .int()
    .positive()
    .default(50)
    .describe("Maximum number of matches to return across all files (default: 50)."),
  contextLines: z
    .number()
    .int()
    .min(0)
    .default(2)
    .describe("Number of surrounding lines to include as context on each side (default: 2)."),
  fileGlob: z
    .string()
    .optional()
    .describe(
      "Glob pattern to restrict which files are searched (e.g. '**/*.ts'). " +
        "Ignored when mode is 'glob'."
    ),
});

// ---------------------------------------------------------------------------
// Helpers — regex utils
// ---------------------------------------------------------------------------

/** Escape a string so it can be used as a literal inside a RegExp. */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Build a RegExp for content matching in literal or regex mode. */
function buildContentRegex(pattern: string, mode: "literal" | "regex"): RegExp {
  return new RegExp(mode === "literal" ? escapeRegex(pattern) : pattern);
}

// ---------------------------------------------------------------------------
// Helpers — ripgrep
// ---------------------------------------------------------------------------

/**
 * Search using the `rg` (ripgrep) binary.
 * Returns parsed matches, or throws if `rg` is not installed (ENOENT).
 */
async function searchWithRipgrep(
  pattern: string,
  mode: "literal" | "regex" | "glob",
  absDir: string,
  maxResults: number,
  contextLines: number,
  fileGlob?: string
): Promise<SearchMatch[]> {
  if (mode === "glob") {
    // List files matching the glob pattern; no content search.
    const args = ["--files", "--glob", pattern, absDir];
    const { stdout } = await execFileAsync("rg", args);
    return stdout
      .split("\n")
      .filter(Boolean)
      .slice(0, maxResults)
      .map((filePath) => ({
        file: path.relative(absDir, filePath).replace(/\\/g, "/"),
        line: 0,
        column: 0,
        content: "",
        context: [],
      }));
  }

  const args: string[] = [
    "--json",
    "-C", String(contextLines),
    ...(mode === "literal" ? ["--fixed-strings"] : []),
    ...(fileGlob ? ["--glob", fileGlob] : []),
    pattern,
    absDir,
  ];

  const { stdout } = await execFileAsync("rg", args, { maxBuffer: 10 * 1024 * 1024 });
  return parseRipgrepJson(stdout, absDir, maxResults, contextLines);
}

/**
 * Parse ripgrep's NDJSON output (`rg --json`) into SearchMatch objects.
 * Each line is an independent JSON object with a "type" field.
 */
function parseRipgrepJson(
  output: string,
  absDir: string,
  maxResults: number,
  contextLines: number
): SearchMatch[] {
  // Collect all typed entries first, then correlate context to each match.
  type RgEntry = { type: string; data: Record<string, unknown> };
  const entries: RgEntry[] = [];

  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed) as RgEntry);
    } catch {
      /* ignore malformed lines */
    }
  }

  const matches: SearchMatch[] = [];

  for (const entry of entries) {
    if (matches.length >= maxResults) break;
    if (entry.type !== "match") continue;

    const d = entry.data;
    const filePath = String((d.path as Record<string, unknown>).text ?? "");
    const lineNum = Number(d.line_number ?? 0);
    const lineText = String((d.lines as Record<string, unknown>).text ?? "").replace(/\n$/, "");
    const submatches = d.submatches as Array<Record<string, unknown>> | undefined;
    const col = Number((submatches?.[0] as Record<string, unknown> | undefined)?.start ?? 0) + 1;

    // Collect context lines for this match from adjacent "context" entries.
    const ctxLines: string[] = entries
      .filter(
        (e) =>
          e.type === "context" &&
          String((e.data.path as Record<string, unknown>).text ?? "") === filePath &&
          Math.abs(Number(e.data.line_number) - lineNum) <= contextLines
      )
      .sort((a, b) => Number(a.data.line_number) - Number(b.data.line_number))
      .map((e) => String((e.data.lines as Record<string, unknown>).text ?? "").replace(/\n$/, ""));

    matches.push({
      file: path.relative(absDir, filePath).replace(/\\/g, "/"),
      line: lineNum,
      column: col,
      content: lineText,
      context: ctxLines,
    });
  }

  return matches;
}

// ---------------------------------------------------------------------------
// Helpers — gitignore
// ---------------------------------------------------------------------------

/**
 * Read `.gitignore` from `dir` and return a list of RegExps for ignored paths.
 * `.git` and `node_modules` are always excluded.
 */
async function loadIgnorePatterns(dir: string): Promise<RegExp[]> {
  // Always ignore VCS metadata and dependency directories.
  const patterns: RegExp[] = [/^\.git(\/|$)/, /^node_modules(\/|$)/];

  try {
    const raw = await fs.readFile(path.join(dir, ".gitignore"), "utf-8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      // Skip blank lines, comments, and negation patterns (not supported here).
      if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("!")) continue;
      // Strip a trailing slash that marks directory-only patterns.
      const normalized = trimmed.replace(/\/$/, "");
      try {
        patterns.push(globToRegExp(normalized));
      } catch {
        /* skip patterns that can't be compiled */
      }
    }
  } catch {
    /* no .gitignore — that's fine */
  }

  return patterns;
}

/**
 * Return true if `relPath` (forward-slash separated) should be ignored.
 *
 * .gitignore supports two pattern scopes:
 *  - Patterns without a slash match the basename only (e.g. `*.log`).
 *  - Patterns with a slash (handled by globToRegExp) match against the full path.
 * Testing both ensures that simple filename patterns work at any depth.
 */
function isIgnored(relPath: string, patterns: RegExp[]): boolean {
  const basename = relPath.slice(relPath.lastIndexOf("/") + 1);
  return patterns.some((p) => p.test(relPath) || p.test(basename));
}

// ---------------------------------------------------------------------------
// Helpers — fs-based recursive search (fallback)
// ---------------------------------------------------------------------------

/**
 * Recursively collect file paths (relative to `baseDir`, forward-slash separated)
 * while honouring ignore patterns and an optional file-glob filter.
 */
async function collectFiles(
  baseDir: string,
  currentDir: string,
  ignorePatterns: RegExp[],
  fileGlob?: string
): Promise<string[]> {
  const files: string[] = [];
  let entries;

  try {
    entries = await fs.readdir(currentDir, { withFileTypes: true });
  } catch {
    return files; // unreadable directory — skip
  }

  const fileGlobRe = fileGlob ? globToRegExp(fileGlob) : null;

  for (const entry of entries) {
    const abs = path.join(currentDir, entry.name);
    const rel = path.relative(baseDir, abs).replace(/\\/g, "/");

    if (isIgnored(rel, ignorePatterns)) continue;

    if (entry.isDirectory()) {
      files.push(...(await collectFiles(baseDir, abs, ignorePatterns, fileGlob)));
    } else if (entry.isFile()) {
      if (!fileGlobRe || fileGlobRe.test(rel)) {
        files.push(rel);
      }
    }
  }

  return files;
}

/**
 * Search a single file for lines matching `regex` and append hits to `matches`.
 * Stops early when `maxResults` is reached.
 */
async function searchFileContent(
  baseDir: string,
  relFile: string,
  regex: RegExp,
  contextLines: number,
  matches: SearchMatch[],
  maxResults: number
): Promise<void> {
  let content: string;
  try {
    content = await fs.readFile(path.join(baseDir, relFile), "utf-8");
  } catch {
    return; // skip binary or unreadable files
  }

  const lines = content.split("\n");

  for (let i = 0; i < lines.length && matches.length < maxResults; i++) {
    // Use String.match() — safe without a global flag and returns the first match.
    const m = lines[i].match(regex);
    if (m !== null) {
      const before = lines.slice(Math.max(0, i - contextLines), i);
      const after = lines.slice(i + 1, Math.min(lines.length, i + 1 + contextLines));
      matches.push({
        file: relFile,
        line: i + 1,
        column: (m.index ?? 0) + 1,
        content: lines[i],
        context: [...before, ...after],
      });
    }
  }
}

/**
 * Fallback search using Node.js `fs/promises` (used when ripgrep is not installed).
 * Respects `.gitignore` patterns and skips binary / unreadable files.
 */
async function searchWithFs(
  pattern: string,
  mode: "literal" | "regex" | "glob",
  absDir: string,
  maxResults: number,
  contextLines: number,
  fileGlob?: string
): Promise<SearchMatch[]> {
  const ignorePatterns = await loadIgnorePatterns(absDir);
  const files = await collectFiles(absDir, absDir, ignorePatterns, mode === "glob" ? undefined : fileGlob);

  if (mode === "glob") {
    // File-name glob: filter collected paths by the pattern itself.
    const globRe = globToRegExp(pattern);
    return files
      .filter((f) => globRe.test(f))
      .slice(0, maxResults)
      .map((f) => ({ file: f, line: 0, column: 0, content: "", context: [] }));
  }

  // Content search.
  const regex = buildContentRegex(pattern, mode);
  const matches: SearchMatch[] = [];

  for (const file of files) {
    if (matches.length >= maxResults) break;
    await searchFileContent(absDir, file, regex, contextLines, matches, maxResults);
  }

  return matches;
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const toolDefinition: ToolDefinition = {
  name: "code-search",
  description:
    "Search files in the workspace using a literal string, regular expression, or file-name glob. " +
    "Returns matching lines with file path, line/column numbers, and surrounding context. " +
    "Uses ripgrep (rg) when available for performance; falls back to a built-in recursive search.",
  schema,
  permissions: "safe",

  execute: async ({
    pattern,
    mode,
    path: searchPath,
    maxResults,
    contextLines,
    fileGlob,
  }: {
    pattern: string;
    mode: "literal" | "regex" | "glob";
    path: string;
    maxResults: number;
    contextLines: number;
    fileGlob?: string;
  }): Promise<string> => {
    // Resolve and validate the search directory against the workspace root.
    const absDir = resolveSafe(appConfig.workspaceRoot, searchPath);

    let matches: SearchMatch[];

    try {
      // Prefer ripgrep for performance; ENOENT means it is not installed.
      matches = await searchWithRipgrep(pattern, mode, absDir, maxResults, contextLines, fileGlob);
    } catch (err: unknown) {
      // Optional-chain .code — err may not be a NodeJS.ErrnoException.
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== "ENOENT") {
        // ripgrep is installed but the search failed (e.g. invalid regex).
        // Surface a structured error rather than crashing.
        const result: CodeSearchResult = { matches: [], truncated: false };
        return JSON.stringify({ ...result, error: String(err) });
      }
      // Fallback: ripgrep not installed — use the pure-Node implementation.
      matches = await searchWithFs(pattern, mode, absDir, maxResults, contextLines, fileGlob);
    }

    const truncated = matches.length >= maxResults;
    const result: CodeSearchResult = { matches: matches.slice(0, maxResults), truncated };
    return JSON.stringify(result);
  },
};
