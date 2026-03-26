import * as fs from "fs/promises";
import * as path from "path";
import { createPatch } from "diff";
import { logger } from "../logger";
import { appConfig } from "../config";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A composable prompt template stored in the registry. */
export interface PromptTemplate {
  /** Unique template name (e.g. "system"). */
  name: string;
  /** Human-readable description of the template's purpose. */
  description: string;
  /** Template string with `{{variable}}` and `{{> partialName}}` placeholders. */
  template: string;
  /** List of variable names expected by this template. */
  variables: string[];
  /** Optional tags for categorisation / filtering. */
  tags?: string[];
  /** Inline partial definitions: `{ partialName: partialTemplateString }`. */
  partials?: Record<string, string>;
  /** Semantic version string (e.g. "1.0.0"). */
  version?: string;
  /** Human-readable description of changes in this version. */
  changelog?: string;
}

/** Context object passed to `render()` — values keyed by variable name. */
export type RenderContext = Record<string, unknown>;

// ---------------------------------------------------------------------------
// YAML Frontmatter Parser (reused from instructions/loader — lightweight)
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
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key) meta[key] = value;
  }
  return { meta, body };
}

// ---------------------------------------------------------------------------
// Semver helpers
// ---------------------------------------------------------------------------

function parseSemver(v: string): [number, number, number] {
  const parts = v.split(".").map(Number);
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

/** Returns positive if a > b, negative if a < b, 0 if equal. */
function compareSemver(a: string, b: string): number {
  const [aMaj, aMin, aPat] = parseSemver(a);
  const [bMaj, bMin, bPat] = parseSemver(b);
  if (aMaj !== bMaj) return aMaj - bMaj;
  if (aMin !== bMin) return aMin - bMin;
  return aPat - bPat;
}

// ---------------------------------------------------------------------------
// PromptRegistry
// ---------------------------------------------------------------------------

/**
 * Registry for composable prompt templates.
 *
 * Templates use `{{variable}}` for interpolation and `{{> partialName}}`
 * for including other registered partials or inline partials.
 */
export class PromptRegistry {
  private templates = new Map<string, PromptTemplate>();
  private versionHistory = new Map<string, PromptTemplate[]>();

  /** Register a template. Updates the active pointer and appends to version history if versioned. */
  register(template: PromptTemplate): void {
    this.templates.set(template.name, template);
    if (template.version) {
      const history = this.versionHistory.get(template.name) ?? [];
      history.push(template);
      this.versionHistory.set(template.name, history);
    }
    logger.debug({ templateName: template.name }, "Prompt template registered");
    this.saveHistory().catch((err) => {
      logger.warn({ error: (err as Error).message }, "Failed to save prompt history");
    });
  }

  /** Retrieve a template by name, or `undefined` if not found. */
  get(name: string): PromptTemplate | undefined {
    return this.templates.get(name);
  }

  /** Return all registered templates. */
  list(): PromptTemplate[] {
    return Array.from(this.templates.values());
  }

  /** Return all registered versions of a template in descending semver order. */
  versions(name: string): PromptTemplate[] {
    const history = this.versionHistory.get(name) ?? [];
    return [...history].sort((a, b) =>
      compareSemver(b.version ?? "0.0.0", a.version ?? "0.0.0"),
    );
  }

  /**
   * Produce a unified diff between two stored versions of a template.
   * Throws if the template name or either version is not found.
   */
  diff(name: string, v1: string, v2: string): string {
    const history = this.versionHistory.get(name);
    if (!history) {
      throw new Error(`Prompt template "${name}" has no version history`);
    }
    const t1 = history.find((t) => t.version === v1);
    const t2 = history.find((t) => t.version === v2);
    if (!t1) {
      throw new Error(`Version "${v1}" of prompt template "${name}" not found`);
    }
    if (!t2) {
      throw new Error(`Version "${v2}" of prompt template "${name}" not found`);
    }
    return createPatch(name, t1.template, t2.template, v1, v2);
  }

  /**
   * Persist the full version history to `appConfig.promptHistoryFile`.
   * No-op if the path is not configured.
   */
  async saveHistory(): Promise<void> {
    const filePath = appConfig.promptHistoryFile;
    if (!filePath) return;
    const data: Record<string, PromptTemplate[]> = {};
    for (const [key, val] of this.versionHistory) {
      data[key] = val;
    }
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
  }

  /**
   * Load version history from `appConfig.promptHistoryFile` and restore both
   * the history map and the active template pointers.
   * No-op if the path is not configured or the file does not exist.
   */
  async loadHistory(): Promise<void> {
    const filePath = appConfig.promptHistoryFile;
    if (!filePath) return;
    let raw: string;
    try {
      raw = await fs.readFile(filePath, "utf-8");
    } catch {
      return;
    }
    const data = JSON.parse(raw) as Record<string, PromptTemplate[]>;
    for (const [name, versions] of Object.entries(data)) {
      if (!Array.isArray(versions) || versions.length === 0) continue;
      this.versionHistory.set(name, versions);
      const sorted = [...versions].sort((a, b) =>
        compareSemver(b.version ?? "0.0.0", a.version ?? "0.0.0"),
      );
      this.templates.set(name, sorted[0]);
    }
    this.logActiveTemplates();
  }

  /**
   * Render a template by name, interpolating `{{variable}}` placeholders
   * from the provided context and expanding `{{> partialName}}` references.
   *
   * - Undefined variables render as empty strings and log a warning.
   * - Unknown partial names render as empty strings and log a warning.
   */
  render(name: string, context: RenderContext = {}): string {
    const template = this.templates.get(name);
    if (!template) {
      throw new Error(`Prompt template "${name}" not found in registry`);
    }
    return this.interpolate(template.template, context, template.partials);
  }

  /**
   * Load all `.md` and `.txt` files from a directory and register them.
   *
   * Files may contain optional YAML frontmatter with:
   *   - `name` (defaults to filename without extension)
   *   - `description`
   *   - `variables` (comma-separated list)
   *   - `tags` (comma-separated list)
   */
  async loadFromDirectory(dirPath: string): Promise<void> {
    let entries: import("fs").Dirent[];
    try {
      entries = await fs.readdir(dirPath, { withFileTypes: true });
    } catch {
      // Directory does not exist or is unreadable — not an error
      return;
    }

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (ext !== ".md" && ext !== ".txt") continue;

      const filePath = path.join(dirPath, entry.name);
      try {
        const raw = await fs.readFile(filePath, "utf-8");
        const { meta, body } = parseFrontmatter(raw);
        const templateName = meta.name || path.basename(entry.name, ext);
        const variables = meta.variables
          ? meta.variables.split(",").map((s) => s.trim()).filter(Boolean)
          : [];
        const tags = meta.tags
          ? meta.tags.split(",").map((s) => s.trim()).filter(Boolean)
          : undefined;

        this.register({
          name: templateName,
          description: meta.description || "",
          template: body.trim(),
          variables,
          tags,
        });
      } catch (err) {
        logger.warn({ filePath, error: (err as Error).message }, "Failed to load prompt template file");
      }
    }
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  /** Log active versioned templates at info level. Called after loading history. */
  private logActiveTemplates(): void {
    for (const template of this.templates.values()) {
      if (template.version) {
        logger.info(
          { templateName: template.name, version: template.version },
          "Prompt template active",
        );
      }
    }
  }

  /** Resolve `{{> partial}}` and `{{variable}}` placeholders in `text`. */
  private interpolate(
    text: string,
    context: RenderContext,
    inlinePartials?: Record<string, string>,
  ): string {
    // 1. Expand partials: {{> partialName}}
    const withPartials = text.replace(/\{\{>\s*(\w+)\s*\}\}/g, (_match, partialName: string) => {
      // Inline partials take precedence
      if (inlinePartials?.[partialName] !== undefined) {
        return this.interpolate(inlinePartials[partialName], context, inlinePartials);
      }
      // Fall back to a registered template with that name
      const registered = this.templates.get(partialName);
      if (registered) {
        return this.interpolate(registered.template, context, registered.partials);
      }
      logger.warn({ partialName }, "Prompt partial not found; rendering as empty string");
      return "";
    });

    // 2. Expand variables: {{variableName}}
    return withPartials.replace(/\{\{\s*(\w+)\s*\}\}/g, (_match, varName: string) => {
      if (varName in context) {
        const value = context[varName];
        if (Array.isArray(value)) return value.join(", ");
        return String(value ?? "");
      }
      logger.warn({ variable: varName }, "Prompt variable not found; rendering as empty string");
      return "";
    });
  }
}

// ---------------------------------------------------------------------------
// Module-level singleton
// ---------------------------------------------------------------------------

export const promptRegistry = new PromptRegistry();
