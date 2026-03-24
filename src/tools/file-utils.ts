import * as path from "path";

/**
 * Resolve `filePath` relative to `workspaceRoot` and ensure it stays inside the
 * workspace (prevents path-traversal attacks such as `../../etc/passwd`).
 *
 * @throws if the resolved path escapes `workspaceRoot`.
 */
export function resolveSafe(workspaceRoot: string, filePath: string): string {
  const root = path.resolve(workspaceRoot);
  const resolved = path.resolve(root, filePath);

  // Allow the root itself and anything that starts with "<root>/"
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(
      `Path "${filePath}" resolves to "${resolved}" which is outside the workspace root "${root}"`
    );
  }

  return resolved;
}

/**
 * Convert a simple glob pattern (supporting *, **, and ?) to a RegExp.
 * Used by file-list to filter directory entries without an external dependency.
 *
 * Supported patterns:
 *   *     - any characters except a path separator (within one segment)
 *   **    - any characters including path separators (across segments)
 *   ** /  - zero-or-more directory prefix (matches root-level entries too)
 *   ?     - any single character except a path separator
 */
export function globToRegExp(pattern: string): RegExp {
  // Handle "**/" specially: it should match zero-or-more leading path segments
  // so that "**/*.ts" matches both "a.ts" (root) and "sub/c.ts" (nested).
  const normalized = pattern.replace(/\*\*\//g, "\x01"); // placeholder for **/

  const escaped = normalized
    .replace(/[.+^${}()|[\]\\]/g, "\\$&") // escape regex meta chars
    .replace(/\*\*/g, ".*") // remaining ** → match across segments
    .replace(/\*/g, "[^/\\\\]*") // single * → match within one segment
    .replace(/\?/g, "[^/\\\\]") // ? → single char within segment
    .replace(/\x01/g, "(?:.+[/\\\\])?"); // **/ → optional path prefix

  return new RegExp(`^${escaped}$`);
}
