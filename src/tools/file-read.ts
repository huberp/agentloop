import * as fs from "fs/promises";
import { z } from "zod";
import type { ToolDefinition } from "./registry";
import { resolveSafe } from "./file-utils";
import { appConfig } from "../config";

const schema = z.object({
  path: z.string().describe("File path relative to the workspace root"),
  encoding: z
    .enum(["utf-8", "base64"])
    .optional()
    .describe("Encoding for the returned content (default: auto-detect)"),
});

/** Structured result returned by the file-read tool. */
interface FileReadResult {
  content: string;
  /** Detected or requested encoding used to decode the file. */
  encoding: "utf-8" | "base64";
  /** File size in bytes. */
  sizeBytes: number;
}

/**
 * Detect whether a Buffer contains valid UTF-8 text.
 * Returns true for all-ASCII or valid multi-byte UTF-8 sequences.
 */
function isUtf8(buffer: Buffer): boolean {
  try {
    // TextDecoder throws on invalid byte sequences when `fatal: true` is set.
    new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    return true;
  } catch {
    return false;
  }
}

export const toolDefinition: ToolDefinition = {
  name: "file-read",
  description:
    "Read a file inside the workspace and return its content as a string. " +
    "Also returns file size and the detected encoding. " +
    "Binary files are returned as base64 when no explicit encoding is requested.",
  schema,
  permissions: "safe",
  execute: async ({
    path: filePath,
    encoding,
  }: {
    path: string;
    encoding?: "utf-8" | "base64";
  }): Promise<string> => {
    const resolved = resolveSafe(appConfig.workspaceRoot, filePath);
    const buffer = await fs.readFile(resolved);

    const stat = await fs.stat(resolved);
    const sizeBytes = stat.size;

    // Determine encoding: use the explicit request, or auto-detect.
    const detectedEncoding: "utf-8" | "base64" =
      encoding ?? (isUtf8(buffer) ? "utf-8" : "base64");

    const content =
      detectedEncoding === "utf-8"
        ? buffer.toString("utf-8")
        : buffer.toString("base64");

    const result: FileReadResult = { content, encoding: detectedEncoding, sizeBytes };
    return JSON.stringify(result);
  },
};
