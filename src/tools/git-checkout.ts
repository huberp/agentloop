import { z } from "zod";
import simpleGit from "simple-git";
import type { ToolDefinition } from "./registry";

const schema = z.object({
  branch: z
    .string()
    .describe("Branch name, tag, or commit hash to check out"),
  newBranch: z
    .string()
    .optional()
    .describe(
      "When provided, creates a new branch with this name at 'branch' and checks it out. " +
        "Equivalent to `git checkout -b <newBranch> <branch>`."
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
    "When 'newBranch' is supplied, creates that branch at the given ref and checks it out " +
    "(equivalent to `git checkout -b <newBranch> <branch>`). " +
    "Permission: cautious (modifies working-tree state).",
  schema,
  permissions: "cautious",
  execute: async ({
    branch,
    newBranch,
    cwd,
  }: {
    branch: string;
    newBranch?: string;
    cwd?: string;
  }): Promise<string> => {
    const repoPath = cwd ?? process.cwd();
    try {
      const git = simpleGit(repoPath);

      if (newBranch) {
        // Create and switch to a new branch based on the given ref
        await git.checkoutBranch(newBranch, branch);
        return JSON.stringify({ success: true, branch: newBranch } as GitCheckoutResult);
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
