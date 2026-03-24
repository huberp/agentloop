import { z } from "zod";
import simpleGit from "simple-git";
import type { ToolDefinition } from "./registry";

const schema = z.object({
  cwd: z.string().optional().describe("Repository path (defaults to process.cwd())"),
  maxCount: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Maximum number of commits to return (default: 20)"),
});

/** A single commit entry returned by git-log. */
export interface GitLogEntry {
  hash: string;
  date: string;
  message: string;
  author_name: string;
  author_email: string;
}

/** Structured result returned by git-log. */
interface GitLogResult {
  commits: GitLogEntry[];
}

export const toolDefinition: ToolDefinition = {
  name: "git-log",
  description:
    "Returns recent commit history for a Git repository as a structured list. " +
    "Equivalent to `git log --oneline`. Permission: safe (read-only).",
  schema,
  permissions: "safe",
  execute: async ({ cwd, maxCount }: { cwd?: string; maxCount?: number }): Promise<string> => {
    const repoPath = cwd ?? process.cwd();
    const limit = maxCount ?? 20;
    try {
      const git = simpleGit(repoPath);
      const log = await git.log({ maxCount: limit });

      const commits: GitLogEntry[] = log.all.map((entry) => ({
        hash: entry.hash,
        date: entry.date,
        message: entry.message,
        author_name: entry.author_name,
        author_email: entry.author_email,
      }));

      const result: GitLogResult = { commits };
      return JSON.stringify(result);
    } catch (err) {
      return JSON.stringify({
        error: err instanceof Error ? err.message : String(err),
        commits: [],
      });
    }
  },
};
