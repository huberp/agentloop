import * as fs from "fs/promises";
import { z } from "zod";
import type { ToolDefinition } from "./registry";
import { resolveSafe } from "./file-utils";
import { appConfig } from "../config";

const schema = z.union([
  // Mode A: search-and-replace
  z.object({
    path: z.string().describe("File path relative to the workspace root"),
    search: z.string().describe("Exact string to search for"),
    replace: z.string().describe("String to replace the first occurrence with"),
  }),
  // Mode B: line-range replacement
  z.object({
    path: z.string().describe("File path relative to the workspace root"),
    startLine: z.number().int().min(1).describe("First line to replace (1-based, inclusive)"),
    endLine: z.number().int().min(1).describe("Last line to replace (1-based, inclusive)"),
    newContent: z.string().describe("Replacement text for the specified line range"),
  }),
]);

export const toolDefinition: ToolDefinition = {
  name: "file-edit",
  description:
    "Apply a targeted edit to a file inside the workspace. " +
    "Two modes are supported:\n" +
    "  • search/replace – provide `search` and `replace` to substitute the first occurrence.\n" +
    "  • line-range     – provide `startLine`, `endLine`, and `newContent` to replace the given lines.",
  schema,
  permissions: "cautious",
  execute: async (args: {
    path: string;
    search?: string;
    replace?: string;
    startLine?: number;
    endLine?: number;
    newContent?: string;
  }): Promise<string> => {
    const { path: filePath } = args;
    const resolved = resolveSafe(appConfig.workspaceRoot, filePath);
    const original = await fs.readFile(resolved, "utf-8");

    let updated: string;

    if (args.search !== undefined && args.replace !== undefined) {
      // Mode A: replace the first occurrence of the search string.
      if (!args.search) {
        return JSON.stringify({ success: false, error: "Search string must not be empty" });
      }
      if (!original.includes(args.search)) {
        return JSON.stringify({ success: false, error: `Search string not found in "${filePath}"` });
      }
      updated = original.replace(args.search, args.replace);
    } else if (
      args.startLine !== undefined &&
      args.endLine !== undefined &&
      args.newContent !== undefined
    ) {
      // Mode B: replace a range of lines (1-based, inclusive on both ends).
      const lines = original.split("\n");
      const start = args.startLine - 1; // convert to 0-based index
      const end = args.endLine; // exclusive end for splice

      if (start < 0 || args.endLine > lines.length) {
        return JSON.stringify({
          success: false,
          error: `Line range ${args.startLine}–${args.endLine} is out of bounds (file has ${lines.length} lines)`,
        });
      }

      const replacementLines = args.newContent.split("\n");
      lines.splice(start, end - start, ...replacementLines);
      updated = lines.join("\n");
    } else {
      return JSON.stringify({
        success: false,
        error: "Provide either (search + replace) or (startLine + endLine + newContent)",
      });
    }

    await fs.writeFile(resolved, updated, "utf-8");
    return JSON.stringify({ success: true, path: filePath });
  },
};
