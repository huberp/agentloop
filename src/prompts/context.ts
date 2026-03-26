import * as fs from "fs/promises";
import { appConfig } from "../config";
import { analyzeWorkspace, type WorkspaceInfo } from "../workspace";
import { loadInstructions, type InstructionBlock } from "../instructions/loader";
import { toolRegistry } from "../tools/registry";
import { skillRegistry, type ActiveSkillFragment } from "../skills/registry";
import { logger } from "../logger";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ToolSummary {
  name: string;
  description: string;
}

export interface PromptContext {
  workspace: WorkspaceInfo;
  tools: ToolSummary[];
  instructions: InstructionBlock[];
  historyDigest: string;
  timestamp: string;
  skills: ActiveSkillFragment[];
}

export type { ActiveSkillFragment };

/** A function that supplies a partial PromptContext. Must be a pure function. */
export type ContextProvider = () => Promise<Partial<PromptContext>>;

// ---------------------------------------------------------------------------
// Provider registry (module-level)
// ---------------------------------------------------------------------------

const providers: ContextProvider[] = [];

export function registerContextProvider(provider: ContextProvider): void {
  providers.push(provider);
}

/** Remove all registered providers. Intended for testing only. */
export function clearContextProviders(): void {
  providers.length = 0;
}

// ---------------------------------------------------------------------------
// Default context
// ---------------------------------------------------------------------------

const DEFAULT_WORKSPACE: WorkspaceInfo = {
  language: "unknown",
  framework: "none",
  packageManager: "unknown",
  hasTests: false,
  testCommand: "",
  lintCommand: "",
  buildCommand: "",
  entryPoints: [],
  gitInitialized: false,
};

// ---------------------------------------------------------------------------
// buildPromptContext
// ---------------------------------------------------------------------------

/**
 * Run all registered providers in parallel, merge their partial results, and
 * return a complete PromptContext.  Arrays (tools, instructions) are
 * accumulated across providers; scalar fields use last-writer-wins.
 */
export async function buildPromptContext(): Promise<PromptContext> {
  const result: PromptContext = {
    workspace: { ...DEFAULT_WORKSPACE },
    tools: [],
    instructions: [],
    historyDigest: "",
    timestamp: new Date().toISOString(),
    skills: [],
  };

  const partials = await Promise.all(providers.map((p) => p()));

  for (const partial of partials) {
    if (partial.workspace !== undefined) result.workspace = partial.workspace;
    if (partial.tools !== undefined) result.tools = [...result.tools, ...partial.tools];
    if (partial.instructions !== undefined)
      result.instructions = [...result.instructions, ...partial.instructions];
    if (partial.historyDigest !== undefined) result.historyDigest = partial.historyDigest;
    if (partial.skills !== undefined) result.skills = [...result.skills, ...partial.skills];
  }

  return result;
}

// ---------------------------------------------------------------------------
// TTL cache
// ---------------------------------------------------------------------------

let cachedContext: PromptContext | null = null;
let cacheExpiresAt = 0;

/**
 * Return the prompt context, rebuilding it when the TTL has elapsed or when
 * `PROMPT_CONTEXT_REFRESH_MS` is 0 (always refresh).
 */
export async function getCachedPromptContext(): Promise<PromptContext> {
  const now = Date.now();
  const ttl = appConfig.promptContextRefreshMs;
  if (cachedContext && ttl !== 0 && now < cacheExpiresAt) {
    return cachedContext;
  }
  cachedContext = await buildPromptContext();
  cacheExpiresAt = ttl === 0 ? 0 : now + ttl;
  return cachedContext;
}

/** Force the cache to be invalidated so the next call to getCachedPromptContext rebuilds. */
export function invalidateContextCache(): void {
  cachedContext = null;
  cacheExpiresAt = 0;
}

// ---------------------------------------------------------------------------
// Built-in providers (registered at module initialisation)
// ---------------------------------------------------------------------------

// 1. Workspace info
registerContextProvider(async () => {
  const workspace = await analyzeWorkspace(appConfig.workspaceRoot);
  return { workspace };
});

// 2. Tool registry summary
registerContextProvider(async () => {
  const tools = toolRegistry.list().map((t) => ({ name: t.name, description: t.description }));
  return { tools };
});

// 3. Active instruction set
registerContextProvider(async () => {
  const set = await loadInstructions(appConfig.instructionsRoot);
  return { instructions: set.getActive() };
});

// 4. Active skill fragments
registerContextProvider(async () => {
  const activeSkills = skillRegistry.listActive();
  const skillFragments: ActiveSkillFragment[] = await Promise.all(
    activeSkills.map(async (skill) => {
      let fragment = skill.promptFragment;
      if (skill.instructions) {
        try {
          const instructionContent = await fs.readFile(skill.instructions, "utf-8");
          fragment = `${fragment}\n\n---\n\n${instructionContent}`;
        } catch {
          logger.warn(
            { skillName: skill.name, instructionsPath: skill.instructions },
            "Skill instructions file not found",
          );
        }
      }
      return { name: skill.name, slot: skill.slot, fragment, tools: skill.tools };
    }),
  );
  const toolsFromSkills: ToolSummary[] = skillFragments.flatMap((sf) =>
    (sf.tools ?? []).map((t) => ({ name: t, description: `Activated by skill: ${sf.name}` })),
  );
  return { skills: skillFragments, tools: toolsFromSkills };
});
