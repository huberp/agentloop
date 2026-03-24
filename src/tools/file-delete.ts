import * as fs from "fs/promises";
import { z } from "zod";
import type { ToolDefinition } from "./registry";
import { resolveSafe } from "./file-utils";
import { appConfig } from "../config";

const schema = z.object({
  path: z.string().describe("File path relative to the workspace root"),
});

export const toolDefinition: ToolDefinition = {
  name: "file-delete",
  description: "Delete a file inside the workspace. This operation is irreversible.",
  schema,
  permissions: "dangerous",
  execute: async ({ path: filePath }: { path: string }): Promise<string> => {
    const resolved = resolveSafe(appConfig.workspaceRoot, filePath);
    await fs.unlink(resolved);
    return JSON.stringify({ success: true, path: filePath });
  },
};
