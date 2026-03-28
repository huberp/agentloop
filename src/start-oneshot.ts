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
    `Usage: agentloop list [target]

Targets:
  tools          List all registered tools (default)
  agentprofiles  List all registered agent profiles
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

async function runList(args: string[]): Promise<void> {
  const target = args[0] ?? "tools";

  const { ensureInitialized, toolRegistry, agentProfileRegistry } = await import("./index");
  await ensureInitialized();

  if (target === "tools") {
    const tools = toolRegistry.list();
    process.stdout.write(`Available tools (${tools.length}):\n`);
    for (const t of tools) {
      process.stdout.write(`  ${t.name}  ${t.description}\n`);
    }
  } else if (target === "agentprofiles") {
    const profiles = agentProfileRegistry.list();
    if (profiles.length === 0) {
      process.stdout.write("No agent profiles found.\n");
    } else {
      process.stdout.write(`Available agent profiles (${profiles.length}):\n`);
      for (const p of profiles) {
        process.stdout.write(`  ${p.name}  ${p.description}\n`);
      }
    }
  } else {
    process.stderr.write(`Unknown list target: "${target}". Valid targets: tools, agentprofiles\n`);
    process.exit(1);
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
