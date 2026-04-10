/**
 * Public entry point for the LangGraphJS-based orchestrator.
 *
 * Exports `graphExecutor` with an `invoke` method analogous to `agentExecutor.invoke`,
 * plus all relevant types for consumers.
 */

export type {
  BlocksPlan,
  PlanBlock,
  StepBlock,
  ParallelBlock,
  CompiledPlan,
  CompiledPlanNode,
  StepExecResult,
  NodeRecord,
  GraphState,
  GraphEvent,
  GraphEventType,
  GraphTrace,
  GraphInvokeOptions,
} from "./types";

export { validateBlocksPlan, compileBlocksPlanToDag } from "./compiler";
export { selectRunnable, getCancellableForRace, isAllDone, isDeadlocked } from "./scheduler";
export { runPlannedStep } from "./step-runner";
export { buildGraph, invokeGraph } from "./graph";

import { ToolRegistry } from "../tools/registry";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { AgentProfileRegistry } from "../agents/registry";
import { invokeGraph } from "./graph";
import type { GraphInvokeOptions, GraphTrace } from "./types";

/**
 * Primary public API for the LangGraphJS orchestrator.
 *
 * Usage:
 * ```ts
 * import { graphExecutor } from "./langgraph";
 * const result = await graphExecutor.invoke("Build me a REST API", {
 *   onFailure: "retry",
 *   maxReplans: 3,
 *   progress: (evt) => console.log(evt),
 * });
 * ```
 */
export const graphExecutor = {
  /**
   * Plan and execute a request using the LangGraphJS orchestration graph.
   *
   * @param request  Natural-language task description.
   * @param opts     Execution options (failure strategy, concurrency, progress callback).
   * @param deps     Optional overrides for registry, LLM, and profile registry.
   * @returns        Promise with output string and optional trace.
   */
  invoke: async (
    request: string,
    opts?: GraphInvokeOptions,
    deps?: {
      registry?: ToolRegistry;
      llm?: BaseChatModel;
      profileRegistry?: AgentProfileRegistry;
    },
  ): Promise<{ output: string; trace?: GraphTrace }> => {
    // Use the provided registry or create a default one
    const registry = deps?.registry ?? new ToolRegistry();
    return invokeGraph(request, {
      registry,
      llm: deps?.llm,
      profileRegistry: deps?.profileRegistry,
    }, opts);
  },
};
