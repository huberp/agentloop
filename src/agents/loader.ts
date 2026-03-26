import * as fs from "fs/promises";
import * as path from "path";
import { AgentProfile, AgentProfileError } from "./types";
import { logger } from "../logger";
import { skillRegistry } from "../skills/registry";
import { toolRegistry } from "../tools/registry";

/** Validate a semver string: major.minor.patch (all non-negative integers). */
function isValidSemver(v: string): boolean {
  return /^\d+\.\d+\.\d+$/.test(v);
}

function parseScalar(value: string): string | number | boolean | null {
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null" || value === "~") return null;
  const num = Number(value);
  if (!isNaN(num) && value !== "") return num;
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * Simple YAML subset parser for .agent.yaml files.
 * Supports flat key: value pairs, arrays (- item), and one level of nested objects
 * (for the `constraints` field). Zero external dependencies.
 */
function parseSimpleYaml(content: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = content.split(/\r?\n/);
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith("#")) {
      i++;
      continue;
    }

    const indent = line.match(/^(\s*)/)?.[1].length ?? 0;
    if (indent > 0) {
      i++;
      continue; // skip non-root lines during root parsing
    }

    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) {
      i++;
      continue;
    }

    const key = line.slice(0, colonIdx).trim();
    const valueStr = line.slice(colonIdx + 1).trim();

    if (valueStr === "") {
      // Could be a list or nested object
      const items: string[] = [];
      const nestedObj: Record<string, unknown> = {};
      let isNested = false;
      i++;
      while (
        i < lines.length &&
        (lines[i].match(/^(\s+)/) || lines[i].trim() === "")
      ) {
        const subLine = lines[i];
        if (!subLine.trim()) {
          i++;
          continue;
        }
        const subColonIdx = subLine.indexOf(":");
        if (subLine.trimStart().startsWith("- ")) {
          items.push(subLine.replace(/^\s*-\s*/, "").trim());
        } else if (subColonIdx !== -1) {
          isNested = true;
          const subKey = subLine.slice(0, subColonIdx).trim();
          const subValueStr = subLine.slice(subColonIdx + 1).trim();
          if (subValueStr === "") {
            // Handle sub-arrays
            const subItems: string[] = [];
            i++;
            while (
              i < lines.length &&
              lines[i].match(/^\s{4,}/) &&
              lines[i].trimStart().startsWith("- ")
            ) {
              subItems.push(lines[i].replace(/^\s*-\s*/, "").trim());
              i++;
            }
            nestedObj[subKey] = subItems;
            continue;
          } else {
            nestedObj[subKey] = parseScalar(subValueStr);
          }
        }
        i++;
      }
      result[key] = isNested ? nestedObj : items;
      continue;
    }

    result[key] = parseScalar(valueStr);
    i++;
  }
  return result;
}

export async function loadAgentProfile(filePath: string): Promise<AgentProfile> {
  const ext = path.extname(filePath).toLowerCase();
  const raw = await fs.readFile(filePath, "utf-8");

  let data: unknown;
  if (ext === ".json") {
    try {
      data = JSON.parse(raw);
    } catch (e) {
      throw new AgentProfileError(`Invalid JSON in agent profile: ${e}`, filePath);
    }
  } else if (ext === ".yaml" || ext === ".yml") {
    data = parseSimpleYaml(raw);
  } else {
    throw new AgentProfileError(`Unsupported profile format: ${ext}`, filePath);
  }

  if (!data || typeof data !== "object") {
    throw new AgentProfileError("Agent profile must be an object", filePath);
  }

  const obj = data as Record<string, unknown>;

  // Validate required fields
  for (const field of ["name", "description", "version"]) {
    if (!obj[field] || typeof obj[field] !== "string") {
      throw new AgentProfileError(
        `Missing required string field: "${field}"`,
        filePath
      );
    }
  }

  // Validate semver
  if (!isValidSemver(obj.version as string)) {
    throw new AgentProfileError(
      `Invalid semver version "${obj.version}" in agent profile "${obj.name}"`,
      filePath
    );
  }

  // Warn on unresolvable tool references (do not throw)
  if (Array.isArray(obj.tools)) {
    for (const toolName of obj.tools) {
      if (!toolRegistry.get(toolName)) {
        logger.warn(
          { profileName: obj.name, toolName },
          "Agent profile references unregistered tool"
        );
      }
    }
  }

  // Warn on unresolvable skill references
  if (Array.isArray(obj.skills)) {
    for (const skillName of obj.skills) {
      if (!skillRegistry.get(skillName)) {
        logger.warn(
          { profileName: obj.name, skillName },
          "Agent profile references unregistered skill"
        );
      }
    }
  }

  return obj as unknown as AgentProfile;
}
