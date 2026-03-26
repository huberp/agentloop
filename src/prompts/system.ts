import * as fs from "fs/promises";
import { appConfig } from "../config";
import type { WorkspaceInfo } from "../workspace";
import type { InstructionBlock } from "../instructions/loader";
import { promptRegistry } from "./registry";
import type { ActiveSkillFragment } from "../skills/registry";

/** Optional context for prompt generation. */
export interface SystemPromptContext {
  /** Names of the tools currently available to the agent. */
  tools?: string[];
  /** Brief project or task description to include in the prompt. */
  projectInfo?: string;
  /** Workspace analysis result injected so the LLM understands the project. */
  workspace?: WorkspaceInfo;
  /** Active instruction blocks to append to the prompt. */
  instructions?: InstructionBlock[];
  /** Active skill fragments to inject into the rendered prompt. */
  skills?: ActiveSkillFragment[];
}

// ---------------------------------------------------------------------------
// Default "system" template
// ---------------------------------------------------------------------------

const SYSTEM_TEMPLATE =
  `You are a helpful AI assistant agent.` +
  `{{projectSection}}` +
  `{{workspaceSection}}\n` +
  `{{toolList}}\n` +
  `Always prefer using a tool when it can provide a more accurate or up-to-date answer.\n` +
  `Be concise, precise, and honest in your responses.` +
  `{{instructionsSection}}`;

/** Register the built-in system template (idempotent). */
function ensureSystemTemplateRegistered(): void {
  if (!promptRegistry.get("system")) {
    promptRegistry.register({
      name: "system",
      description: "Default system prompt for the agent loop",
      template: SYSTEM_TEMPLATE,
      variables: ["projectSection", "workspaceSection", "toolList", "instructionsSection"],
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers that turn SystemPromptContext into render-ready variables
// ---------------------------------------------------------------------------

/** Build the render context from a SystemPromptContext. */
function buildRenderContext(context: SystemPromptContext): Record<string, string> {
  const toolList =
    context.tools && context.tools.length > 0
      ? `You have access to the following tools: ${context.tools.join(", ")}.`
      : "You have no tools available.";

  const projectSection = context.projectInfo
    ? `\nProject context: ${context.projectInfo}`
    : "";

  const workspaceSection = context.workspace
    ? buildWorkspaceSection(context.workspace)
    : "";

  const instructionsSection = buildInstructionsSection(context.instructions);

  return { toolList, projectSection, workspaceSection, instructionsSection };
}

/** Format a WorkspaceInfo object into a human-readable prompt section. */
function buildWorkspaceSection(ws: WorkspaceInfo): string {
  const lines: string[] = ["\nWorkspace context:"];
  lines.push(`  Language: ${ws.language}`);
  if (ws.framework !== "none") lines.push(`  Framework: ${ws.framework}`);
  lines.push(`  Package manager: ${ws.packageManager}`);
  if (ws.testCommand) lines.push(`  Test command: ${ws.testCommand}`);
  if (ws.lintCommand) lines.push(`  Lint command: ${ws.lintCommand}`);
  if (ws.buildCommand) lines.push(`  Build command: ${ws.buildCommand}`);
  if (ws.entryPoints.length > 0) lines.push(`  Entry points: ${ws.entryPoints.join(", ")}`);
  lines.push(`  Git initialized: ${ws.gitInitialized}`);
  return lines.join("\n");
}

/** Format active instruction blocks into a prompt section. */
function buildInstructionsSection(instructions?: InstructionBlock[]): string {
  if (!instructions || instructions.length === 0) return "";
  const parts = instructions.map((b) => b.body);
  return "\n\n## Instructions\n\n" + parts.join("\n\n");
}

/**
 * Return the system prompt to use for the agent.
 *
 * If `SYSTEM_PROMPT_PATH` is configured, the file at that path is read and
 * returned as-is (allows full operator control over the prompt).
 * Otherwise the "system" template in the prompt registry is rendered
 * with the provided context.
 */
export async function getSystemPrompt(context: SystemPromptContext = {}): Promise<string> {
  const promptPath = appConfig.systemPromptPath;

  if (promptPath) {
    // Load operator-supplied prompt from file; let errors propagate so
    // misconfiguration is visible immediately at startup.
    return fs.readFile(promptPath, "utf-8");
  }

  ensureSystemTemplateRegistered();
  const skillFragments = context.skills ?? [];
  return promptRegistry.render("system", buildRenderContext(context), skillFragments);
}

