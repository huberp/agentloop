import * as fs from "fs/promises";
import * as path from "path";
import { logger } from "../logger";

export interface ActiveSkillFragment {
  name: string;
  slot: "prepend" | "append" | "section";
  fragment: string;
  tools?: string[];
}

export interface Skill {
  name: string;
  description: string;
  version: string;
  promptFragment: string;
  tools?: string[];
  instructions?: string;
  slot: "prepend" | "append" | "section";
  /** Source classification: where this skill was loaded from. */
  source?: "built-in" | "custom";
  /** Absolute path to the file this skill was loaded from. */
  filePath?: string;
}

// ---------------------------------------------------------------------------
// Lightweight YAML frontmatter parser (same pattern as src/prompts/registry.ts)
// ---------------------------------------------------------------------------

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

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
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) meta[key] = value;
  }
  return { meta, body };
}

// ---------------------------------------------------------------------------
// SkillRegistry
// ---------------------------------------------------------------------------

export class SkillRegistry {
  private skills = new Map<string, Skill>();
  private activeSkills = new Set<string>();

  /** Register a skill. Logs a warning and skips if the name is already registered. */
  register(skill: Skill): void {
    if (this.skills.has(skill.name)) {
      logger.warn({ skillName: skill.name }, "Skill already registered; skipping duplicate");
      return;
    }
    this.skills.set(skill.name, skill);
    logger.debug({ skillName: skill.name }, "Skill registered");
  }

  get(name: string): Skill | undefined {
    return this.skills.get(name);
  }

  /** Return all registered skills. */
  list(): Skill[] {
    return Array.from(this.skills.values());
  }

  /**
   * Return full metadata for all registered skills.
   * Convenience method for the list command and other introspection uses.
   */
  getAll(): Skill[] {
    return this.list();
  }

  /**
   * Activate a skill by name.
   * Returns false if the skill is not registered.
   * Idempotent: activating an already-active skill is a no-op that returns true.
   */
  activate(name: string): boolean {
    if (!this.skills.has(name)) {
      return false;
    }
    this.activeSkills.add(name);
    return true;
  }

  /**
   * Deactivate a skill by name.
   * Returns false if the skill name is not registered.
   */
  deactivate(name: string): boolean {
    if (!this.skills.has(name)) {
      return false;
    }
    this.activeSkills.delete(name);
    return true;
  }

  isActive(name: string): boolean {
    return this.activeSkills.has(name);
  }

  /** Return only the currently active skills. */
  listActive(): Skill[] {
    return Array.from(this.activeSkills)
      .map((name) => this.skills.get(name)!)
      .filter(Boolean);
  }

  /**
   * Discover and register all `*.skill.md` files in `dirPath`.
   * Non-existent or unreadable directories are silently ignored.
   * Duplicate names log a warning and are skipped.
   *
   * @param source  Optional source tag applied to every loaded skill.
   */
  async loadFromDirectory(dirPath: string, source?: Skill["source"]): Promise<void> {
    let entries: string[];
    try {
      entries = await fs.readdir(dirPath);
    } catch {
      // Directory not found or not accessible — silently skip
      return;
    }

    for (const file of entries.filter((f) => f.endsWith(".skill.md"))) {
      const filePath = path.join(dirPath, file);
      let content: string;
      try {
        content = await fs.readFile(filePath, "utf-8");
      } catch (err) {
        logger.warn({ filePath, err }, "Failed to read skill file; skipping");
        continue;
      }

      const { meta, body } = parseFrontmatter(content);
      const defaultName = path.basename(file, ".skill.md").replace(/\s+/g, "-");

      // tools: comma-separated string
      const tools: string[] | undefined = meta.tools
        ? meta.tools
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean)
        : undefined;

      const skill: Skill = {
        name: meta.name ?? defaultName,
        description: meta.description ?? "",
        version: meta.version ?? "1.0.0",
        slot: (meta.slot as Skill["slot"]) ?? "append",
        promptFragment: body,
        ...(tools && tools.length > 0 ? { tools } : {}),
        ...(meta.instructions ? { instructions: meta.instructions } : {}),
        ...(source ? { source } : {}),
        filePath,
      };

      this.register(skill);
    }
  }
}

export const skillRegistry = new SkillRegistry();
