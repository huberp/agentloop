import { appConfig } from "../config";
import { analyzeWorkspace, type WorkspaceInfo } from "../workspace";
import { loadInstructions, type InstructionBlock } from "../instructions/loader";
import { toolRegistry } from "../tools/registry";

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
}

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
  };

  const partials = await Promise.all(providers.map((p) => p()));

  for (const partial of partials) {
    if (partial.workspace !== undefined) result.workspace = partial.workspace;
    if (partial.tools !== undefined) result.tools = [...result.tools, ...partial.tools];
    if (partial.instructions !== undefined)
      result.instructions = [...result.instructions, ...partial.instructions];
    if (partial.historyDigest !== undefined) result.historyDigest = partial.historyDigest;
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
