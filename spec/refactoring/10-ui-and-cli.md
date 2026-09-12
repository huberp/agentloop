# Phase 10 — UI & CLI

## Objective

Replace the TypeScript/Node.js CLI (`start-cli.ts`), one-shot runner (`start-oneshot.ts`), and Ink TUI (`ui/tui.ts`) with Python equivalents using `click` (CLI) and `textual` (TUI).

---

## Background

### Current Architecture

```
src/start-cli.ts        readline CLI loop
src/start-tui.ts        Ink TUI launcher
src/ui/tui.ts           Ink/React multi-pane TUI
src/start-oneshot.ts    parseArgs-based one-shot subcommands
src/spinner.ts          ora spinner wrapper
```

### Replacement Stack

| TypeScript | Python |
|---|---|
| `readline` (Node stdlib) | `prompt_toolkit` or simple `input()` loop |
| `ink` + React TUI | `textual` TUI framework |
| `parseArgs` (Node stdlib) | `click` CLI framework |
| `ora` spinner | `rich.progress.Progress` or `click.progressbar` |

---

## Deliverables

### 10.1 — CLI Entry Point (`src/agentloop/cli/main.py`)

```python
import asyncio
import click
from agentloop.executor import AgentExecutor

@click.group()
@click.option("--api-key", envvar="MISTRAL_API_KEY", help="Override API key")
@click.pass_context
def cli(ctx, api_key): ...

@cli.command()
@click.option("-u", "--user", required=True, help="User prompt")
@click.option("-s", "--system", help="System prompt override")
@click.option("-p", "--profile", help="Agent profile name")
@click.option("--stream", is_flag=True)
@click.option("--json", "json_output", is_flag=True)
def agent(user, system, profile, stream, json_output): ...

@cli.command()
@click.option("-q", "--query", required=True)
@click.option("-n", "--max-results", default=5)
@click.option("--json", "json_output", is_flag=True)
def websearch(query, max_results, json_output): ...

@cli.command()
@click.option("-u", "--url", required=True)
@click.option("--json", "json_output", is_flag=True)
def web_fetch(url, json_output): ...

@cli.command()
@click.argument("capability", type=click.Choice(["tools", "agentprofiles", "skills", "providers"]))
@click.option("--json", "json_output", is_flag=True)
@click.option("--verbose", is_flag=True)
def list(capability, json_output, verbose): ...
```

Matches every subcommand and flag of the current `start-oneshot.ts`:
- `agent` → same flags (`-u`, `-s`, `-p`, `--stream`, `--json`)
- `websearch` → same flags (`-q`, `-n`, `--json`)
- `web-fetch` → same flags (`-u`, `--json`)
- `list` → same capabilities (`tools`, `agentprofiles`, `skills`, `providers`)

### 10.2 — Interactive CLI (`src/agentloop/cli/interactive.py`)

```python
async def run_interactive():
    executor = AgentExecutor()
    await executor.initialize()
    while True:
        user_input = input("You: ").strip()
        if user_input.lower() in ("exit", "quit"):
            break
        if executor.settings.streaming_enabled:
            async for token in executor.stream(user_input):
                print(token, end="", flush=True)
            print()
        else:
            result = await executor.invoke(user_input)
            print(f"Agent: {result}")
```

Replaces `start-cli.ts` readline loop.

### 10.3 — Spinner / Progress

Use `rich.console.Console` with a `rich.spinner.Spinner` for the "thinking…" indicator during non-streaming invocations.

```python
from rich.console import Console
console = Console()

with console.status("[bold green]Thinking...[/bold green]"):
    result = await executor.invoke(user_input)
```

Replaces `spinner.ts`.

### 10.4 — TUI (`src/agentloop/cli/tui.py`)

Use `textual` to build a multi-pane TUI with:
- Top pane: conversation history
- Bottom pane: input box
- Side pane: tool call log

The TUI is feature-equivalent to the Ink TUI (`ui/tui.ts`). Layout and colour scheme should match as closely as possible.

### 10.5 — `pyproject.toml` Entry Points

```toml
[project.scripts]
agentloop = "agentloop.cli.main:cli"
agentloop-tui = "agentloop.cli.tui:run_tui"
```

Equivalent to `npm run startCli` / `npm run startTui` / `npm run oneshot`.

### 10.6 — `--api-key` Global Flag

`click.option("--api-key")` at the group level updates `settings.mistral_api_key` before any subcommand runs — same behaviour as the TypeScript `applyApiKeyOverride()`.

---

## Acceptance Criteria

- [ ] `agentloop agent -u "Hello"` returns a response.
- [ ] `agentloop agent --stream -u "Hello"` streams tokens.
- [ ] `agentloop list tools` prints all registered tools.
- [ ] `agentloop list providers` shows configured LLM and search providers.
- [ ] `agentloop websearch -q "pydantic"` returns results.
- [ ] `agentloop web-fetch -u "https://example.com"` returns markdown.
- [ ] `agentloop agent --json -u "2+2"` outputs `{"output": "4"}`.
- [ ] Interactive CLI reads input, prints output, exits on `exit`.

---

## Files Changed / Created

| Action | Path |
|---|---|
| Create | `src/agentloop/cli/__init__.py` |
| Create | `src/agentloop/cli/main.py` |
| Create | `src/agentloop/cli/interactive.py` |
| Create | `src/agentloop/cli/tui.py` |
| Update | `pyproject.toml` (entry points) |
| Create | `tests/test_cli.py` |
| Delete (later) | `src/start-cli.ts`, `src/start-tui.ts`, `src/start-oneshot.ts`, `src/spinner.ts`, `src/ui/tui.ts` |

---

## Dependencies Added

| Package | Purpose |
|---|---|
| `click` | CLI argument parsing |
| `rich` | Console output, spinners, tables |
| `textual` | TUI framework |
| `prompt_toolkit` | Optional readline-compatible input for interactive CLI |

## Dependencies Removed

- `ink` (npm) — React TUI
- `react` (npm)
- `ora` (npm) — spinner
