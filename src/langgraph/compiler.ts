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
        const normResources = normaliseResources(block.resources);
        const inferred = inferMissingResources(
          block.description,
          block.toolsNeeded ?? [],
          normResources,
        );
        nodes[id] = {
          id,
          description: block.description,
          dependsOn: [...currentDeps],
          toolsNeeded: block.toolsNeeded ?? [],
          estimatedComplexity: block.estimatedComplexity ?? "medium",
          agentProfile: block.agentProfile ?? null,
          resources: [...normResources, ...inferred],
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

// ─────────────────────────────────────────────────────────────────────────────
// Resource inference
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mapping from package-manager command patterns to the manifest file they
 * implicitly write. Used by inferMissingResources to auto-add resource locks
 * when the planner omits them.
 *
 * All manifest names are stored lowercase because normaliseResources() lowercases
 * every resource string before it reaches the scheduler, so the comparison must
 * use the same casing (e.g. "cargo.toml", not "Cargo.toml").
 */
const PKG_MANAGER_MANIFEST: Array<{ pattern: RegExp; manifest: string }> = [
  { pattern: /\bnpm\s+(install|i|ci|add)\b/i,   manifest: "package.json" },
  { pattern: /\byarn(\s+(add|install|up))?\b/i,  manifest: "package.json" },
  { pattern: /\bpnpm\s+(install|add|i)\b/i,      manifest: "package.json" },
  { pattern: /\bpip\s*3?\s+install\b/i,          manifest: "requirements.txt" },
  { pattern: /\bcargo\s+(build|add|install)\b/i, manifest: "cargo.toml" },
  { pattern: /\bgo\s+get\b/i,                    manifest: "go.mod" },
  // `bundle install` and `bundle add` both write Gemfile / Gemfile.lock.
  // `gem install` only installs into the system gem path and does NOT modify
  // Gemfile, so it is intentionally excluded.
  { pattern: /\bbundle\s+(install|add)\b/i,      manifest: "gemfile" },
];

/** Known manifest file names (lowercase). */
const KNOWN_MANIFEST_FILES = [
  "package.json",
  "requirements.txt",
  "pyproject.toml",
  "cargo.toml",
  "go.mod",
  "gemfile",
];

/**
 * Infer additional `file:write:<manifest>` resource hints that the planner
 * failed to declare, based on the step's description and toolsNeeded.
 *
 * Rules:
 * 1. If the description contains a package-manager invocation (e.g. "npm install …"),
 *    add the corresponding manifest as a file-write resource unless already present.
 * 2. If toolsNeeded includes "file-edit" or "file-write" and the description
 *    names a known manifest file, add that file as a file-write resource unless
 *    already present.
 *
 * @param description        Step description string.
 * @param toolsNeeded        Declared tools for the step.
 * @param existingResources  Already-normalised resource hints for the step.
 * @returns                  Additional resource strings to append (already normalised).
 */
export function inferMissingResources(
  description: string,
  toolsNeeded: string[],
  existingResources: string[],
): string[] {
  const additional: string[] = [];

  // Rule 1: package-manager command → auto-add manifest write lock
  for (const { pattern, manifest } of PKG_MANAGER_MANIFEST) {
    if (pattern.test(description)) {
      const resource = `file:write:${manifest}`;
      if (!existingResources.includes(resource) && !additional.includes(resource)) {
        additional.push(resource);
      }
    }
  }

  // Rule 2: file-edit / file-write tool + manifest name mentioned in description
  const usesFileEditTool = toolsNeeded.some(
    (t) => t === "file-edit" || t === "file-write",
  );
  if (usesFileEditTool) {
    const lowerDesc = description.toLowerCase();
    for (const manifest of KNOWN_MANIFEST_FILES) {
      if (lowerDesc.includes(manifest)) {
        const resource = `file:write:${manifest}`;
        if (!existingResources.includes(resource) && !additional.includes(resource)) {
          additional.push(resource);
        }
      }
    }
  }

  return additional;
}

// ─────────────────────────────────────────────────────────────────────────────
// Post-plan conflict detection
// ─────────────────────────────────────────────────────────────────────────────

/** Return true if the step description matches a known package-manager invocation. */
function isPkgManagerStep(step: StepBlock): boolean {
  return PKG_MANAGER_MANIFEST.some(({ pattern }) => pattern.test(step.description));
}

/** Return true if the step uses a file-editing tool. */
function isFileEditStep(step: StepBlock): boolean {
  return (step.toolsNeeded ?? []).some(
    (t) => t === "file-edit" || t === "file-write",
  );
}

/** Collect all StepBlocks recursively from a list of PlanBlocks. */
function collectSteps(blocks: PlanBlock[]): StepBlock[] {
  const result: StepBlock[] = [];
  for (const block of blocks) {
    if (block.type === "step") {
      result.push(block);
    } else {
      for (const branch of (block as ParallelBlock).branches) {
        result.push(...collectSteps(branch.blocks));
      }
    }
  }
  return result;
}

/**
 * Scan a BlocksPlan for parallel branches where one branch contains a
 * package-manager step and another contains a file-edit step targeting the
 * same manifest file — without a declared resource lock to serialise them.
 *
 * Returns a (possibly empty) list of human-readable conflict descriptions.
 * An empty array means no conflicts were found.
 */
export function detectPkgManifestConflicts(plan: BlocksPlan): string[] {
  const conflicts: string[] = [];

  function checkBlocks(blocks: PlanBlock[]): void {
    for (const block of blocks) {
      if (block.type !== "parallel") continue;

      // Collect steps per branch for this parallel group
      const perBranch = block.branches.map((branch) => ({
        name: branch.name,
        steps: collectSteps(branch.blocks),
      }));

      // Check every pair of branches for a pkg-manager / file-edit conflict
      for (let i = 0; i < perBranch.length; i++) {
        for (let j = i + 1; j < perBranch.length; j++) {
          const branchA = perBranch[i];
          const branchB = perBranch[j];

          for (const stepA of branchA.steps) {
            for (const stepB of branchB.steps) {
              const aPkg = isPkgManagerStep(stepA);
              const bPkg = isPkgManagerStep(stepB);
              const aEdit = isFileEditStep(stepA);
              const bEdit = isFileEditStep(stepB);

              // One side is a pkg-manager step, the other is a file-edit step
              if (!((aPkg && bEdit) || (bPkg && aEdit))) continue;

              const pkgStep = aPkg ? stepA : stepB;
              const editStep = aPkg ? stepB : stepA;

              // Determine the manifest the pkg-manager step touches
              const inferredManifests = inferMissingResources(
                pkgStep.description,
                pkgStep.toolsNeeded ?? [],
                normaliseResources(pkgStep.resources),
              );
              const pkgResources = [
                ...normaliseResources(pkgStep.resources),
                ...inferredManifests,
              ];
              const editResources = [
                ...normaliseResources(editStep.resources),
                ...inferMissingResources(
                  editStep.description,
                  editStep.toolsNeeded ?? [],
                  normaliseResources(editStep.resources),
                ),
              ];

              const pkgWrites = pkgResources.filter((r) => r.startsWith("file:write:"));
              const editWrites = editResources.filter((r) => r.startsWith("file:write:"));

              // Conflict when both declare overlapping write targets,
              // or when either side has no declared write resources at all
              const bothDeclared = pkgWrites.length > 0 && editWrites.length > 0;
              const overlap = pkgWrites.some((p) => editWrites.includes(p));

              if (!bothDeclared || overlap) {
                conflicts.push(
                  `Parallel branches "${branchA.name}" and "${branchB.name}": ` +
                  `pkg-manager step "${pkgStep.description}" may conflict with ` +
                  `file-edit step "${editStep.description}"`,
                );
              }
            }
          }
        }
      }

      // Recurse into each branch
      for (const branch of block.branches) {
        checkBlocks(branch.blocks);
      }
    }
  }

  checkBlocks(plan.blocks);
  return conflicts;
}
