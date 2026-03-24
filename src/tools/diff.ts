import * as fs from "fs/promises";
import { createTwoFilesPatch } from "diff";
import { z } from "zod";
import type { ToolDefinition } from "./registry";
import { resolveSafe } from "./file-utils";
import { appConfig } from "../config";

const schema = z.object({
  original: z.string().describe("Original text content (or file path when mode is 'files')"),
  modified: z.string().describe("Modified text content (or file path when mode is 'files')"),
  mode: z
    .enum(["strings", "files"])
    .optional()
    .describe("'strings' (default): diff two strings inline. 'files': diff two workspace files."),
  originalLabel: z.string().optional().describe("Label for the original side (default: 'original')"),
  modifiedLabel: z.string().optional().describe("Label for the modified side (default: 'modified')"),
});

/**
 * Generates a unified diff between two strings or two workspace files.
 * Permission: "safe" — read-only, no side effects.
 */
export const toolDefinition: ToolDefinition = {
  name: "diff",
  description:
    "Generate a unified diff between two strings or two files inside the workspace. " +
    "Set mode to 'files' to diff files by path; default mode is 'strings' for inline text.",
  schema,
  permissions: "safe",
  execute: async ({
    original,
    modified,
    mode = "strings",
    originalLabel,
    modifiedLabel,
  }: {
    original: string;
    modified: string;
    mode?: "strings" | "files";
    originalLabel?: string;
    modifiedLabel?: string;
  }): Promise<string> => {
    let originalText: string;
    let modifiedText: string;
    let labelA: string;
    let labelB: string;

    if (mode === "files") {
      // Read both files from the workspace; use file paths as labels by default.
      const origPath = resolveSafe(appConfig.workspaceRoot, original);
      const modPath = resolveSafe(appConfig.workspaceRoot, modified);
      originalText = await fs.readFile(origPath, "utf-8");
      modifiedText = await fs.readFile(modPath, "utf-8");
      labelA = originalLabel ?? original;
      labelB = modifiedLabel ?? modified;
    } else {
      originalText = original;
      modifiedText = modified;
      labelA = originalLabel ?? "original";
      labelB = modifiedLabel ?? "modified";
    }

    // createTwoFilesPatch returns a standard unified diff string.
    const patch = createTwoFilesPatch(labelA, labelB, originalText, modifiedText);

    return patch;
  },
};
