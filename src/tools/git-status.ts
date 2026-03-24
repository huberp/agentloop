import { z } from "zod";
import simpleGit from "simple-git";
import type { ToolDefinition } from "./registry";

const schema = z.object({
  cwd: z.string().optional().describe("Repository path (defaults to process.cwd())"),
});

/** A single file entry from git status --porcelain. */
export interface GitStatusEntry {
  /** Two-character XY status code (e.g. " M", "??", "A "). */
  status: string;
  /** File path relative to the repository root. */
  path: string;
}

/** Structured result returned by git-status. */
interface GitStatusResult {
  entries: GitStatusEntry[];
  isClean: boolean;
}

export const toolDefinition: ToolDefinition = {
  name: "git-status",
  description:
    "Returns the working-tree status of a Git repository as a structured list of changed files. " +
    "Equivalent to `git status --porcelain`. Permission: safe (read-only).",
  schema,
  permissions: "safe",
  execute: async ({ cwd }: { cwd?: string }): Promise<string> => {
    const repoPath = cwd ?? process.cwd();
    try {
      const git = simpleGit(repoPath);
      const status = await git.status();

      // Map simple-git StatusResult to our compact entry format.
      // `f.index` is the index (staging area) status character; `f.working_dir`
      // is the working-tree status character — together they form the two-char
      // porcelain XY code (e.g. " M", "??", "A ").
      const entries: GitStatusEntry[] = status.files.map((f) => ({
        status: f.index + f.working_dir,
        path: f.path,
      }));

      const result: GitStatusResult = { entries, isClean: status.isClean() };
      return JSON.stringify(result);
    } catch (err) {
      return JSON.stringify({
        error: err instanceof Error ? err.message : String(err),
        entries: [],
        isClean: false,
      });
    }
  },
};
