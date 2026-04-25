import { z } from "zod";
import simpleGit from "simple-git";
import type { ToolDefinition } from "./registry";

const schema = z.object({
  branch: z
    .string()
    .optional()
    .describe(
      "Branch name, tag, or commit hash to check out. " +
        "Required when switching to an existing branch. " +
        "When 'newBranch' is also provided this is used as the start-point; " +
        "omit it to base the new branch on the current HEAD."
    ),
  newBranch: z
    .string()
    .optional()
    .describe(
      "When provided, creates a new branch with this name and checks it out. " +
        "If 'branch' is also provided, the new branch is based on that ref " +
        "(equivalent to `git checkout -b <newBranch> <branch>`). " +
        "If 'branch' is omitted, the new branch starts from the current HEAD " +
        "(equivalent to `git checkout -b <newBranch>`)."
    ),
  cwd: z.string().optional().describe("Repository path (defaults to process.cwd())"),
});

/** Structured result returned by git-checkout. */
interface GitCheckoutResult {
  success: boolean;
  branch?: string;
  error?: string;
}

export const toolDefinition: ToolDefinition = {
  name: "git-checkout",
  description:
    "Switches the working tree to the given branch, tag, or commit. " +
    "When 'newBranch' is supplied, creates that branch and checks it out. " +
    "If 'branch' is also provided it is used as the start-point " +
    "(equivalent to `git checkout -b <newBranch> <branch>`); " +
    "otherwise the new branch is based on the current HEAD " +
    "(equivalent to `git checkout -b <newBranch>`). " +
    "Permission: cautious (modifies working-tree state).",
  schema,
  permissions: "cautious",
  execute: async ({
    branch,
    newBranch,
    cwd,
  }: {
    branch?: string;
    newBranch?: string;
    cwd?: string;
  }): Promise<string> => {
    const repoPath = cwd ?? process.cwd();
    try {
      const git = simpleGit(repoPath);

      if (newBranch) {
        if (branch) {
          // Create and switch to a new branch based on the given ref
          await git.checkoutBranch(newBranch, branch);
        } else {
          // Create and switch to a new branch from the current HEAD
          await git.checkout(["-b", newBranch]);
        }
        return JSON.stringify({ success: true, branch: newBranch } as GitCheckoutResult);
      }

      if (!branch) {
        return JSON.stringify({
          success: false,
          error: "'branch' is required when 'newBranch' is not provided",
        } as GitCheckoutResult);
      }

      // Switch to an existing branch, tag, or commit
      await git.checkout(branch);
      return JSON.stringify({ success: true, branch } as GitCheckoutResult);
    } catch (err) {
      return JSON.stringify({
        success: false,
        error: err instanceof Error ? err.message : String(err),
      } as GitCheckoutResult);
    }
  },
};
