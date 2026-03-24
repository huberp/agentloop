import * as fs from "fs/promises";
import * as path from "path";
import { z } from "zod";
import type { ToolDefinition } from "./registry";
import { resolveSafe } from "./file-utils";
import { appConfig } from "../config";

const schema = z.object({
  path: z.string().describe("File path relative to the workspace root"),
  content: z.string().describe("Content to write"),
  encoding: z
    .enum(["utf-8", "base64"])
    .optional()
    .default("utf-8")
    .describe("Encoding of the provided content (default: utf-8)"),
});

export const toolDefinition: ToolDefinition = {
  name: "file-write",
  description:
    "Create or overwrite a file inside the workspace with the given content. " +
    "Parent directories are created automatically if they do not exist.",
  schema,
  permissions: "cautious",
  execute: async ({
    path: filePath,
    content,
    encoding = "utf-8",
  }: {
    path: string;
    content: string;
    encoding?: "utf-8" | "base64";
  }): Promise<string> => {
    const resolved = resolveSafe(appConfig.workspaceRoot, filePath);

    // Ensure parent directories exist before writing.
    await fs.mkdir(path.dirname(resolved), { recursive: true });

    const buffer =
      encoding === "base64"
        ? Buffer.from(content, "base64")
        : Buffer.from(content, "utf-8");

    await fs.writeFile(resolved, buffer);

    return JSON.stringify({ success: true, path: filePath });
  },
};
