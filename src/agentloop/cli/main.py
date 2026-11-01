from __future__ import annotations

import asyncio
import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any, cast

import click
from rich.console import Console

from agentloop.agent import AgentDeps
from agentloop.agents.registry import AgentProfileRegistry
from agentloop.config import Settings
from agentloop.executor import AgentExecutor
from agentloop.tools import BUILTIN_TOOLS_DIR, load_builtin_tool_registry
from agentloop.tools.web_fetch import WebFetchInput, web_fetch
from agentloop.tools.web_search import WebSearchInput, web_search

console = Console()


def _ctx_settings(ctx: click.Context) -> Settings:
    return cast(Settings, ctx.obj["settings"])


@click.group()
@click.option("--api-key", envvar="MISTRAL_API_KEY", default="", help="Override API key")
@click.pass_context
def cli(ctx: click.Context, api_key: str) -> None:
    ctx.ensure_object(dict)
    ctx.obj["settings"] = Settings(mistral_api_key=api_key) if api_key else Settings()


@cli.command()
@click.option("-u", "--user", required=True, help="User prompt")
@click.option("-s", "--system", help="System prompt override")
@click.option("-p", "--profile", help="Agent profile name")
@click.option("--stream", is_flag=True)
@click.option("--json", "json_output", is_flag=True)
@click.pass_context
def agent(
    ctx: click.Context,
    user: str,
    system: str | None,
    profile: str | None,
    stream: bool,
    json_output: bool,
) -> None:
    settings = _ctx_settings(ctx)
    executor = AgentExecutor(settings=settings, system_prompt=system)

    async def run() -> str:
        if stream or settings.streaming_enabled:
            chunks: list[str] = []
            async for token in executor.stream(user, profile=profile):
                chunks.append(token)
                if not json_output:
                    click.echo(token, nl=False)
            if not json_output:
                click.echo()
            return "".join(chunks)
        with console.status("[bold green]Thinking...[/bold green]"):
            return await executor.invoke(user, profile=profile)

    output = asyncio.run(run())
    if json_output:
        click.echo(json.dumps({"output": output}))
    elif not (stream or settings.streaming_enabled):
        click.echo(output)


@cli.command(name="websearch")
@click.option("-q", "--query", required=True)
@click.option("-n", "--max-results", default=5, type=int)
@click.option("--json", "json_output", is_flag=True)
@click.pass_context
def websearch(ctx: click.Context, query: str, max_results: int, json_output: bool) -> None:
    settings = _ctx_settings(ctx)

    async def run() -> str:
        deps = AgentDeps(settings=settings, workspace_root=settings.workspace_root)
        payload = await web_search(
            cast(Any, SimpleNamespace(deps=deps)),
            WebSearchInput(query=query, max_results=max_results),
        )
        return str(payload)

    output = asyncio.run(run())
    if json_output:
        click.echo(output)
    else:
        for item in json.loads(output):
            click.echo(f"- {item['title']}: {item['link']}")


@cli.command(name="web-fetch")
@click.option("-u", "--url", required=True)
@click.option("--json", "json_output", is_flag=True)
@click.pass_context
def web_fetch_command(ctx: click.Context, url: str, json_output: bool) -> None:
    settings = _ctx_settings(ctx)

    async def run() -> str:
        deps = AgentDeps(settings=settings, workspace_root=settings.workspace_root)
        return str(await web_fetch(cast(Any, SimpleNamespace(deps=deps)), WebFetchInput(url=url)))

    output = asyncio.run(run())
    if json_output:
        click.echo(output)
    else:
        payload = json.loads(output)
        click.echo(payload.get("content") or payload.get("title") or output)


@cli.command(name="list")
@click.argument("capability", type=click.Choice(["tools", "agentprofiles", "skills", "providers"]))
@click.option("--json", "json_output", is_flag=True)
@click.option("--verbose", is_flag=True)
@click.pass_context
def list_command(ctx: click.Context, capability: str, json_output: bool, verbose: bool) -> None:
    settings = _ctx_settings(ctx)

    async def run() -> list[dict[str, Any]]:
        if capability == "tools":
            tool_registry = await load_builtin_tool_registry()
            return cast(
                list[dict[str, Any]],
                tool_registry.get_all() if verbose else tool_registry.list(),
            )
        if capability == "agentprofiles":
            profile_registry = AgentProfileRegistry()
            await profile_registry.load_from_directory(Path("src/agentloop/agents/builtin"))
            return [
                profile.model_dump() if verbose else {"name": profile.name, "description": profile.description}
                for profile in profile_registry.list()
            ]
        if capability == "skills":
            skills_root = Path("src/agentloop/skills/builtin")
            return [{"name": path.name} for path in sorted(skills_root.iterdir()) if path.is_dir()]
        return [
            {
                "llm_provider": settings.llm_provider,
                "search_provider": settings.web_search_provider,
                "mcp_servers": [server.name for server in settings.mcp_servers],
            }
        ]

    output = asyncio.run(run())
    if json_output:
        click.echo(json.dumps(output))
    else:
        for item in output:
            click.echo(
                json.dumps(item)
                if verbose
                else next(iter(item.values())) if len(item) == 1 else json.dumps(item)
            )


def main() -> None:
    cli()


if __name__ == "__main__":
    main()
