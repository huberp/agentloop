import * as fs from "fs/promises";
import * as path from "path";
import { logger } from "../logger";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Metadata parsed from YAML frontmatter of an instruction file. */
export interface InstructionMeta {
  /** Glob pattern — the instruction applies only when the active file matches. */
  applyTo?: string;
  /** Human-readable description of the instruction. */
  description?: string;
  /** Ordering priority (higher = injected earlier). Default is 0. */
  priority: number;
}

/** A single instruction block loaded from a file on disk. */
export interface InstructionBlock {
  /** Absolute path to the source file. */
  filePath: string;
  /** Parsed frontmatter metadata. */
  meta: InstructionMeta;
  /** Markdown body (everything after the frontmatter). */
  body: string;
}

/** Context used for filtering instructions. */
export interface InstructionContext {
  /** The file path currently being worked on (used for `applyTo` matching). */
  activeFilePath?: string;
}

// ---------------------------------------------------------------------------
// YAML Frontmatter Parser (lightweight — no external dependency)
// ---------------------------------------------------------------------------

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** Minimal YAML-like key-value parser for instruction frontmatter. */
function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const match = raw.match(FRONTMATTER_RE);
  if (!match) {
    return { meta: {}, body: raw };
  }

  const yamlBlock = match[1];
  const body = raw.slice(match[0].length);
  const meta: Record<string, string> = {};

  for (const line of yamlBlock.split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    // Strip surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key) meta[key] = value;
  }

  return { meta, body };
}

function toMeta(raw: Record<string, string>): InstructionMeta {
  return {
    applyTo: raw.applyTo || undefined,
    description: raw.description || undefined,
    priority: raw.priority !== undefined ? Number(raw.priority) || 0 : 0,
  };
}

// ---------------------------------------------------------------------------
// Glob Matching (simple implementation — no external dependency)
// ---------------------------------------------------------------------------

/**
 * Convert a minimal glob pattern into a RegExp.
 *
 * Supports: `*` (any non-separator chars), `**` (any chars incl. separators),
 * `?` (single char), and character classes `[abc]`.
 */
function globToRegExp(pattern: string): RegExp {
  // Normalise to forward slashes for cross-platform paths
  let p = pattern.replace(/\\/g, "/");
  let re = "^";
  let i = 0;
  while (i < p.length) {
    const ch = p[i];
    if (ch === "*") {
      if (p[i + 1] === "*") {
        // ** matches anything (including path separators)
        re += ".*";
        i += 2;
        // consume trailing /
        if (p[i] === "/") i++;
      } else {
        // * matches anything except /
        re += "[^/]*";
        i++;
      }
    } else if (ch === "?") {
      re += "[^/]";
      i++;
    } else if (ch === "[") {
      const close = p.indexOf("]", i);
      if (close === -1) {
        re += "\\[";
        i++;
      } else {
        re += p.slice(i, close + 1);
        i = close + 1;
      }
    } else {
      re += ch.replace(/[.+^${}()|\\]/g, "\\$&");
      i++;
    }
  }
  re += "$";
  return new RegExp(re);
}

/** Test whether `filePath` matches the given glob `pattern`. */
export function matchesGlob(filePath: string, pattern: string): boolean {
  const normalised = filePath.replace(/\\/g, "/");
  return globToRegExp(pattern).test(normalised);
}

// ---------------------------------------------------------------------------
// File Discovery
// ---------------------------------------------------------------------------

/** Recursively collect files matching a given filename inside `rootPath`. */
async function findFiles(rootPath: string, fileName: string): Promise<string[]> {
  const results: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries: import("fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable directory — skip silently
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // Skip common non-content directories
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        await walk(full);
      } else if (entry.name === fileName) {
        results.push(full);
      }
    }
  }

  await walk(rootPath);
  return results;
}

// ---------------------------------------------------------------------------
// InstructionSet
// ---------------------------------------------------------------------------

/**
 * A loaded set of instruction blocks. Call `getActive()` to retrieve only
 * blocks that match the current context, sorted by priority descending.
 */
export class InstructionSet {
  constructor(public readonly blocks: InstructionBlock[]) {}

  /**
   * Return instruction blocks matching the provided context.
   *
   * - Blocks without an `applyTo` pattern are always included.
   * - Blocks with `applyTo` are included only if `context.activeFilePath`
   *   matches the glob.
   * - Results are sorted by `priority` descending.
   */
  getActive(context?: InstructionContext): InstructionBlock[] {
    const active = this.blocks.filter((block) => {
      if (!block.meta.applyTo) return true;
      if (!context?.activeFilePath) return false;
      return matchesGlob(context.activeFilePath, block.meta.applyTo);
    });

    return active.sort((a, b) => b.meta.priority - a.meta.priority);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Discover and load all instruction files under `rootPath`.
 *
 * Recognised file conventions:
 * 1. `.github/copilot-instructions.md` — global workspace instructions
 * 2. `**\/.instructions.md` — scoped per-directory instructions
 * 3. `AGENTS.md` — repo-level agent conventions
 */
export async function loadInstructions(
  rootPath: string,
  _context?: InstructionContext,
): Promise<InstructionSet> {
  const blocks: InstructionBlock[] = [];

  // 1. Global workspace instructions
  const globalPath = path.join(rootPath, ".github", "copilot-instructions.md");
  await loadFile(globalPath, blocks);

  // 2. Repo-level AGENTS.md
  const agentsPath = path.join(rootPath, "AGENTS.md");
  await loadFile(agentsPath, blocks);

  // 3. Scoped .instructions.md files (recursive)
  const scopedFiles = await findFiles(rootPath, ".instructions.md");
  for (const filePath of scopedFiles) {
    await loadFile(filePath, blocks);
  }

  logger.debug({ count: blocks.length, rootPath }, "Instruction files loaded");
  return new InstructionSet(blocks);
}

/** Read a single instruction file, parse frontmatter, and append to `out`. */
async function loadFile(filePath: string, out: InstructionBlock[]): Promise<void> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch {
    // File not found or unreadable — that's fine, skip silently.
    return;
  }

  const { meta, body } = parseFrontmatter(raw);
  const trimmedBody = body.trim();
  if (!trimmedBody) return; // skip empty files

  out.push({
    filePath,
    meta: toMeta(meta),
    body: trimmedBody,
  });
}
