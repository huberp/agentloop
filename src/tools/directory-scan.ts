import * as fs from "fs/promises";
import * as path from "path";
import { z } from "zod";
import type { ToolDefinition } from "./registry";
import { resolveSafe } from "./file-utils";
import { appConfig } from "../config";

/**
 * Directories that are always skipped during recursive traversal.
 * These are large build-artifact / dependency trees that have no value for
 * AI-driven code exploration and can easily produce millions of tokens.
 */
const DEFAULT_EXCLUDE_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "target",       // Rust / Maven
  ".venv",        // Python virtualenv
  "venv",
  "__pycache__",
  ".cache",
  ".tox",
  "coverage",
  ".nyc_output",
]);

const schema = z.object({
  path: z
    .string()
    .default(".")
    .describe("Directory path relative to the workspace root (default: workspace root)"),
  recursive: z
    .boolean()
    .optional()
    .default(false)
    .describe("Scan sub-directories recursively (default: false)"),
  exclude: z
    .array(z.string())
    .optional()
    .describe(
      "Additional directory names to exclude from recursive traversal " +
        "(node_modules, .git, dist, build, and other common build-artifact directories are always excluded)"
    ),
});

/** A single entry returned by directory-scan. */
interface ScanEntry {
  /** Name of the entry (file or directory name). */
  name: string;
  /** "f" for a regular file, "d" for a directory. */
  type: "f" | "d";
  /** Path relative to the scanned root directory (non-recursive: same as name). */
  path: string;
}

/**
 * Recursively collect entries under `dir`, returning paths relative to `baseDir`.
 * Directories whose base name appears in `excludeDirs` are silently skipped.
 */
async function collectEntries(
  dir: string,
  baseDir: string,
  excludeDirs: Set<string>
): Promise<ScanEntry[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const results: ScanEntry[] = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relativePath = path.relative(baseDir, fullPath);

    if (entry.isDirectory()) {
      if (excludeDirs.has(entry.name)) continue;
      results.push({ name: entry.name, type: "d", path: relativePath });
      results.push(...(await collectEntries(fullPath, baseDir, excludeDirs)));
    } else if (entry.isFile()) {
      results.push({ name: entry.name, type: "f", path: relativePath });
    }
  }

  return results;
}

export const toolDefinition: ToolDefinition = {
  name: "directory-scan",
  description:
    "Scan the contents of a directory inside the workspace and return each entry with its " +
    "name, relative path, and type ('f' for file, 'd' for directory). " +
    "Supports recursive traversal. Use this tool to discover which files and directories " +
    "exist before attempting to read them.",
  schema,
  permissions: "safe",
  execute: async ({
    path: dirPath = ".",
    recursive = false,
    exclude = [],
  }: {
    path?: string;
    recursive?: boolean;
    exclude?: string[];
  }): Promise<string> => {
    const resolved = resolveSafe(appConfig.workspaceRoot, dirPath);

    let entries: ScanEntry[];

    if (recursive) {
      const excludeDirs = new Set([...DEFAULT_EXCLUDE_DIRS, ...exclude]);
      entries = await collectEntries(resolved, resolved, excludeDirs);
    } else {
      const rawEntries = await fs.readdir(resolved, { withFileTypes: true });
      entries = rawEntries
        .filter((e) => e.isFile() || e.isDirectory())
        .map((e) => ({
          name: e.name,
          type: (e.isDirectory() ? "d" : "f") as "f" | "d",
          path: e.name,
        }));
    }

    return JSON.stringify({ entries });
  },
};
