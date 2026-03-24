import { z } from "zod";
import simpleGit from "simple-git";
import type { ToolDefinition } from "./registry";

const schema = z.object({
  message: z.string().describe("Commit message"),
  files: z
    .array(z.string())
    .optional()
    .describe(
      "Files to stage before committing. Omit (or pass []) to stage all changes including untracked files."
    ),
  cwd: z.string().optional().describe("Repository path (defaults to process.cwd())"),
});

/** Structured result returned by git-commit. */
interface GitCommitResult {
  success: boolean;
  commitHash?: string;
  branch?: string;
  error?: string;
}

export const toolDefinition: ToolDefinition = {
  name: "git-commit",
  description:
    "Stages the specified files (or all tracked changes when none are given) and creates a Git commit " +
    "with the provided message. Equivalent to `git add <files> && git commit -m <message>`. " +
    "When no files are given, stages all changes (including untracked files) before committing. " +
    "Permission: cautious (modifies repository history).",
  schema,
  permissions: "cautious",
  execute: async ({
    message,
    files,
    cwd,
  }: {
    message: string;
    files?: string[];
    cwd?: string;
  }): Promise<string> => {
    const repoPath = cwd ?? process.cwd();
    try {
      const git = simpleGit(repoPath);

      // Stage the requested files, or all changes when no files are given
      if (files && files.length > 0) {
        await git.add(files);
      } else {
        await git.add(".");
      }

      const commitResult = await git.commit(message);
      const result: GitCommitResult = {
        success: true,
        commitHash: commitResult.commit,
        branch: commitResult.branch,
      };
      return JSON.stringify(result);
    } catch (err) {
      return JSON.stringify({
        success: false,
        error: err instanceof Error ? err.message : String(err),
      } as GitCommitResult);
    }
  },
};
