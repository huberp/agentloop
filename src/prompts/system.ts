import * as fs from "fs/promises";
import { appConfig } from "../config";
import type { WorkspaceInfo } from "../workspace";

/** Optional context for prompt generation. */
export interface SystemPromptContext {
  /** Names of the tools currently available to the agent. */
  tools?: string[];
  /** Brief project or task description to include in the prompt. */
  projectInfo?: string;
  /** Workspace analysis result injected so the LLM understands the project. */
  workspace?: WorkspaceInfo;
}

/**
 * Build the base system prompt from a template.
 * Includes agent identity, available tool names, and behavioral instructions.
 */
function buildBasePrompt(context: SystemPromptContext): string {
  const toolList =
    context.tools && context.tools.length > 0
      ? `You have access to the following tools: ${context.tools.join(", ")}.`
      : "You have no tools available.";

  const projectSection = context.projectInfo
    ? `\nProject context: ${context.projectInfo}`
    : "";

  // Format workspace info as a concise context block when provided
  const workspaceSection = context.workspace
    ? buildWorkspaceSection(context.workspace)
    : "";

  return (
    `You are a helpful AI assistant agent.${projectSection}${workspaceSection}\n` +
    `${toolList}\n` +
    `Always prefer using a tool when it can provide a more accurate or up-to-date answer.\n` +
    `Be concise, precise, and honest in your responses.`
  );
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

/**
 * Return the system prompt to use for the agent.
 *
 * If `SYSTEM_PROMPT_PATH` is configured, the file at that path is read and
 * returned as-is (allows full operator control over the prompt).
 * Otherwise a template-based prompt is generated from the provided context.
 */
export async function getSystemPrompt(context: SystemPromptContext = {}): Promise<string> {
  const promptPath = appConfig.systemPromptPath;

  if (promptPath) {
    // Load operator-supplied prompt from file; let errors propagate so
    // misconfiguration is visible immediately at startup.
    return fs.readFile(promptPath, "utf-8");
  }

  return buildBasePrompt(context);
}

