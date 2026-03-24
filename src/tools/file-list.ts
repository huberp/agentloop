import * as fs from "fs/promises";
import * as path from "path";
import { z } from "zod";
import type { ToolDefinition } from "./registry";
import { resolveSafe, globToRegExp } from "./file-utils";
import { appConfig } from "../config";

const schema = z.object({
  path: z.string().default(".").describe("Directory path relative to the workspace root (default: workspace root)"),
  glob: z.string().optional().describe("Optional glob pattern to filter entries (e.g. '*.ts', '**/*.json')"),
  recursive: z.boolean().optional().default(false).describe("List entries recursively (default: false)"),
});

/** A single directory entry returned by file-list. */
interface FileEntry {
  /** Path relative to the listed directory. */
  path: string;
  type: "file" | "directory";
  /** Size in bytes (files only). */
  sizeBytes?: number;
}

/**
 * Recursively collect entries under `dir`, returning paths relative to `baseDir`.
 */
async function collectEntries(dir: string, baseDir: string): Promise<FileEntry[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const results: FileEntry[] = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relativePath = path.relative(baseDir, fullPath);

    if (entry.isDirectory()) {
      results.push({ path: relativePath, type: "directory" });
      // Recurse into sub-directory.
      results.push(...(await collectEntries(fullPath, baseDir)));
    } else if (entry.isFile()) {
      const stat = await fs.stat(fullPath);
      results.push({ path: relativePath, type: "file", sizeBytes: stat.size });
    }
  }

  return results;
}

export const toolDefinition: ToolDefinition = {
  name: "file-list",
  description:
    "List the contents of a directory inside the workspace. " +
    "Supports optional glob filtering and recursive traversal.",
  schema,
  permissions: "safe",
  execute: async ({
    path: dirPath = ".",
    glob,
    recursive = false,
  }: {
    path?: string;
    glob?: string;
    recursive?: boolean;
  }): Promise<string> => {
    const resolved = resolveSafe(appConfig.workspaceRoot, dirPath);

    let entries: FileEntry[];

    if (recursive) {
      entries = await collectEntries(resolved, resolved);
    } else {
      const rawEntries = await fs.readdir(resolved, { withFileTypes: true });
      entries = await Promise.all(
        rawEntries.map(async (entry) => {
          if (entry.isDirectory()) {
            return { path: entry.name, type: "directory" as const };
          }
          const stat = await fs.stat(path.join(resolved, entry.name));
          return { path: entry.name, type: "file" as const, sizeBytes: stat.size };
        })
      );
    }

    // Apply glob filter when provided.
    if (glob) {
      const pattern = globToRegExp(glob);
      entries = entries.filter((e) => pattern.test(e.path));
    }

    return JSON.stringify({ entries });
  },
};
