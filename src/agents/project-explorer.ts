import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

import { logger } from "../logger";
import { ToolRegistry } from "../tools/registry";
import { runSubagent } from "../subagents/runner";
import type { WorkspaceInfo, WorkspaceContext } from "../workspace";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One detected build system within a workspace.
 * A workspace may contain several (e.g. a C++ core + Python bindings).
 */
export interface BuildSystemInfo {
  /** Short identifier for the build system (e.g. 'cargo', 'cmake', 'gradle'). */
  name: string;
  /** Workspace-root-relative path to the primary config file. */
  configFile: string;
  /** Relevant details the planner should use when choosing how to invoke this system. */
  notes: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompt
// ─────────────────────────────────────────────────────────────────────────────

const EXPLORER_SYSTEM_PROMPT =
  `You are a workspace exploration agent. Your job is to analyze a software project's file system ` +
  `using the available tools and produce a structured JSON description of the workspace.\n\n` +
  `Exploration steps (use the tools to gather information):\n` +
  `1. Call file-list with recursive=true to understand the top-level directory structure.\n` +
  `2. Identify key project files (package.json, Cargo.toml, CMakeLists.txt, CMakePresets.json, ` +
  `build.gradle, build.gradle.kts, pom.xml, go.mod, pyproject.toml, requirements.txt, Makefile, etc.).\n` +
  `3. Call file-read on each identified key file to extract language, framework, build system, ` +
  `package manager, and test setup information.\n` +
  `4. A project may contain MORE THAN ONE build system — report all of them.\n\n` +
  `After exploration, respond ONLY with a valid JSON object matching this exact schema (no prose, ` +
  `no markdown fences):\n` +
  `{\n` +
  `  "workspaceInfo": {\n` +
  `    "language": "primary language (node|python|go|rust|java|kotlin|cpp|unknown)",\n` +
  `    "framework": "detected framework or 'none'",\n` +
  `    "packageManager": "package manager (npm|yarn|pnpm|cargo|gradle|maven|poetry|pip|go mod|unknown)",\n` +
  `    "hasTests": true|false,\n` +
  `    "testCommand": "empty string — the planner derives the actual command from buildSystems notes",\n` +
  `    "lintCommand": "empty string — same rationale",\n` +
  `    "buildCommand": "empty string — same rationale",\n` +
  `    "entryPoints": ["list of main entry-point files relative to root, or empty"],\n` +
  `    "gitInitialized": true|false\n` +
  `  },\n` +
  `  "buildSystems": [\n` +
  `    {\n` +
  `      "name": "build system identifier",\n` +
  `      "configFile": "root-relative path to primary config file",\n` +
  `      "notes": "concise details the planner needs: preset names, wrapper scripts, workspace members, etc."\n` +
  `    }\n` +
  `  ],\n` +
  `  "explorerNotes": "optional free-form observations (e.g. multi-language monorepo, unusual layout)"\n` +
  `}\n\n` +
  `Rules:\n` +
  `- Leave testCommand, buildCommand, and lintCommand as empty strings. The planner LLM will derive\n` +
  `  the actual commands from the buildSystems[].notes you provide.\n` +
  `- Include ALL detected build systems. Do not skip secondary ones.\n` +
  `- For CMake: note whether CMakePresets.json exists and list relevant preset names from it.\n` +
  `- For Cargo: note whether it is a workspace (multiple members) or a single crate.\n` +
  `- For Gradle: note whether ./gradlew wrapper is present and whether Kotlin DSL is used.\n` +
  `- For Maven: note whether ./mvnw wrapper is present.\n` +
  `- Produce at least the workspaceInfo object even if no build system was found.`;

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/** Options for `exploreWorkspace()`. */
export interface ExploreWorkspaceOptions {
  /** Tool registry that must contain 'file-list' and 'file-read'. */
  registry: ToolRegistry;
  /** Optional LLM — created from config when omitted. */
  llm?: BaseChatModel;
  /**
   * Maximum LLM iterations for the explorer subagent.
   * Each iteration may call tools; defaults to 10.
   */
  maxIterations?: number;
}

/**
 * Run the ProjectExplorer agent to produce a rich `WorkspaceContext`.
 *
 * The agent uses `file-list` and `file-read` tools to examine the workspace
 * and derives build system information through LLM reasoning — no hardcoded
 * commands are baked in.  The resulting `WorkspaceContext` can be passed
 * directly to `generatePlan()`.
 *
 * If `file-list` or `file-read` are not registered in `registry`, the explorer
 * still runs but the LLM has no tool access; it will produce a best-effort
 * context based on its own knowledge.
 *
 * @param options  Registry, optional LLM, and optional iteration limit.
 */
export async function exploreWorkspace(options: ExploreWorkspaceOptions): Promise<WorkspaceContext> {
  const { registry, llm, maxIterations = 10 } = options;

  const task =
    `Explore the project workspace using file-list and file-read.\n` +
    `Steps:\n` +
    `a) Call file-list (recursive=true) to see the full directory tree.\n` +
    `b) Identify and read all key project manifest / configuration files.\n` +
    `c) Identify all build systems present (there may be more than one).\n` +
    `Then produce the final JSON object as described in the system prompt.`;

  const result = await runSubagent(
    {
      name: "project-explorer",
      systemPrompt: EXPLORER_SYSTEM_PROMPT,
      tools: ["file-list", "file-read"],
      maxIterations,
    },
    task,
    registry,
    llm
  );

  logger.info({ subagent: "project-explorer" }, "Workspace exploration complete");

  return parseExplorerOutput(result.output);
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

function buildFallbackContext(): WorkspaceContext {
  const workspaceInfo: WorkspaceInfo = {
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
  return { workspaceInfo };
}

function parseWorkspaceInfo(raw: unknown): WorkspaceInfo {
  const base: WorkspaceInfo = buildFallbackContext().workspaceInfo;
  if (typeof raw !== "object" || raw === null) return base;
  const obj = raw as Record<string, unknown>;

  return {
    language: typeof obj.language === "string" ? obj.language : base.language,
    framework: typeof obj.framework === "string" ? obj.framework : base.framework,
    packageManager: typeof obj.packageManager === "string" ? obj.packageManager : base.packageManager,
    hasTests: typeof obj.hasTests === "boolean" ? obj.hasTests : base.hasTests,
    testCommand: typeof obj.testCommand === "string" ? obj.testCommand : base.testCommand,
    lintCommand: typeof obj.lintCommand === "string" ? obj.lintCommand : base.lintCommand,
    buildCommand: typeof obj.buildCommand === "string" ? obj.buildCommand : base.buildCommand,
    entryPoints: Array.isArray(obj.entryPoints)
      ? (obj.entryPoints as unknown[]).filter((e): e is string => typeof e === "string")
      : base.entryPoints,
    gitInitialized: typeof obj.gitInitialized === "boolean" ? obj.gitInitialized : base.gitInitialized,
  };
}

function parseExplorerOutput(output: string): WorkspaceContext {
  // Strip optional markdown code fences
  const stripped = output.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    logger.warn(
      { preview: stripped.slice(0, 200) },
      "ProjectExplorer output is not valid JSON; returning fallback context"
    );
    return buildFallbackContext();
  }

  if (typeof parsed !== "object" || parsed === null) {
    return buildFallbackContext();
  }

  const raw = parsed as Record<string, unknown>;
  const workspaceInfo = parseWorkspaceInfo(raw.workspaceInfo);
  const context: WorkspaceContext = { workspaceInfo };

  // Preserve additional discovered data in the context map
  if (raw.buildSystems !== undefined) {
    context.buildSystems = raw.buildSystems as BuildSystemInfo[];
  }
  if (typeof raw.explorerNotes === "string" && raw.explorerNotes.trim() !== "") {
    context.explorerNotes = raw.explorerNotes;
  }

  return context;
}
