/**
 * Tests for the LangGraphJS orchestrator.
 *
 * Covers:
 * - BlocksPlan validation & parsing
 * - compileBlocksPlanToDag (sequential, parallel, nested)
 * - Scheduler: runnable selection with dependencies + resources
 * - Scheduler: join:any cancellation semantics
 * - Merge of completed state across replans (compile node preserves completed)
 * - Integration: planner → parallel race → cancellation (MockChatModel)
 * - Integration: forced failure → replan → completion
 * - Failure strategy transitions (retry, skip, abort)
 */

import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

import { validateBlocksPlan, compileBlocksPlanToDag } from "../langgraph/compiler";
import {
  selectRunnable,
  getCancellableForRace,
  isAllDone,
  isDeadlocked,
} from "../langgraph/scheduler";
import { buildGraphNodes, invokeGraph } from "../langgraph/graph";
import { runPlannedStep } from "../langgraph/step-runner";
import type {
  BlocksPlan,
  CompiledPlan,
  CompiledPlanNode,
  NodeRecord,
  GraphState,
  GraphEvent,
} from "../langgraph/types";
import { ToolRegistry } from "../tools/registry";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Create a mock LLM that returns specified content on successive invoke() calls. */
function makeMockLlm(...responses: string[]): BaseChatModel {
  let callIndex = 0;
  const invoke = jest.fn().mockImplementation(() => {
    const content = responses[callIndex] ?? responses[responses.length - 1];
    callIndex++;
    return Promise.resolve({ content, tool_calls: [] });
  });
  return {
    invoke,
    bindTools: jest.fn().mockReturnValue({ invoke }),
  } as unknown as BaseChatModel;
}

/** A simple sequential BlocksPlan for testing. */
function makeSimplePlan(): BlocksPlan {
  return {
    version: "2.0",
    goal: "test goal",
    blocks: [
      { type: "step", description: "step one", toolsNeeded: [], estimatedComplexity: "low" },
      { type: "step", description: "step two", toolsNeeded: ["search"], estimatedComplexity: "medium" },
    ],
  };
}

/** A plan with parallel branches (join:all). */
function makeParallelAllPlan(): BlocksPlan {
  return {
    version: "2.0",
    goal: "parallel all goal",
    blocks: [
      { type: "step", description: "setup", toolsNeeded: [], estimatedComplexity: "low" },
      {
        type: "parallel",
        join: "all",
        branches: [
          { name: "branch-a", blocks: [{ type: "step", description: "task A", toolsNeeded: [], estimatedComplexity: "low" }] },
          { name: "branch-b", blocks: [{ type: "step", description: "task B", toolsNeeded: [], estimatedComplexity: "low" }] },
        ],
      },
      { type: "step", description: "finalize", toolsNeeded: [], estimatedComplexity: "low" },
    ],
  };
}

/** A plan with a parallel race (join:any). */
function makeParallelAnyPlan(): BlocksPlan {
  return {
    version: "2.0",
    goal: "parallel race goal",
    blocks: [
      {
        type: "parallel",
        join: "any",
        branches: [
          { name: "fast", blocks: [{ type: "step", description: "fast path", toolsNeeded: [], estimatedComplexity: "low" }] },
          { name: "slow", blocks: [{ type: "step", description: "slow path", toolsNeeded: [], estimatedComplexity: "high" }] },
        ],
      },
    ],
  };
}

/** A plan with resource hints for testing scheduler constraints. */
function makeResourcePlan(): BlocksPlan {
  return {
    version: "2.0",
    goal: "resource plan",
    blocks: [
      {
        type: "parallel",
        join: "all",
        branches: [
          { name: "writer1", blocks: [{ type: "step", description: "write to file A", toolsNeeded: [], estimatedComplexity: "low", resources: ["file:WRITE:src/a.ts"] }] },
          { name: "writer2", blocks: [{ type: "step", description: "also writes file A", toolsNeeded: [], estimatedComplexity: "low", resources: ["file:WRITE:src/a.ts"] }] },
          { name: "net1", blocks: [{ type: "step", description: "fetch data", toolsNeeded: ["search"], estimatedComplexity: "low", resources: ["network"] }] },
          { name: "net2", blocks: [{ type: "step", description: "fetch more data", toolsNeeded: ["search"], estimatedComplexity: "low", resources: ["network"] }] },
          { name: "net3", blocks: [{ type: "step", description: "fetch even more", toolsNeeded: ["search"], estimatedComplexity: "low", resources: ["network"] }] },
        ],
      },
    ],
  };
}

/** Build a default GraphState for testing graph nodes. */
function makeDefaultState(overrides: Partial<GraphState> = {}): GraphState {
  return {
    request: "test request",
    plan: null,
    compiledPlan: null,
    records: {},
    lastBatchIds: [],
    onFailure: "retry",
    replanRequested: false,
    replanReason: "",
    replanCount: 0,
    maxReplans: 3,
    maxRefinements: 3,
    maxConcurrency: 4,
    networkConcurrency: 2,
    output: "",
    done: false,
    fatalError: "",
    events: [],
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// (1) BlocksPlan validation
// ─────────────────────────────────────────────────────────────────────────────

describe("validateBlocksPlan", () => {
  it("accepts a valid simple plan", () => {
    expect(() => validateBlocksPlan(makeSimplePlan())).not.toThrow();
  });

  it("accepts a valid parallel plan", () => {
    expect(() => validateBlocksPlan(makeParallelAllPlan())).not.toThrow();
  });

  it("rejects a plan with wrong version", () => {
    expect(() => validateBlocksPlan({ version: "1.0", goal: "x", blocks: [{ type: "step", description: "d", toolsNeeded: [] }] }))
      .toThrow(/version/i);
  });

  it("rejects a plan with no blocks", () => {
    expect(() => validateBlocksPlan({ version: "2.0", goal: "x", blocks: [] }))
      .toThrow(/at least one block/i);
  });

  it("rejects a step with empty description", () => {
    expect(() => validateBlocksPlan({ version: "2.0", goal: "x", blocks: [{ type: "step", description: "", toolsNeeded: [] }] }))
      .toThrow(/description/i);
  });

  it("rejects a parallel with no branches", () => {
    expect(() => validateBlocksPlan({ version: "2.0", goal: "x", blocks: [{ type: "parallel", join: "all", branches: [] }] }))
      .toThrow(/at least one branch/i);
  });

  it("rejects unknown block type", () => {
    expect(() => validateBlocksPlan({ version: "2.0", goal: "x", blocks: [{ type: "unknown" }] }))
      .toThrow(/unknown block type/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (2) compileBlocksPlanToDag
// ─────────────────────────────────────────────────────────────────────────────

describe("compileBlocksPlanToDag", () => {
  it("compiles a sequential plan into chained nodes", () => {
    const plan = makeSimplePlan();
    const dag = compileBlocksPlanToDag(plan);
    const nodeIds = Object.keys(dag.nodes);

    expect(nodeIds.length).toBe(2);
    // First node has no dependencies
    const first = dag.nodes[nodeIds[0]];
    expect(first.dependsOn).toEqual([]);
    // Second node depends on first
    const second = dag.nodes[nodeIds[1]];
    expect(second.dependsOn).toEqual([nodeIds[0]]);
  });

  it("compiles a parallel-all plan with fork/join", () => {
    const plan = makeParallelAllPlan();
    const dag = compileBlocksPlanToDag(plan);
    const nodeIds = Object.keys(dag.nodes);

    // Should have: setup, branch-a step, branch-b step, join, finalize = 5 nodes
    expect(nodeIds.length).toBe(5);

    // Find the join node
    const joinNode = Object.values(dag.nodes).find((n) => n.joinGroup?.kind === "all");
    expect(joinNode).toBeDefined();
    expect(joinNode!.dependsOn.length).toBe(2); // both branches

    // Find the finalize node (depends on join)
    const finalNode = Object.values(dag.nodes).find((n) => n.description === "finalize");
    expect(finalNode).toBeDefined();
    expect(finalNode!.dependsOn).toContain(joinNode!.id);
  });

  it("compiles a parallel-any plan with race join", () => {
    const plan = makeParallelAnyPlan();
    const dag = compileBlocksPlanToDag(plan);

    const joinNode = Object.values(dag.nodes).find((n) => n.joinGroup?.kind === "any");
    expect(joinNode).toBeDefined();
    expect(joinNode!.dependsOn.length).toBe(2); // both branches
  });

  it("normalises resource hints to lowercase", () => {
    const plan: BlocksPlan = {
      version: "2.0",
      goal: "test",
      blocks: [
        { type: "step", description: "x", toolsNeeded: [], estimatedComplexity: "low", resources: ["NETWORK", "File:WRITE:Foo.ts"] },
      ],
    };
    const dag = compileBlocksPlanToDag(plan);
    const node = Object.values(dag.nodes)[0];
    expect(node.resources).toEqual(["network", "file:write:foo.ts"]);
  });

  it("handles nested parallel blocks", () => {
    const plan: BlocksPlan = {
      version: "2.0",
      goal: "nested",
      blocks: [
        {
          type: "parallel",
          join: "all",
          branches: [
            {
              name: "outer-a",
              blocks: [
                { type: "step", description: "outer-a step", toolsNeeded: [], estimatedComplexity: "low" },
                {
                  type: "parallel",
                  join: "any",
                  branches: [
                    { name: "inner-x", blocks: [{ type: "step", description: "inner-x step", toolsNeeded: [], estimatedComplexity: "low" }] },
                    { name: "inner-y", blocks: [{ type: "step", description: "inner-y step", toolsNeeded: [], estimatedComplexity: "low" }] },
                  ],
                },
              ],
            },
            { name: "outer-b", blocks: [{ type: "step", description: "outer-b step", toolsNeeded: [], estimatedComplexity: "low" }] },
          ],
        },
      ],
    };
    const dag = compileBlocksPlanToDag(plan);
    // outer-a step, inner-x, inner-y, inner-join, outer-b, outer-join = 6
    expect(Object.keys(dag.nodes).length).toBe(6);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (3) Scheduler: runnable selection
// ─────────────────────────────────────────────────────────────────────────────

describe("selectRunnable", () => {
  it("selects nodes with no dependencies first", () => {
    const plan = compileBlocksPlanToDag(makeSimplePlan());
    const nodeIds = Object.keys(plan.nodes);
    const records: Record<string, NodeRecord> = {};
    for (const id of nodeIds) {
      records[id] = { nodeId: id, status: "pending", retryCount: 0 };
    }

    const runnable = selectRunnable(plan, records, { maxConcurrency: 4, networkConcurrency: 2 });
    expect(runnable).toEqual([nodeIds[0]]); // only the first (no deps)
  });

  it("selects second node after first completes", () => {
    const plan = compileBlocksPlanToDag(makeSimplePlan());
    const nodeIds = Object.keys(plan.nodes);
    const records: Record<string, NodeRecord> = {
      [nodeIds[0]]: { nodeId: nodeIds[0], status: "success", retryCount: 0 },
      [nodeIds[1]]: { nodeId: nodeIds[1], status: "pending", retryCount: 0 },
    };

    const runnable = selectRunnable(plan, records, { maxConcurrency: 4, networkConcurrency: 2 });
    expect(runnable).toContain(nodeIds[1]);
  });

  it("selects parallel branches simultaneously", () => {
    const plan = compileBlocksPlanToDag(makeParallelAllPlan());
    const nodeIds = Object.keys(plan.nodes);
    const records: Record<string, NodeRecord> = {};
    for (const id of nodeIds) {
      records[id] = { nodeId: id, status: "pending", retryCount: 0 };
    }
    // Mark setup as done
    const setupId = nodeIds[0]; // first node is setup
    records[setupId] = { nodeId: setupId, status: "success", retryCount: 0 };

    const runnable = selectRunnable(plan, records, { maxConcurrency: 4, networkConcurrency: 2 });
    // Should select both branch nodes (they depend only on setup)
    expect(runnable.length).toBe(2);
  });

  it("respects maxConcurrency limit", () => {
    const plan = compileBlocksPlanToDag(makeParallelAllPlan());
    const nodeIds = Object.keys(plan.nodes);
    const records: Record<string, NodeRecord> = {};
    for (const id of nodeIds) {
      records[id] = { nodeId: id, status: "pending", retryCount: 0 };
    }
    records[nodeIds[0]] = { nodeId: nodeIds[0], status: "success", retryCount: 0 };

    const runnable = selectRunnable(plan, records, { maxConcurrency: 1, networkConcurrency: 2 });
    expect(runnable.length).toBeLessThanOrEqual(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (3b) Scheduler: resource constraints
// ─────────────────────────────────────────────────────────────────────────────

describe("selectRunnable — resource constraints", () => {
  it("prevents concurrent writes to the same file", () => {
    const plan = compileBlocksPlanToDag(makeResourcePlan());
    const records: Record<string, NodeRecord> = {};
    for (const id of Object.keys(plan.nodes)) {
      records[id] = { nodeId: id, status: "pending", retryCount: 0 };
    }

    const runnable = selectRunnable(plan, records, { maxConcurrency: 10, networkConcurrency: 10 });
    // writer1 and writer2 both write src/a.ts — only one should be selected
    const writers = runnable.filter((id) => {
      const node = plan.nodes[id];
      return node.resources.some((r) => r.includes("file:write:src/a.ts"));
    });
    expect(writers.length).toBeLessThanOrEqual(1);
  });

  it("respects network concurrency quota", () => {
    const plan = compileBlocksPlanToDag(makeResourcePlan());
    const records: Record<string, NodeRecord> = {};
    for (const id of Object.keys(plan.nodes)) {
      records[id] = { nodeId: id, status: "pending", retryCount: 0 };
    }

    const runnable = selectRunnable(plan, records, { maxConcurrency: 10, networkConcurrency: 2 });
    const netNodes = runnable.filter((id) => plan.nodes[id].resources.includes("network"));
    expect(netNodes.length).toBeLessThanOrEqual(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (4) Join:any cancellation
// ─────────────────────────────────────────────────────────────────────────────

describe("getCancellableForRace", () => {
  it("returns pending branch nodes when one branch succeeds in join:any", () => {
    const plan = compileBlocksPlanToDag(makeParallelAnyPlan());
    const nodeIds = Object.keys(plan.nodes);

    // Find the branch nodes and join
    const branchNodes = Object.values(plan.nodes).filter((n) => n.branch);
    const joinNode = Object.values(plan.nodes).find((n) => n.joinGroup?.kind === "any");

    expect(branchNodes.length).toBe(2);
    expect(joinNode).toBeDefined();

    // Mark first branch as success, second still pending
    const records: Record<string, NodeRecord> = {};
    for (const id of nodeIds) {
      records[id] = { nodeId: id, status: "pending", retryCount: 0 };
    }
    records[branchNodes[0].id] = { nodeId: branchNodes[0].id, status: "success", retryCount: 0 };

    const toCancel = getCancellableForRace(plan, records);
    expect(toCancel.length).toBe(1);
    expect(toCancel[0]).toBe(branchNodes[1].id);
  });

  it("returns empty when no race join is ready", () => {
    const plan = compileBlocksPlanToDag(makeParallelAnyPlan());
    const records: Record<string, NodeRecord> = {};
    for (const id of Object.keys(plan.nodes)) {
      records[id] = { nodeId: id, status: "pending", retryCount: 0 };
    }
    expect(getCancellableForRace(plan, records)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (5) isAllDone / isDeadlocked
// ─────────────────────────────────────────────────────────────────────────────

describe("isAllDone / isDeadlocked", () => {
  it("returns true when all nodes are terminal", () => {
    const records: Record<string, NodeRecord> = {
      a: { nodeId: "a", status: "success", retryCount: 0 },
      b: { nodeId: "b", status: "skipped", retryCount: 0 },
      c: { nodeId: "c", status: "cancelled", retryCount: 0 },
    };
    expect(isAllDone(records)).toBe(true);
  });

  it("returns false when some nodes are pending", () => {
    const records: Record<string, NodeRecord> = {
      a: { nodeId: "a", status: "success", retryCount: 0 },
      b: { nodeId: "b", status: "pending", retryCount: 0 },
    };
    expect(isAllDone(records)).toBe(false);
  });

  it("detects deadlock when no nodes are runnable and none running", () => {
    // Create a plan with circular-like unreachable deps
    const plan: CompiledPlan = {
      nodes: {
        a: { id: "a", description: "a", dependsOn: ["b"], toolsNeeded: [], estimatedComplexity: "low", resources: [] },
        b: { id: "b", description: "b", dependsOn: ["a"], toolsNeeded: [], estimatedComplexity: "low", resources: [] },
      },
    };
    const records: Record<string, NodeRecord> = {
      a: { nodeId: "a", status: "pending", retryCount: 0 },
      b: { nodeId: "b", status: "pending", retryCount: 0 },
    };
    expect(isDeadlocked(plan, records, { maxConcurrency: 4, networkConcurrency: 2 })).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (6) Merge of completed state across replans
// ─────────────────────────────────────────────────────────────────────────────

describe("compile node — preserves completed records across replans", () => {
  it("retains successful records when recompiling a new plan", () => {
    const registry = new ToolRegistry();
    const deps = { registry };
    const nodes = buildGraphNodes(deps);

    // Simulate: first plan had node "s1" completed
    const existingRecords: Record<string, NodeRecord> = {
      s1: { nodeId: "s1", status: "success", output: "done", retryCount: 0 },
    };

    // New plan has s1 and s2
    const plan: BlocksPlan = {
      version: "2.0",
      goal: "test",
      blocks: [
        { type: "step", id: "s1", description: "step one", toolsNeeded: [], estimatedComplexity: "low" },
        { type: "step", id: "s2", description: "step two", toolsNeeded: [], estimatedComplexity: "low" },
      ],
    };

    const state = makeDefaultState({ plan, records: existingRecords });
    const result = nodes.compileNode(state);

    expect(result.records!["s1"].status).toBe("success"); // preserved
    expect(result.records!["s2"].status).toBe("pending");  // new node
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (7) Failure strategy transitions
// ─────────────────────────────────────────────────────────────────────────────

describe("handle_outcomes — failure strategies", () => {
  const registry = new ToolRegistry();

  it("retry: re-queues a failed node once", () => {
    const nodes = buildGraphNodes({ registry });
    const plan = compileBlocksPlanToDag(makeSimplePlan());
    const nodeIds = Object.keys(plan.nodes);

    const records: Record<string, NodeRecord> = {
      [nodeIds[0]]: { nodeId: nodeIds[0], status: "failed", error: "boom", retryCount: 0 },
      [nodeIds[1]]: { nodeId: nodeIds[1], status: "pending", retryCount: 0 },
    };

    const state = makeDefaultState({
      compiledPlan: plan,
      records,
      lastBatchIds: [nodeIds[0]],
      onFailure: "retry",
    });

    const result = nodes.handleOutcomesNode(state);
    expect(result.records![nodeIds[0]].status).toBe("pending"); // re-queued
    expect(result.records![nodeIds[0]].retryCount).toBe(1);
  });

  it("skip: marks a failed node as skipped", () => {
    const nodes = buildGraphNodes({ registry });
    const plan = compileBlocksPlanToDag(makeSimplePlan());
    const nodeIds = Object.keys(plan.nodes);

    const records: Record<string, NodeRecord> = {
      [nodeIds[0]]: { nodeId: nodeIds[0], status: "failed", error: "boom", retryCount: 0 },
      [nodeIds[1]]: { nodeId: nodeIds[1], status: "pending", retryCount: 0 },
    };

    const state = makeDefaultState({
      compiledPlan: plan,
      records,
      lastBatchIds: [nodeIds[0]],
      onFailure: "skip",
    });

    const result = nodes.handleOutcomesNode(state);
    expect(result.records![nodeIds[0]].status).toBe("skipped");
  });

  it("abort: sets done=true and fatalError", () => {
    const nodes = buildGraphNodes({ registry });
    const plan = compileBlocksPlanToDag(makeSimplePlan());
    const nodeIds = Object.keys(plan.nodes);

    const records: Record<string, NodeRecord> = {
      [nodeIds[0]]: { nodeId: nodeIds[0], status: "failed", error: "boom", retryCount: 0 },
      [nodeIds[1]]: { nodeId: nodeIds[1], status: "pending", retryCount: 0 },
    };

    const state = makeDefaultState({
      compiledPlan: plan,
      records,
      lastBatchIds: [nodeIds[0]],
      onFailure: "abort",
    });

    const result = nodes.handleOutcomesNode(state);
    expect(result.done).toBe(true);
    expect(result.fatalError).toContain("abort");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (8) Handle outcomes — join:any cancellation in full flow
// ─────────────────────────────────────────────────────────────────────────────

describe("handle_outcomes — join:any cancellation", () => {
  it("cancels remaining branches when one succeeds in a race", () => {
    const registry = new ToolRegistry();
    const nodes = buildGraphNodes({ registry });
    const plan = compileBlocksPlanToDag(makeParallelAnyPlan());
    const nodeIds = Object.keys(plan.nodes);

    const branchNodes = Object.values(plan.nodes).filter((n) => n.branch);

    const records: Record<string, NodeRecord> = {};
    for (const id of nodeIds) {
      records[id] = { nodeId: id, status: "pending", retryCount: 0 };
    }
    // First branch succeeded
    records[branchNodes[0].id] = { nodeId: branchNodes[0].id, status: "success", retryCount: 0 };

    const state = makeDefaultState({
      compiledPlan: plan,
      records,
      lastBatchIds: [branchNodes[0].id],
      onFailure: "retry",
    });

    const result = nodes.handleOutcomesNode(state);
    // Second branch should be cancelled
    expect(result.records![branchNodes[1].id].status).toBe("cancelled");
    // Should have a parallel_race_won event
    expect(result.events!.some((e: GraphEvent) => e.type === "parallel_race_won")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (9) Integration: graphExecutor.invoke with MockChatModel
// ─────────────────────────────────────────────────────────────────────────────

describe("invokeGraph — integration with mock LLM", () => {
  it("runs a simple 2-step plan end-to-end", async () => {
    const planJson = JSON.stringify({
      version: "2.0",
      goal: "test",
      blocks: [
        { type: "step", description: "do thing 1", toolsNeeded: [], estimatedComplexity: "low" },
        { type: "step", description: "do thing 2", toolsNeeded: [], estimatedComplexity: "low" },
      ],
    });
    const workspaceCtxJson = JSON.stringify({
      workspaceInfo: { language: "node", framework: "none", packageManager: "npm", hasTests: true, testCommand: "", lintCommand: "", buildCommand: "", entryPoints: [], gitInitialized: true },
    });

    // Mock: explorer returns workspace context, planner returns the plan, then each step returns "done"
    const llm = makeMockLlm(workspaceCtxJson, planJson, "step 1 done", "step 2 done");
    const registry = new ToolRegistry();

    const events: GraphEvent[] = [];
    const result = await invokeGraph("do two things", { registry, llm }, {
      progress: (evt) => events.push(evt),
    });

    expect(result.output).toContain("Completed");
    expect(result.trace).toBeDefined();
    expect(result.trace!.events.length).toBeGreaterThan(0);
    // Should have plan_created event
    expect(result.trace!.events.some((e) => e.type === "plan_created")).toBe(true);
    // Should have step_succeeded events
    expect(result.trace!.events.filter((e) => e.type === "step_succeeded").length).toBeGreaterThanOrEqual(2);
  }, 30000);

  it("handles parallel race: first success cancels remaining", async () => {
    const planJson = JSON.stringify({
      version: "2.0",
      goal: "race test",
      blocks: [
        {
          type: "parallel",
          join: "any",
          branches: [
            { name: "fast", blocks: [{ type: "step", description: "fast branch", toolsNeeded: [], estimatedComplexity: "low" }] },
            { name: "slow", blocks: [{ type: "step", description: "slow branch", toolsNeeded: [], estimatedComplexity: "low" }] },
          ],
        },
      ],
    });
    const workspaceCtxJson = JSON.stringify({
      workspaceInfo: { language: "node", framework: "none", packageManager: "npm", hasTests: true, testCommand: "", lintCommand: "", buildCommand: "", entryPoints: [], gitInitialized: true },
    });

    // Explorer → workspace context; planner → plan; steps → results
    const llm = makeMockLlm(workspaceCtxJson, planJson, "fast wins!", "slow result");
    const registry = new ToolRegistry();

    // maxConcurrency=1 forces sequential execution: first branch completes,
    // then handle_outcomes cancels the remaining pending branch before it runs
    const result = await invokeGraph("race it", { registry, llm }, { maxConcurrency: 1 });

    expect(result.output).toContain("Completed");
    // Should have cancellation events
    const cancelEvents = result.trace!.events.filter((e) => e.type === "step_cancelled");
    expect(cancelEvents.length).toBeGreaterThanOrEqual(1);
  }, 30000);

  it("abort policy stops execution on first failure", async () => {
    // Plan returns a valid plan, but step execution will fail
    const planJson = JSON.stringify({
      version: "2.0",
      goal: "fail test",
      blocks: [
        { type: "step", description: "will fail", toolsNeeded: [], estimatedComplexity: "low" },
      ],
    });
    const workspaceCtxJson = JSON.stringify({
      workspaceInfo: { language: "node", framework: "none", packageManager: "npm", hasTests: true, testCommand: "", lintCommand: "", buildCommand: "", entryPoints: [], gitInitialized: true },
    });

    // Explorer returns workspace context (call 1); planner returns plan (call 2); step throws (call 3+)
    let callCount = 0;
    const invoke = jest.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        // Project-explorer call: return workspace context
        return Promise.resolve({ content: workspaceCtxJson, tool_calls: [] });
      }
      if (callCount === 2) {
        // Planner call: return the plan
        return Promise.resolve({ content: planJson, tool_calls: [] });
      }
      // Step execution: throw to simulate failure
      return Promise.reject(new Error("LLM unavailable"));
    });
    const llm = {
      invoke,
      bindTools: jest.fn().mockReturnValue({ invoke }),
    } as unknown as BaseChatModel;

    const registry = new ToolRegistry();
    const result = await invokeGraph("fail", { registry, llm }, { onFailure: "abort" });

    expect(result.output).toContain("failed");
  }, 30000);
});

// ─────────────────────────────────────────────────────────────────────────────
// (10) Finalize node
// ─────────────────────────────────────────────────────────────────────────────

describe("finalize node", () => {
  it("produces summary with success count", () => {
    const registry = new ToolRegistry();
    const nodes = buildGraphNodes({ registry });

    const records: Record<string, NodeRecord> = {
      s1: { nodeId: "s1", status: "success", output: "result 1", retryCount: 0 },
      s2: { nodeId: "s2", status: "success", output: "result 2", retryCount: 0 },
    };

    const state = makeDefaultState({ records });
    const result = nodes.finalizeNode(state);

    expect(result.output).toContain("Completed 2 step(s)");
    expect(result.done).toBe(true);
  });

  it("includes fatalError in output when present", () => {
    const registry = new ToolRegistry();
    const nodes = buildGraphNodes({ registry });

    const state = makeDefaultState({ fatalError: "Something broke", records: {} });
    const result = nodes.finalizeNode(state);

    expect(result.output).toContain("failed");
    expect(result.output).toContain("Something broke");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (11) runPlannedStep — originalRequest grounding
// ─────────────────────────────────────────────────────────────────────────────

describe("runPlannedStep — original request grounding", () => {
  /** Minimal CompiledPlanNode for unit tests. */
  function makeNode(overrides: Partial<CompiledPlanNode> = {}): CompiledPlanNode {
    return {
      id: "s1",
      description: "Clone the repository locally",
      dependsOn: [],
      toolsNeeded: [],
      estimatedComplexity: "low",
      resources: [],
      ...overrides,
    };
  }

  it("includes originalRequest in the step system prompt when provided", async () => {
    let capturedSystemPrompt = "";

    const invoke = jest.fn().mockImplementation(() => {
      return Promise.resolve({ content: "done", tool_calls: [] });
    });
    const bindTools = jest.fn().mockImplementation((_tools: unknown, opts?: { tool_choice?: string }) => {
      // Capture the system prompt from whatever call is made
      return {
        invoke: jest.fn().mockImplementation((messages: unknown[]) => {
          if (Array.isArray(messages)) {
            const systemMsg = (messages as Array<{ _getType?: () => string; content?: string }>)
              .find((m) => m._getType?.() === "system");
            if (systemMsg?.content) capturedSystemPrompt = systemMsg.content as string;
          }
          return Promise.resolve({ content: "done", tool_calls: [] });
        }),
      };
    });

    const llm = { invoke, bindTools } as unknown as BaseChatModel;
    const registry = new ToolRegistry();
    const node = makeNode();

    await runPlannedStep(node, {
      registry,
      llm,
      originalRequest: "add Anthropic models to github repo huberp/agentloop",
    });

    // The system prompt passed to runSubagent must contain the original request
    expect(capturedSystemPrompt).toContain("add Anthropic models to github repo huberp/agentloop");
    expect(capturedSystemPrompt).toContain("Original user request (for context):");
  });

  it("omits the original-request line when originalRequest is not provided", async () => {
    let capturedSystemPrompt = "";

    const bindTools = jest.fn().mockImplementation(() => ({
      invoke: jest.fn().mockImplementation((messages: unknown[]) => {
        if (Array.isArray(messages)) {
          const systemMsg = (messages as Array<{ _getType?: () => string; content?: string }>)
            .find((m) => m._getType?.() === "system");
          if (systemMsg?.content) capturedSystemPrompt = systemMsg.content as string;
        }
        return Promise.resolve({ content: "done", tool_calls: [] });
      }),
    }));

    const llm = {
      invoke: jest.fn().mockResolvedValue({ content: "done", tool_calls: [] }),
      bindTools,
    } as unknown as BaseChatModel;
    const registry = new ToolRegistry();
    const node = makeNode();

    await runPlannedStep(node, { registry, llm });

    expect(capturedSystemPrompt).not.toContain("Original user request (for context):");
  });

  it("propagates request from state.request via invokeGraph", async () => {
    const capturedSystemPrompts: string[] = [];

    const planJson = JSON.stringify({
      version: "2.0",
      goal: "clone test",
      blocks: [
        { type: "step", description: "Clone the forked repository locally to the workspace", toolsNeeded: [], estimatedComplexity: "low" },
      ],
    });
    const workspaceCtxJson = JSON.stringify({
      workspaceInfo: { language: "node", framework: "none", packageManager: "npm", hasTests: true, testCommand: "", lintCommand: "", buildCommand: "", entryPoints: [], gitInitialized: true },
    });

    // Capture all system prompts seen during execution
    let callCount = 0;
    const invoke = jest.fn().mockImplementation((messages: unknown[]) => {
      callCount++;
      if (Array.isArray(messages)) {
        const systemMsg = (messages as Array<{ _getType?: () => string; content?: string }>)
          .find((m) => m._getType?.() === "system");
        if (systemMsg?.content) capturedSystemPrompts.push(systemMsg.content as string);
      }
      if (callCount === 1) return Promise.resolve({ content: workspaceCtxJson, tool_calls: [] });
      if (callCount === 2) return Promise.resolve({ content: planJson, tool_calls: [] });
      return Promise.resolve({ content: "cloned successfully", tool_calls: [] });
    });
    const llm = {
      invoke,
      bindTools: jest.fn().mockImplementation(() => ({ invoke })),
    } as unknown as BaseChatModel;

    const registry = new ToolRegistry();
    await invokeGraph(
      "add Anthropic models to github repo huberp/agentloop",
      { registry, llm },
    );

    // At least one system prompt (from the step subagent) must contain the original request
    const stepPrompts = capturedSystemPrompts.filter((p) =>
      p.includes("executing one step of a larger plan"),
    );
    expect(stepPrompts.length).toBeGreaterThan(0);
    expect(stepPrompts[0]).toContain("add Anthropic models to github repo huberp/agentloop");
  }, 30000);
});
