/**
 * Deterministic merge utilities for layered configuration.
 *
 * Rules:
 * - Plain objects: recursive deep merge
 * - Primitives: later value replaces earlier value
 * - Arrays:
 *   - `models`: merge by `id` field
 *   - All other arrays: later layer replaces entirely
 */

import type { ModelConfig, PartialAgentLoopConfig } from "./schema";

/**
 * Check whether a value is a plain object (not an array, null, Date, etc.).
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

/**
 * Deep-merge two plain objects. Arrays are replaced wholesale except for
 * the `models` key which is handled specially by `mergeModels`.
 */
export function deepMerge<T extends Record<string, unknown>>(
  base: T,
  override: Record<string, unknown>,
  path: string = "",
): T {
  const result = { ...base } as Record<string, unknown>;

  for (const key of Object.keys(override)) {
    const currentPath = path ? `${path}.${key}` : key;
    const baseVal = result[key];
    const overVal = override[key];

    if (overVal === undefined) continue;

    if (currentPath === "models" && Array.isArray(overVal)) {
      // Special merge-by-id for the models array
      result[key] = mergeModels(
        (baseVal as ModelConfig[] | undefined) ?? [],
        overVal as ModelConfig[],
      );
    } else if (isPlainObject(baseVal) && isPlainObject(overVal)) {
      result[key] = deepMerge(baseVal, overVal, currentPath);
    } else {
      result[key] = overVal;
    }
  }

  return result as T;
}

/**
 * Merge two `models` arrays by `id`.
 *
 * - If the override contains a model with the same `id` as the base, the
 *   fields are shallow-merged (override wins per-field).
 * - If the override introduces a new `id`, it is appended.
 * - Order: base models first (in original order), then new override models
 *   in their original order.
 */
export function mergeModels(
  base: ModelConfig[],
  override: ModelConfig[],
): ModelConfig[] {
  const mergedMap = new Map<string, ModelConfig>();
  const order: string[] = [];

  for (const m of base) {
    mergedMap.set(m.id, { ...m });
    order.push(m.id);
  }

  for (const m of override) {
    const existing = mergedMap.get(m.id);
    if (existing) {
      mergedMap.set(m.id, { ...existing, ...m });
    } else {
      mergedMap.set(m.id, { ...m });
      order.push(m.id);
    }
  }

  return order.map((id) => mergedMap.get(id)!);
}

/**
 * Merge multiple partial configs in order. Later entries override earlier ones.
 */
export function mergeConfigs(
  ...layers: PartialAgentLoopConfig[]
): PartialAgentLoopConfig {
  let result: PartialAgentLoopConfig = {};
  for (const layer of layers) {
    result = deepMerge(
      result as Record<string, unknown>,
      layer as Record<string, unknown>,
    ) as PartialAgentLoopConfig;
  }
  return result;
}
