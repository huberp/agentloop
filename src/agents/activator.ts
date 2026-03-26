import { AgentProfile, AgentRuntimeConfig } from "./types";
import { skillRegistry } from "../skills/registry";
import { toolRegistry } from "../tools/registry";
import { logger } from "../logger";

/** Merge two profiles: arrays become deduplicated unions; scalars from `child` win. */
function mergeProfiles(base: AgentProfile, child: AgentProfile): AgentProfile {
  const mergeArrays = <T>(...arrays: (T[] | undefined)[]): T[] =>
    [...new Set(arrays.flatMap((a) => a ?? []))];

  return {
    ...base,
    ...child,
    skills: mergeArrays(base.skills, child.skills),
    tools: mergeArrays(base.tools, child.tools),
    instructions: mergeArrays(base.instructions, child.instructions),
    constraints: {
      ...(base.constraints ?? {}),
      ...(child.constraints ?? {}),
      requireConfirmation: mergeArrays(
        base.constraints?.requireConfirmation,
        child.constraints?.requireConfirmation
      ),
      blockedTools: mergeArrays(
        base.constraints?.blockedTools,
        child.constraints?.blockedTools
      ),
      allowedDomains: mergeArrays(
        base.constraints?.allowedDomains,
        child.constraints?.allowedDomains
      ),
    },
  };
}

export function activateProfile(profile: AgentProfile, base?: AgentProfile): AgentRuntimeConfig {
  const effective = base ? mergeProfiles(base, profile) : profile;

  // Side-effect: activate requested skills
  for (const skillName of effective.skills ?? []) {
    if (!skillRegistry.isActive(skillName)) {
      if (skillRegistry.get(skillName)) {
        skillRegistry.activate(skillName);
        logger.debug({ profileName: profile.name, skillName }, "Skill activated by agent profile");
      } else {
        logger.warn(
          { profileName: profile.name, skillName },
          "Profile requests unknown skill, skipping activation"
        );
      }
    }
  }

  // Compute effective tool list (blocked tools removed)
  const blocked = new Set(effective.constraints?.blockedTools ?? []);
  let activeTools: string[] = effective.tools?.filter((t) => !blocked.has(t)) ?? [];

  // If no tools specified but blocked list is non-empty, start from all tools
  if (effective.tools === undefined && blocked.size > 0) {
    activeTools = toolRegistry
      .list()
      .map((t) => t.name)
      .filter((name) => !blocked.has(name));
  }

  return {
    model: effective.model,
    temperature: effective.temperature,
    maxIterations: effective.maxIterations,
    activeSkills: effective.skills ?? [],
    activeTools,
    constraints: effective.constraints ?? {},
  };
}
