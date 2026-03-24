import * as fs from "fs/promises";
import { applyPatch } from "diff";
import { z } from "zod";
import type { ToolDefinition } from "./registry";
import { resolveSafe } from "./file-utils";
import { appConfig } from "../config";

const schema = z.object({
  path: z.string().describe("Path of the file to patch, relative to the workspace root"),
  patch: z.string().describe("Unified diff patch string to apply"),
});

/** Result shape returned by the patch tool. */
interface PatchResult {
  success: boolean;
  error?: string;
}

/**
 * Applies a unified diff patch to a file inside the workspace.
 * Permission: "cautious" — modifies files on disk.
 */
export const toolDefinition: ToolDefinition = {
  name: "patch",
  description:
    "Apply a unified diff patch to a file inside the workspace. " +
    "The patch must be a valid unified diff string (as produced by the 'diff' tool).",
  schema,
  permissions: "cautious",
  execute: async ({
    path: filePath,
    patch,
  }: {
    path: string;
    patch: string;
  }): Promise<string> => {
    const resolved = resolveSafe(appConfig.workspaceRoot, filePath);
    const original = await fs.readFile(resolved, "utf-8");

    // applyPatch returns false when the patch cannot be applied cleanly.
    const patched = applyPatch(original, patch);

    if (patched === false) {
      const result: PatchResult = { success: false, error: "Patch could not be applied (hunk mismatch or invalid patch)" };
      return JSON.stringify(result);
    }

    await fs.writeFile(resolved, patched, "utf-8");
    const result: PatchResult = { success: true };
    return JSON.stringify(result);
  },
};
