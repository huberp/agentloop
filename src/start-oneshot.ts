/**
 * One-shot CLI entry point for agentloop.
 *
 * Parses a subcommand from process.argv, performs a single operation, prints
 * the result to stdout, and exits — making agentloop scriptable in pipelines
 * and CI workflows.
 *
 * Usage:
 *   npx tsx src/start-oneshot.ts <command> [options]
 *
 * Commands:
 *   agent       Run the full agentic loop once and exit
 *   websearch   Invoke the web-search tool directly
 *   web-fetch   Invoke the web-fetch tool directly
 *   list        List registered tools, agent profiles, or other capabilities
 */

import { parseArgs } from "util";

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

function printHelp(): void {
  process.stdout.write(
    `Usage: agentloop <command> [options]

Commands:
  agent         Run the full agentic loop once and exit
  websearch     Invoke the web-search tool directly
  web-fetch     Invoke the web-fetch tool directly
  list          List tools, agent profiles, or other capabilities

Run 'agentloop <command> --help' for command-specific options.
`
  );
}

function printAgentHelp(): void {
  process.stdout.write(
    `Usage: agentloop agent [options]

Options:
  -s, --system <text>    Override the system prompt
  -u, --user <text>      User prompt / task (required)
  -p, --profile <name>   Agent profile to activate (e.g. coder, planner)
      --stream           Stream output tokens to stdout
      --json             Output result as JSON { "output": "..." }
`
  );
}

function printWebSearchHelp(): void {
  process.stdout.write(
    `Usage: agentloop websearch [options]

Options:
  -q, --query <text>     Search query (required)
  -n, --max-results <n>  Maximum results to return (default: provider default)
      --json             Output raw JSON result array
`
  );
}

function printWebFetchHelp(): void {
  process.stdout.write(
    `Usage: agentloop web-fetch [options]

Options:
  -u, --url <url>        URL to fetch (required)
      --json             Output raw JSON { title, markdown, ... }
`
  );
}

function printListHelp(): void {
  process.stdout.write(
    `Usage: agentloop list <capability> [options]

Capabilities:
  tools          All registered tools (built-in + MCP + custom)
  agentprofiles  All loaded agent profiles (built-in + user-defined)
  skills         All active skills (built-in + user-defined)
  providers      Configured LLM and search providers with their status

Options:
      --json     Output as JSON array instead of table
      --verbose  Include full description, permissions, source path, and metadata
`
  );
}

// ---------------------------------------------------------------------------
// Subcommand handlers
// ---------------------------------------------------------------------------

async function runAgent(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      system: { type: "string", short: "s" },
      user: { type: "string", short: "u" },
      profile: { type: "string", short: "p" },
      stream: { type: "boolean" },
      json: { type: "boolean" },
    },
    strict: true,
    allowPositionals: false,
  });

  if (!values.user) {
    process.stderr.write("Error: --user / -u <text> is required\n");
    process.exit(1);
  }

  const { agentExecutor } = await import("./index");

  const runOptions: import("./index").AgentRunOptions | undefined = values.system
    ? { systemPromptOverride: values.system }
    : undefined;
  const profileName = values.profile ?? undefined;

  if (values.stream) {
    let accumulated = "";
    for await (const chunk of agentExecutor.stream(values.user, profileName, runOptions)) {
      if (values.json) {
        accumulated += chunk;
      } else {
        process.stdout.write(chunk);
      }
    }
    if (values.json) {
      process.stdout.write(JSON.stringify({ output: accumulated }) + "\n");
    } else {
      process.stdout.write("\n");
    }
  } else {
    const result = await agentExecutor.invoke(values.user, profileName, runOptions);
    if (values.json) {
      process.stdout.write(JSON.stringify({ output: result.output }) + "\n");
    } else {
      process.stdout.write(result.output + "\n");
    }
  }
}

async function runWebSearch(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      query: { type: "string", short: "q" },
      "max-results": { type: "string", short: "n" },
      json: { type: "boolean" },
    },
    strict: true,
    allowPositionals: false,
  });

  if (!values.query) {
    process.stderr.write("Error: --query / -q <text> is required\n");
    process.exit(1);
  }

  const { ensureInitialized, toolRegistry } = await import("./index");
  await ensureInitialized();

  const searchTool = toolRegistry.get("search");
  if (!searchTool) {
    process.stderr.write("Error: search tool is not available\n");
    process.exit(1);
  }

  const toolArgs: Record<string, unknown> = { query: values.query };
  const maxResults = values["max-results"] ? parseInt(values["max-results"], 10) : undefined;
  if (maxResults !== undefined && maxResults > 0) {
    toolArgs.maxResults = maxResults;
  }

  const rawResult = await searchTool.invoke(toolArgs);

  if (values.json) {
    process.stdout.write(rawResult + "\n");
  } else {
    try {
      const items = JSON.parse(rawResult) as Array<{ title: string; link: string; snippet: string }>;
      for (const item of items) {
        process.stdout.write(`Title:   ${item.title}\nURL:     ${item.link}\nSnippet: ${item.snippet}\n\n`);
      }
    } catch {
      process.stdout.write(rawResult + "\n");
    }
  }
}

async function runWebFetch(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      url: { type: "string", short: "u" },
      json: { type: "boolean" },
    },
    strict: true,
    allowPositionals: false,
  });

  if (!values.url) {
    process.stderr.write("Error: --url / -u <url> is required\n");
    process.exit(1);
  }

  const { ensureInitialized, toolRegistry } = await import("./index");
  await ensureInitialized();

  const fetchTool = toolRegistry.get("web_fetch");
  if (!fetchTool) {
    process.stderr.write("Error: web_fetch tool is not available\n");
    process.exit(1);
  }

  const rawResult = await fetchTool.invoke({ url: values.url });

  if (values.json) {
    process.stdout.write(rawResult + "\n");
  } else {
    try {
      const parsed = JSON.parse(rawResult) as Record<string, unknown>;
      if (typeof parsed.error === "string") {
        process.stderr.write(`Error: ${parsed.error}\n`);
        process.exit(1);
      }
      const content = typeof parsed.markdown === "string" ? parsed.markdown : rawResult;
      process.stdout.write(content + "\n");
    } catch {
      process.stdout.write(rawResult + "\n");
    }
  }
}

// ---------------------------------------------------------------------------
// list command helpers
// ---------------------------------------------------------------------------

/** Pad a string to a fixed width (truncate if too long, pad if too short). */
function col(value: string, width: number): string {
  if (value.length > width) return value.slice(0, width - 1) + "…";
  return value.padEnd(width);
}

/** Render a horizontal rule the same width as the header row. */
function ruleLine(width: number): string {
  return "─".repeat(width) + "\n";
}

// ---------------------------------------------------------------------------
// list subcommand handlers
// ---------------------------------------------------------------------------

function listTools(
  json: boolean,
  verbose: boolean,
  tools: Array<{
    name: string;
    description: string;
    permissions: "safe" | "cautious" | "dangerous";
    source: "built-in" | "custom" | "mcp" | undefined;
    filePath: string | undefined;
  }>
): void {
  if (json) {
    process.stdout.write(JSON.stringify(tools, null, 2) + "\n");
    return;
  }

  if (verbose) {
    const header = `${"NAME".padEnd(24)}  ${"PERMISSION".padEnd(12)}  ${"SOURCE".padEnd(10)}  DESCRIPTION`;
    process.stdout.write(header + "\n");
    process.stdout.write(ruleLine(header.length));
    for (const t of tools) {
      const line = `${col(t.name, 24)}  ${col(t.permissions ?? "safe", 12)}  ${col(t.source ?? "—", 10)}  ${t.description}`;
      process.stdout.write(line + "\n");
      if (t.filePath) {
        process.stdout.write(`  ${"".padEnd(24)}  ${"".padEnd(12)}  path: ${t.filePath}\n`);
      }
    }
    return;
  }

  const header = `${"NAME".padEnd(22)}  ${"PERMISSION".padEnd(12)}  ${"SOURCE".padEnd(10)}  DESCRIPTION`;
  process.stdout.write(header + "\n");
  process.stdout.write(ruleLine(header.length));
  for (const t of tools) {
    process.stdout.write(
      `${col(t.name, 22)}  ${col(t.permissions ?? "safe", 12)}  ${col(t.source ?? "—", 10)}  ${t.description}\n`
    );
  }
}

function listAgentProfiles(
  json: boolean,
  verbose: boolean,
  profiles: Array<{
    name: string;
    description: string;
    source?: "built-in" | "custom";
    filePath?: string;
    skills?: string[];
    model?: string;
    temperature?: number;
  }>
): void {
  if (json) {
    process.stdout.write(JSON.stringify(profiles, null, 2) + "\n");
    return;
  }

  if (verbose) {
    const header = `${"NAME".padEnd(20)}  ${"SOURCE".padEnd(10)}  ${"SKILLS".padEnd(30)}  DESCRIPTION`;
    process.stdout.write(header + "\n");
    process.stdout.write(ruleLine(header.length));
    for (const p of profiles) {
      const skillsStr = p.skills && p.skills.length > 0 ? p.skills.join(", ") : "—";
      process.stdout.write(
        `${col(p.name, 20)}  ${col(p.source ?? "—", 10)}  ${col(skillsStr, 30)}  ${p.description}\n`
      );
      if (p.filePath) {
        process.stdout.write(`  path: ${p.filePath}\n`);
      }
      if (p.model) {
        process.stdout.write(`  model: ${p.model}\n`);
      }
      if (p.temperature !== undefined) {
        process.stdout.write(`  temperature: ${p.temperature}\n`);
      }
    }
    return;
  }

  const header = `${"NAME".padEnd(20)}  ${"SOURCE".padEnd(10)}  ${"SKILLS".padEnd(30)}  DESCRIPTION`;
  process.stdout.write(header + "\n");
  process.stdout.write(ruleLine(header.length));
  for (const p of profiles) {
    const skillsStr = p.skills && p.skills.length > 0 ? p.skills.join(", ") : "—";
    process.stdout.write(
      `${col(p.name, 20)}  ${col(p.source ?? "—", 10)}  ${col(skillsStr, 30)}  ${p.description}\n`
    );
  }
}

function listSkills(
  json: boolean,
  verbose: boolean,
  skills: Array<{
    name: string;
    description: string;
    source?: "built-in" | "custom";
    filePath?: string;
    tools?: string[];
  }>
): void {
  if (json) {
    process.stdout.write(JSON.stringify(skills, null, 2) + "\n");
    return;
  }

  if (verbose) {
    const header = `${"NAME".padEnd(24)}  ${"SOURCE".padEnd(10)}  DESCRIPTION`;
    process.stdout.write(header + "\n");
    process.stdout.write(ruleLine(header.length));
    for (const s of skills) {
      process.stdout.write(`${col(s.name, 24)}  ${col(s.source ?? "—", 10)}  ${s.description}\n`);
      if (s.filePath) {
        process.stdout.write(`  path: ${s.filePath}\n`);
      }
      if (s.tools && s.tools.length > 0) {
        process.stdout.write(`  tools: ${s.tools.join(", ")}\n`);
      }
    }
    return;
  }

  const header = `${"NAME".padEnd(24)}  ${"SOURCE".padEnd(10)}  DESCRIPTION`;
  process.stdout.write(header + "\n");
  process.stdout.write(ruleLine(header.length));
  for (const s of skills) {
    process.stdout.write(`${col(s.name, 24)}  ${col(s.source ?? "—", 10)}  ${s.description}\n`);
  }
}

interface ProviderEntry {
  type: string;
  name: string;
  status: "active" | "inactive";
  note: string;
}

function buildProviderList(appCfg: {
  llmProvider: string;
  mistralApiKey: string;
  webSearchProvider: string;
  tavilyApiKey: string;
  langsearchApiKey: string;
}): ProviderEntry[] {
  const entries: ProviderEntry[] = [];

  // LLM provider
  const llmProvider = appCfg.llmProvider ?? "mistral";
  const llmKey = llmProvider === "mistral" ? appCfg.mistralApiKey : "";
  entries.push({
    type: "llm",
    name: llmProvider,
    status: llmKey ? "active" : "inactive",
    note: llmKey ? `MISTRAL_API_KEY set` : `MISTRAL_API_KEY not set`,
  });

  // Search providers
  const searchProvider = appCfg.webSearchProvider ?? "duckduckgo";

  entries.push({
    type: "search",
    name: "duckduckgo",
    status: "active",
    note: `no key required${searchProvider === "duckduckgo" ? " (active provider)" : ""}`,
  });

  entries.push({
    type: "search",
    name: "tavily",
    status: appCfg.tavilyApiKey ? "active" : "inactive",
    note: appCfg.tavilyApiKey
      ? `TAVILY_API_KEY set${searchProvider === "tavily" ? " (active provider)" : ""}`
      : "TAVILY_API_KEY not set",
  });

  entries.push({
    type: "search",
    name: "langsearch",
    status: appCfg.langsearchApiKey ? "active" : "inactive",
    note: appCfg.langsearchApiKey
      ? `LANGSEARCH_API_KEY set${searchProvider === "langsearch" ? " (active provider)" : ""}`
      : "LANGSEARCH_API_KEY not set",
  });

  return entries;
}

function listProviders(json: boolean, _verbose: boolean, providers: ProviderEntry[]): void {
  if (json) {
    process.stdout.write(JSON.stringify(providers, null, 2) + "\n");
    return;
  }

  const header = `${"TYPE".padEnd(8)}  ${"NAME".padEnd(14)}  ${"STATUS".padEnd(12)}  NOTE`;
  process.stdout.write(header + "\n");
  process.stdout.write(ruleLine(header.length));
  for (const p of providers) {
    // Use a fixed-width status label: "✅ active" vs "⚠ inactive", then pad to align NOTE column.
    const statusLabel = p.status === "active" ? "✅ active" : "⚠ inactive";
    // Pad with spaces accounting for the narrower "✅ active" vs "⚠ inactive"
    const statusPadded = p.status === "active" ? statusLabel + "  " : statusLabel + " ";
    process.stdout.write(
      `${col(p.type, 8)}  ${col(p.name, 14)}  ${statusPadded} ${p.note}\n`
    );
  }
}

async function runList(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      json: { type: "boolean" },
      verbose: { type: "boolean" },
    },
    strict: true,
    allowPositionals: true,
  });

  const capability = positionals[0] ?? "tools";
  const asJson = values.json ?? false;
  const verbose = values.verbose ?? false;

  const SUPPORTED = ["tools", "agentprofiles", "skills", "providers"];

  if (!SUPPORTED.includes(capability)) {
    process.stderr.write(
      `Unknown capability: "${capability}". Supported values: ${SUPPORTED.join(", ")}\n`
    );
    process.exit(1);
  }

  const { ensureInitialized, toolRegistry, agentProfileRegistry, skillRegistry } =
    await import("./index");
  await ensureInitialized();

  switch (capability) {
    case "tools": {
      const tools = toolRegistry.getAll();
      listTools(asJson, verbose, tools);
      break;
    }
    case "agentprofiles": {
      const profiles = agentProfileRegistry.getAll();
      listAgentProfiles(asJson, verbose, profiles);
      break;
    }
    case "skills": {
      const skills = skillRegistry.getAll();
      listSkills(asJson, verbose, skills);
      break;
    }
    case "providers": {
      const { appConfig } = await import("./config");
      const providers = buildProviderList(appConfig);
      listProviders(asJson, verbose, providers);
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const [, , subcommand, ...rest] = process.argv;

  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    printHelp();
    process.exit(subcommand ? 0 : 1);
  }

  // Handle per-subcommand --help before delegating to the handler (parseArgs
  // with strict:true would throw on unknown flags including --help).
  if (rest.includes("--help") || rest.includes("-h")) {
    switch (subcommand) {
      case "agent":
        printAgentHelp();
        break;
      case "websearch":
        printWebSearchHelp();
        break;
      case "web-fetch":
        printWebFetchHelp();
        break;
      case "list":
        printListHelp();
        break;
      default:
        printHelp();
    }
    process.exit(0);
  }

  switch (subcommand) {
    case "agent":
      await runAgent(rest);
      break;
    case "websearch":
      await runWebSearch(rest);
      break;
    case "web-fetch":
      await runWebFetch(rest);
      break;
    case "list":
      await runList(rest);
      break;
    default:
      process.stderr.write(`Unknown command: "${subcommand}"\n\n`);
      printHelp();
      process.exit(1);
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`Error: ${message}\n`);
  process.exit(1);
});
