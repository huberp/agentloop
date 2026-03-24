import { z } from "zod";
import simpleGit from "simple-git";
import type { ToolDefinition } from "./registry";

const schema = z.object({
  cwd: z.string().optional().describe("Repository path (defaults to process.cwd())"),
  path: z.string().optional().describe("Limit diff to this file or directory path"),
  staged: z.boolean().optional().describe("Show staged (cached) diff instead of working-tree diff"),
});

/** Structured result returned by git-diff. */
interface GitDiffResult {
  diff: string;
}

export const toolDefinition: ToolDefinition = {
  name: "git-diff",
  description:
    "Returns the diff for a Git repository. Optionally limited to a specific file path " +
    "and/or the staged (cached) diff. Equivalent to `git diff [--cached] [-- <path>]`. " +
    "Permission: safe (read-only).",
  schema,
  permissions: "safe",
  execute: async ({
    cwd,
    path,
    staged,
  }: {
    cwd?: string;
    path?: string;
    staged?: boolean;
  }): Promise<string> => {
    const repoPath = cwd ?? process.cwd();
    try {
      const git = simpleGit(repoPath);

      // Build diff options: optionally include --cached and a path filter
      const options: string[] = [];
      if (staged) options.push("--cached");
      if (path) options.push("--", path);

      const diff: string = await git.diff(options);
      const result: GitDiffResult = { diff };
      return JSON.stringify(result);
    } catch (err) {
      return JSON.stringify({
        error: err instanceof Error ? err.message : String(err),
        diff: "",
      });
    }
  },
};
