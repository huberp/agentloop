import * as readline from "readline";
import { logger } from "./logger";
import type { ToolDefinition } from "./tools/registry";
import { ToolBlockedError } from "./errors";

/** Decides whether to allow execution of a tool that requires confirmation. */
export interface ConfirmationHandler {
  confirm(toolName: string, args: unknown): Promise<boolean>;
}

/**
 * Default CLI confirmation handler.
 * Prompts the user via stdin for "dangerous" tools when running interactively.
 * Replace with a different implementation for UI/API contexts.
 *
 * A new readline interface is created per prompt and immediately closed after
 * the answer to avoid holding stdin open between confirmations.
 */
export class CliConfirmationHandler implements ConfirmationHandler {
  async confirm(toolName: string, args: unknown): Promise<boolean> {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => {
      const argsStr = JSON.stringify(args);
      rl.question(
        `[Security] Allow dangerous tool "${toolName}" with args ${argsStr}? (y/N): `,
        (answer) => {
          rl.close();
          resolve(answer.toLowerCase().trim() === "y");
        }
      );
    });
  }
}

/**
 * Enforces tool permissions before execution.
 *
 * Permission levels (from ToolDefinition.permissions):
 *   "safe"      → auto-approved silently (default)
 *   "cautious"  → auto-approved after logging a warning (audit trail)
 *   "dangerous" → requires user confirmation unless AUTO_APPROVE_ALL is set
 *
 * Blocklist/allowlist checks always run first, regardless of permission level.
 */
export class ToolPermissionManager {
  constructor(
    private readonly config: {
      autoApproveAll: boolean;
      /** Non-empty means only tools in this list are permitted. */
      toolAllowlist: string[];
      /** Tools in this list are always rejected. */
      toolBlocklist: string[];
    },
    /** Injected handler — defaults to CLI prompts; swap for tests or UI integration. */
    private readonly confirmationHandler: ConfirmationHandler = new CliConfirmationHandler()
  ) {}

  /**
   * Check whether `definition` is allowed to run with the given `args`.
   * Resolves if the tool is permitted; throws `ToolBlockedError` otherwise.
   *
   * **Note:** For "dangerous" tools this method may suspend execution while
   * waiting for user input via the `ConfirmationHandler`. Callers in
   * non-interactive contexts should set `autoApproveAll: true` or inject a
   * non-blocking handler to avoid unexpected blocking.
   */
  async checkPermission(definition: ToolDefinition, args?: unknown): Promise<void> {
    const { name, permissions = "safe" } = definition;

    // Blocklist: always rejected, even if also in allowlist
    if (this.config.toolBlocklist.includes(name)) {
      throw new ToolBlockedError(name, `tool "${name}" is blocklisted`);
    }

    // Allowlist: when non-empty, only listed tools are permitted
    if (this.config.toolAllowlist.length > 0 && !this.config.toolAllowlist.includes(name)) {
      throw new ToolBlockedError(name, `tool "${name}" is not in the allowlist`);
    }

    if (permissions === "safe") {
      // Safe tools are always approved without any logging overhead
      return;
    }

    if (permissions === "cautious") {
      // Log cautious tools for audit purposes, then approve automatically
      logger.warn({ toolName: name }, `Cautious tool "${name}" approved (logged for audit)`);
      return;
    }

    // "dangerous": require explicit confirmation unless AUTO_APPROVE_ALL bypasses it
    if (this.config.autoApproveAll) {
      logger.warn({ toolName: name }, `Dangerous tool "${name}" auto-approved via AUTO_APPROVE_ALL`);
      return;
    }

    const approved = await this.confirmationHandler.confirm(name, args);
    if (!approved) {
      throw new ToolBlockedError(name, `user declined confirmation for dangerous tool "${name}"`);
    }
    logger.info({ toolName: name }, `Dangerous tool "${name}" approved by user`);
  }
}
