import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

import { logger } from "../logger";
import { ToolRegistry } from "../tools/registry";
import { runSubagent } from "./runner";
import type { SubagentDefinition, SubagentResult, ParallelTask, ParallelResult, ConflictInfo } from "./types";

/**
 * Manages subagent execution with a configurable concurrency limit.
 *
 * When the number of concurrently running subagents reaches `concurrencyLimit`,
 * additional `run()` calls are queued and resume automatically as slots free up.
 */
export class SubagentManager {
  /** Number of subagents currently executing. */
  private running = 0;
  /** Pending resolve callbacks waiting for a concurrency slot. */
  private readonly queue: Array<() => void> = [];

  /**
   * @param concurrencyLimit  Maximum number of subagents allowed to run at the same time.
   * @param registry          Parent ToolRegistry; each subagent receives a filtered view.
   * @param llm               Optional LLM instance — injected for tests, created from config otherwise.
   */
  constructor(
    private readonly concurrencyLimit: number,
    private readonly registry: ToolRegistry,
    private readonly llm?: BaseChatModel
  ) {}

  /**
   * Run a subagent.  Waits for a concurrency slot before starting when the
   * limit is already reached; the slot is released automatically on completion.
   */
  async run(definition: SubagentDefinition, task: string): Promise<SubagentResult> {
    await this.acquire();

    logger.info({ subagent: definition.name }, "Subagent starting");
    try {
      const result = await runSubagent(definition, task, this.registry, this.llm);
      logger.info(
        { subagent: definition.name, iterations: result.iterations },
        "Subagent completed"
      );
      return result;
    } finally {
      this.release();
    }
  }

  /**
   * Run multiple subagents in parallel using Promise.allSettled.
   *
   * The concurrency limit is still enforced — tasks beyond the limit queue
   * behind running ones and start automatically as slots become available.
   * After all tasks settle, overlapping file mutations are flagged as conflicts.
   *
   * @param tasks  Array of { definition, task } pairs to execute concurrently.
   * @returns Aggregated results plus any detected file-write conflicts.
   */
  async runParallel(tasks: ParallelTask[]): Promise<ParallelResult> {
    // Fire all subagents concurrently; acquire/release enforces the concurrency cap
    const settled = await Promise.allSettled(
      tasks.map(({ definition, task }) => this.run(definition, task))
    );

    // Map each settled outcome to a result entry
    const results: ParallelResult["results"] = settled.map((outcome, i) => {
      if (outcome.status === "fulfilled") return outcome.value;
      return {
        name: tasks[i].definition.name,
        error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
      };
    });

    // Detect conflicts: files modified by more than one subagent
    const fileToAgents = new Map<string, string[]>();
    for (const result of results) {
      if ("filesModified" in result) {
        for (const file of result.filesModified) {
          const agents = fileToAgents.get(file) ?? [];
          agents.push(result.name);
          fileToAgents.set(file, agents);
        }
      }
    }

    const conflicts: ConflictInfo[] = [];
    for (const [file, agents] of fileToAgents) {
      if (agents.length > 1) {
        conflicts.push({ file, agents });
        logger.warn({ file, agents }, "File conflict detected in parallel subagents");
      }
    }

    return { results, conflicts };
  }

  /** Wait until a concurrency slot is available, then claim it. */
  private acquire(): Promise<void> {
    if (this.running < this.concurrencyLimit) {
      this.running++;
      return Promise.resolve();
    }
    // Queue this caller until a slot is released
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  /**
   * Release the current slot.
   * If there are queued callers, the next one inherits the slot without
   * decrementing `running`, keeping the counter accurate.
   */
  private release(): void {
    const next = this.queue.shift();
    if (next) {
      // Hand the slot directly to the next waiter — running count stays the same
      next();
    } else {
      this.running--;
    }
  }
}
