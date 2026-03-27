import { z } from "zod";
import simpleGit from "simple-git";
import type { ToolDefinition } from "./registry";

const schema = z.object({
  remote: z
    .string()
    .optional()
    .describe("Remote name (defaults to 'origin')"),
  branch: z
    .string()
    .optional()
    .describe("Branch to push (defaults to the currently checked-out branch)"),
  setUpstream: z
    .boolean()
    .optional()
    .describe("Set the upstream tracking reference, i.e. add `--set-upstream` / `-u`"),
  force: z
    .boolean()
    .optional()
    .describe("Force push — overwrites remote history. Use with caution."),
  cwd: z.string().optional().describe("Repository path (defaults to process.cwd())"),
});

/** Structured result returned by git-push. */
interface GitPushResult {
  success: boolean;
  remote?: string;
  branch?: string;
  error?: string;
}

export const toolDefinition: ToolDefinition = {
  name: "git-push",
  description:
    "Pushes the current (or specified) branch to a remote. " +
    "Equivalent to `git push [--set-upstream] [--force] <remote> <branch>`. " +
    "Defaults: remote='origin', branch=currently checked-out branch. " +
    "Permission: dangerous (modifies remote repository state).",
  schema,
  permissions: "dangerous",
  execute: async ({
    remote,
    branch,
    setUpstream,
    force,
    cwd,
  }: {
    remote?: string;
    branch?: string;
    setUpstream?: boolean;
    force?: boolean;
    cwd?: string;
  }): Promise<string> => {
    const repoPath = cwd ?? process.cwd();
    const targetRemote = remote ?? "origin";

    try {
      const git = simpleGit(repoPath);

      // Resolve current branch when none was specified
      const targetBranch = branch ?? (await git.revparse(["--abbrev-ref", "HEAD"])).trim();

      // Build push options
      const options: string[] = [];
      if (setUpstream) options.push("--set-upstream");
      if (force) options.push("--force");

      await git.push(targetRemote, targetBranch, options);

      return JSON.stringify({
        success: true,
        remote: targetRemote,
        branch: targetBranch,
      } as GitPushResult);
    } catch (err) {
      return JSON.stringify({
        success: false,
        error: err instanceof Error ? err.message : String(err),
      } as GitPushResult);
    }
  },
};
