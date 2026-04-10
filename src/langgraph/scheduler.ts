/**
 * Resource-aware scheduler — selects runnable nodes from the compiled DAG.
 *
 * Enforces:
 * - Dependency ordering (a node runs only when all dependsOn are done)
 * - join:any semantics (join node fires after first successful branch)
 * - File-write exclusion (no two concurrent nodes may write the same file)
 * - Network concurrency quota
 * - Overall concurrency cap
 */

import type { CompiledPlan, CompiledPlanNode, NodeRecord } from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Resource helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Extract file:WRITE paths from a node's resource hints. */
export function getWritePaths(node: CompiledPlanNode): string[] {
  return node.resources
    .filter((r) => r.startsWith("file:write:"))
    .map((r) => r.slice("file:write:".length));
}

/** Check whether a node declares a network resource. */
export function needsNetwork(node: CompiledPlanNode): boolean {
  return node.resources.includes("network");
}

// ─────────────────────────────────────────────────────────────────────────────
// Dependency checking
// ─────────────────────────────────────────────────────────────────────────────

/** A node's dependency is satisfied when the dep is success, skipped, or cancelled. */
function isDependencySatisfied(record: NodeRecord | undefined): boolean {
  if (!record) return false;
  return record.status === "success" || record.status === "skipped" || record.status === "cancelled";
}

/**
 * For join:any nodes, the dependency is satisfied when at least one branch
 * succeeded; the rest may still be running or pending.
 */
function isJoinAnyReady(
  node: CompiledPlanNode,
  records: Record<string, NodeRecord>,
): boolean {
  if (!node.joinGroup || node.joinGroup.kind !== "any") return false;
  // At least one dependency must have succeeded
  return node.dependsOn.some((depId) => records[depId]?.status === "success");
}

/**
 * For join:all nodes, every dependency must be satisfied (success/skipped/cancelled).
 */
function isJoinAllReady(
  node: CompiledPlanNode,
  records: Record<string, NodeRecord>,
): boolean {
  if (!node.joinGroup || node.joinGroup.kind !== "all") return false;
  return node.dependsOn.every((depId) => isDependencySatisfied(records[depId]));
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

export interface SelectRunnableOptions {
  maxConcurrency: number;
  networkConcurrency: number;
}

/**
 * Given the current execution state, return the set of node IDs that can be
 * dispatched right now.
 *
 * Join nodes (synthetic) are never "executed" as real steps — they are resolved
 * by the outcome handler. We still return them as runnable so the graph loop
 * can transition through them.
 */
export function selectRunnable(
  plan: CompiledPlan,
  records: Record<string, NodeRecord>,
  opts: SelectRunnableOptions,
): string[] {
  const running = Object.values(records).filter((r) => r.status === "running");
  const runningCount = running.length;

  if (runningCount >= opts.maxConcurrency) return [];

  // Compute currently locked resources from running nodes
  const lockedFiles = new Set<string>();
  const networkSlots = running.filter((r) => {
    const node = plan.nodes[r.nodeId];
    return node && needsNetwork(node);
  }).length;

  for (const r of running) {
    const node = plan.nodes[r.nodeId];
    if (node) {
      for (const fp of getWritePaths(node)) {
        lockedFiles.add(fp);
      }
    }
  }

  const candidates: string[] = [];
  const slots = opts.maxConcurrency - runningCount;
  let remainingNetworkSlots = opts.networkConcurrency - networkSlots;

  for (const [nodeId, node] of Object.entries(plan.nodes)) {
    if (candidates.length >= slots) break;

    const record = records[nodeId];
    // Only consider pending nodes
    if (record && record.status !== "pending") continue;
    if (!record) continue; // no record = not initialised yet

    // Check dependency satisfaction
    let depsReady: boolean;
    if (node.joinGroup?.kind === "any") {
      depsReady = isJoinAnyReady(node, records);
    } else if (node.joinGroup?.kind === "all") {
      depsReady = isJoinAllReady(node, records);
    } else {
      // Regular node: all deps must be satisfied
      depsReady = node.dependsOn.every((depId) => isDependencySatisfied(records[depId]));
    }
    if (!depsReady) continue;

    // Resource constraints: file write exclusion
    const writePaths = getWritePaths(node);
    if (writePaths.some((fp) => lockedFiles.has(fp))) continue;

    // Resource constraints: network quota
    if (needsNetwork(node) && remainingNetworkSlots <= 0) continue;

    // Node is runnable
    candidates.push(nodeId);

    // Reserve resources for this candidate
    for (const fp of writePaths) lockedFiles.add(fp);
    if (needsNetwork(node)) remainingNetworkSlots--;
  }

  return candidates;
}

/**
 * Returns IDs of nodes that should be cancelled for join:any semantics.
 * When a join:any join node becomes ready (first success), the remaining
 * pending/running branches should be cancelled.
 */
export function getCancellableForRace(
  plan: CompiledPlan,
  records: Record<string, NodeRecord>,
): string[] {
  const toCancel: string[] = [];

  for (const [nodeId, node] of Object.entries(plan.nodes)) {
    if (!node.joinGroup || node.joinGroup.kind !== "any") continue;
    // Check if this join is ready
    if (!isJoinAnyReady(node, records)) continue;

    // Cancel all branches that are still pending or running
    const groupId = node.joinGroup.groupId;
    for (const [otherId, otherNode] of Object.entries(plan.nodes)) {
      if (otherId === nodeId) continue;
      if (otherNode.branch?.groupId !== groupId) continue;
      const rec = records[otherId];
      if (rec && (rec.status === "pending" || rec.status === "running")) {
        toCancel.push(otherId);
      }
    }
  }

  return toCancel;
}

/**
 * Check whether all nodes are in a terminal state (done).
 */
export function isAllDone(records: Record<string, NodeRecord>): boolean {
  return Object.values(records).every(
    (r) => r.status === "success" || r.status === "failed" || r.status === "skipped" || r.status === "cancelled",
  );
}

/**
 * Detect deadlock: no runnable nodes, not all done, and nothing running.
 */
export function isDeadlocked(
  plan: CompiledPlan,
  records: Record<string, NodeRecord>,
  opts: SelectRunnableOptions,
): boolean {
  if (isAllDone(records)) return false;
  const running = Object.values(records).some((r) => r.status === "running");
  if (running) return false;
  return selectRunnable(plan, records, opts).length === 0;
}
