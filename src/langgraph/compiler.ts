/**
 * Plan compiler — converts a BlocksPlan into a DAG (CompiledPlan).
 *
 * Responsibilities:
 * - Assign stable IDs to every node using path notation (e.g. "s1", "p2.b0.s1")
 * - Flatten sequential and parallel blocks into a flat node map
 * - Track fork/join dependencies between parallel branches
 * - Normalise resource hints
 */

import type {
  BlocksPlan,
  PlanBlock,
  CompiledPlan,
  CompiledPlanNode,
  ParallelBlock,
  StepBlock,
} from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────────────────────────────────────

/** Validate a BlocksPlan structurally. Throws on invalid input. */
export function validateBlocksPlan(plan: unknown): asserts plan is BlocksPlan {
  if (typeof plan !== "object" || plan === null) {
    throw new Error("Plan must be a non-null object");
  }
  const p = plan as Record<string, unknown>;
  if (p.version !== "2.0") {
    throw new Error(`Unsupported plan version: ${String(p.version)}`);
  }
  if (typeof p.goal !== "string" || p.goal.trim() === "") {
    throw new Error("Plan must have a non-empty goal");
  }
  if (!Array.isArray(p.blocks) || p.blocks.length === 0) {
    throw new Error("Plan must have at least one block");
  }
  for (const block of p.blocks as unknown[]) {
    validateBlock(block);
  }
}

function validateBlock(block: unknown): void {
  if (typeof block !== "object" || block === null) {
    throw new Error("Block must be a non-null object");
  }
  const b = block as Record<string, unknown>;
  if (b.type === "step") {
    if (typeof b.description !== "string" || b.description.trim() === "") {
      throw new Error("Step block must have a non-empty description");
    }
  } else if (b.type === "parallel") {
    if (!Array.isArray(b.branches) || b.branches.length === 0) {
      throw new Error("Parallel block must have at least one branch");
    }
    for (const branch of b.branches as unknown[]) {
      if (typeof branch !== "object" || branch === null) {
        throw new Error("Branch must be a non-null object");
      }
      const br = branch as Record<string, unknown>;
      if (!Array.isArray(br.blocks)) {
        throw new Error("Branch must have a blocks array");
      }
      for (const sub of br.blocks as unknown[]) {
        validateBlock(sub);
      }
    }
  } else {
    throw new Error(`Unknown block type: ${String(b.type)}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Compilation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compile a BlocksPlan into a flat DAG of CompiledPlanNodes.
 *
 * Sequential blocks become nodes chained by dependsOn edges.
 * Parallel blocks create a fork (all branches depend on the prior node)
 * and a synthetic join node that depends on all branch tails.
 */
export function compileBlocksPlanToDag(plan: BlocksPlan): CompiledPlan {
  const nodes: Record<string, CompiledPlanNode> = {};
  let stepCounter = 0;
  let parallelCounter = 0;

  /**
   * Process a list of blocks at a given prefix path, returning the IDs of
   * all "tail" nodes (last nodes) from the sequence.
   *
   * @param blocks    The blocks to process
   * @param prefix    ID prefix (e.g. "" at top level, "p1.b0" inside a branch)
   * @param priorIds  IDs the first node(s) in this sequence should depend on
   * @returns         IDs of the last node(s) produced
   */
  function processBlocks(
    blocks: PlanBlock[],
    prefix: string,
    priorIds: string[],
  ): string[] {
    let currentDeps = priorIds;

    for (const block of blocks) {
      if (block.type === "step") {
        stepCounter++;
        const id = block.id ?? `${prefix}s${stepCounter}`;
        nodes[id] = {
          id,
          description: block.description,
          dependsOn: [...currentDeps],
          toolsNeeded: block.toolsNeeded ?? [],
          estimatedComplexity: block.estimatedComplexity ?? "medium",
          agentProfile: block.agentProfile ?? null,
          resources: normaliseResources(block.resources),
        };
        currentDeps = [id];
      } else {
        // parallel block
        parallelCounter++;
        const groupId = `${prefix}p${parallelCounter}`;
        const joinKind = (block as ParallelBlock).join ?? "all";
        const branchTails: string[] = [];

        for (let bi = 0; bi < block.branches.length; bi++) {
          const branch = block.branches[bi];
          const branchPrefix = `${groupId}.b${bi}.`;
          // Each branch starts from the current dependencies (fork point)
          const tails = processBlocks(branch.blocks, branchPrefix, currentDeps);
          // Tag each node in this branch
          for (const tailId of tails) {
            if (nodes[tailId]) {
              nodes[tailId].branch = { groupId, name: branch.name };
            }
          }
          // Walk all nodes with this branchPrefix and tag them
          for (const nodeId of Object.keys(nodes)) {
            if (nodeId.startsWith(branchPrefix) && !nodes[nodeId].branch) {
              nodes[nodeId].branch = { groupId, name: branch.name };
            }
          }
          branchTails.push(...tails);
        }

        // Synthetic join node
        stepCounter++;
        const joinId = `${groupId}.join`;
        nodes[joinId] = {
          id: joinId,
          description: `Join (${joinKind}) for parallel group ${groupId}`,
          dependsOn: [...branchTails],
          toolsNeeded: [],
          estimatedComplexity: "low",
          resources: [],
          joinGroup: { kind: joinKind, groupId },
        };

        currentDeps = [joinId];
      }
    }

    return currentDeps;
  }

  processBlocks(plan.blocks, "", []);
  return { nodes };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Normalise resource hints to lowercase trimmed strings. */
function normaliseResources(resources?: string[]): string[] {
  if (!resources) return [];
  return resources.map((r) => r.trim().toLowerCase()).filter(Boolean);
}
