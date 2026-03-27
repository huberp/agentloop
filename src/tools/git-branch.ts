import { z } from "zod";
import simpleGit from "simple-git";
import type { ToolDefinition } from "./registry";

const schema = z.object({
  action: z
    .enum(["list", "create", "delete"])
    .describe("Operation: 'list' all branches, 'create' a new branch, or 'delete' a branch"),
  branch: z
    .string()
    .optional()
    .describe("Branch name — required for 'create' and 'delete'"),
  startPoint: z
    .string()
    .optional()
    .describe("Commit, tag, or branch to base the new branch on (create only; defaults to HEAD)"),
  force: z
    .boolean()
    .optional()
    .describe("Force-delete the branch even if not fully merged (delete only)"),
  cwd: z.string().optional().describe("Repository path (defaults to process.cwd())"),
});

/** A single branch entry returned by 'list'. */
export interface GitBranchEntry {
  name: string;
  current: boolean;
  commit: string;
}

/** Structured result returned by git-branch. */
interface GitBranchResult {
  success: boolean;
  branches?: GitBranchEntry[];
  current?: string;
  error?: string;
}

export const toolDefinition: ToolDefinition = {
  name: "git-branch",
  description:
    "Manages Git branches: list all local branches, create a new branch, or delete a branch. " +
    "Equivalent to `git branch`, `git branch <name> [<start>]`, `git branch -d|-D <name>`. " +
    "Permission: cautious (may modify branch structure).",
  schema,
  permissions: "cautious",
  execute: async ({
    action,
    branch,
    startPoint,
    force,
    cwd,
  }: {
    action: "list" | "create" | "delete";
    branch?: string;
    startPoint?: string;
    force?: boolean;
    cwd?: string;
  }): Promise<string> => {
    const repoPath = cwd ?? process.cwd();
    try {
      const git = simpleGit(repoPath);

      if (action === "list") {
        const summary = await git.branchLocal();
        const branches: GitBranchEntry[] = Object.values(summary.branches).map((b) => ({
          name: b.name,
          current: b.current,
          commit: b.commit,
        }));
        const result: GitBranchResult = {
          success: true,
          branches,
          current: summary.current,
        };
        return JSON.stringify(result);
      }

      if (!branch) {
        return JSON.stringify({
          success: false,
          error: `'branch' is required for action '${action}'`,
        } as GitBranchResult);
      }

      if (action === "create") {
        // Create branch from startPoint (or HEAD when omitted)
        const args = startPoint ? [branch, startPoint] : [branch];
        await git.branch(args);
        return JSON.stringify({ success: true } as GitBranchResult);
      }

      // action === "delete"
      if (force) {
        await git.deleteLocalBranch(branch, true);
      } else {
        await git.deleteLocalBranch(branch);
      }
      return JSON.stringify({ success: true } as GitBranchResult);
    } catch (err) {
      return JSON.stringify({
        success: false,
        error: err instanceof Error ? err.message : String(err),
      } as GitBranchResult);
    }
  },
};
