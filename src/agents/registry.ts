import * as fs from "fs/promises";
import * as path from "path";
import { AgentProfile } from "./types";
import { loadAgentProfile } from "./loader";
import { logger } from "../logger";

export class AgentProfileRegistry {
  private profiles = new Map<string, AgentProfile>();

  register(profile: AgentProfile): void {
    if (this.profiles.has(profile.name)) {
      logger.warn(
        { profileName: profile.name },
        "Agent profile already registered; skipping duplicate"
      );
      return;
    }
    this.profiles.set(profile.name, profile);
    logger.debug(
      { profileName: profile.name, version: profile.version },
      "Agent profile registered"
    );
  }

  get(name: string): AgentProfile | undefined {
    return this.profiles.get(name);
  }

  list(): AgentProfile[] {
    return Array.from(this.profiles.values());
  }

  async loadFromDirectory(dirPath: string): Promise<void> {
    let entries: import("fs").Dirent[];
    try {
      entries = await fs.readdir(dirPath, { withFileTypes: true });
    } catch {
      return; // Directory doesn't exist — silently ignore
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (ext !== ".json" && ext !== ".yaml" && ext !== ".yml") continue;
      if (!entry.name.includes(".agent.")) continue; // only *.agent.json / *.agent.yaml
      const filePath = path.join(dirPath, entry.name);
      try {
        const profile = await loadAgentProfile(filePath);
        this.register(profile);
      } catch (err) {
        logger.warn(
          { filePath, error: String(err) },
          "Failed to load agent profile; skipping"
        );
      }
    }
  }
}

export const agentProfileRegistry = new AgentProfileRegistry();
