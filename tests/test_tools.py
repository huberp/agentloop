from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from pydantic_ai import Agent
from pydantic_ai.models.test import TestModel
from pydantic_ai.tools import Tool

from agentloop.agent import AgentDeps
from agentloop.tools import BUILTIN_TOOLS_DIR
from agentloop.tools.calculate import CalculateInput, calculate
from agentloop.tools.file_delete import FileDeleteInput, file_delete
from agentloop.tools.file_edit import FileEditInput, file_edit
from agentloop.tools.file_list import FileListInput, file_list
from agentloop.tools.file_read import FileReadInput, file_read
from agentloop.tools.file_write import FileWriteInput, file_write
from agentloop.tools.registry import ToolRegistry
from agentloop.tools.search import SearchInput, search
from agentloop.tools.web_fetch import WebFetchInput, web_fetch
from agentloop.tools.web_search import WebSearchInput, web_search


class DummyResult:
    def __init__(self, **payload: str) -> None:
        self._payload = payload

    def model_dump(self) -> dict[str, str]:
        return dict(self._payload)


def make_ctx(test_settings) -> SimpleNamespace:
    return SimpleNamespace(
        deps=AgentDeps(settings=test_settings, workspace_root=test_settings.workspace_root)
    )


@pytest.mark.asyncio
async def test_file_tools_round_trip(test_settings) -> None:
    ctx = make_ctx(test_settings)
    await file_write(ctx, FileWriteInput(path="demo.txt", content="alpha\nbeta\n"))
    read_payload = json.loads(await file_read(ctx, FileReadInput(path="demo.txt", start_line=2)))
    assert read_payload["content"] == "beta"
    await file_edit(ctx, FileEditInput(path="demo.txt", search="beta", replace="gamma"))
    listed = json.loads(await file_list(ctx, FileListInput(path=".")))
    assert any(entry["path"] == "demo.txt" for entry in listed["entries"])
    await file_delete(ctx, FileDeleteInput(path="demo.txt"))
    assert not (test_settings.workspace_root / "demo.txt").exists()


@pytest.mark.asyncio
async def test_calculate_returns_result(test_settings) -> None:
    ctx = make_ctx(test_settings)
    assert await calculate(ctx, CalculateInput(expression="2 + 3 * 4")) == "14"


@pytest.mark.asyncio
async def test_registry_discovers_builtin_tools() -> None:
    registry = ToolRegistry()
    await registry.load_from_directory(BUILTIN_TOOLS_DIR, source="built-in")
    names = {item["name"] for item in registry.list()}
    assert {"file_read", "file_write", "shell", "web_search", "git_status"} <= names
    tools = registry.to_pydantic_ai_tools()
    assert tools and all(isinstance(tool, Tool) for tool in tools)
    Agent(TestModel(custom_output_text="ok"), tools=tools, defer_model_check=True)


@pytest.mark.asyncio
async def test_code_search_finds_content(test_settings) -> None:
    from agentloop.tools.code_search import CodeSearchInput, code_search

    ctx = make_ctx(test_settings)
    (test_settings.workspace_root / "pkg").mkdir()
    (test_settings.workspace_root / "pkg" / "mod.py").write_text("hello\nneedle here\n")
    payload = json.loads(await code_search(ctx, CodeSearchInput(pattern="needle", path="pkg")))
    assert payload["matches"][0]["file"] == "mod.py"


@pytest.mark.asyncio
async def test_web_tools_wrap_common_tools(test_settings, monkeypatch: pytest.MonkeyPatch) -> None:
    from agentloop.tools import web_fetch as web_fetch_module
    from agentloop.tools import web_search as web_search_module

    async def fake_search(query: str) -> list[dict[str, str]]:
        return [{"title": query, "href": "https://example.com", "body": "snippet"}]

    async def fake_fetch(url: str) -> DummyResult:
        return DummyResult(url=url, title="Example", content="# Demo")

    monkeypatch.setattr(
        web_search_module,
        "duckduckgo_search_tool",
        lambda max_results=None: SimpleNamespace(function=fake_search),
    )
    monkeypatch.setattr(
        web_fetch_module,
        "web_fetch_tool",
        lambda **kwargs: SimpleNamespace(function=fake_fetch),
    )

    ctx = make_ctx(test_settings)
    search_payload = json.loads(await web_search(ctx, WebSearchInput(query="demo")))
    alias_payload = json.loads(await search(ctx, SearchInput(query="demo")))
    fetch_payload = json.loads(await web_fetch(ctx, WebFetchInput(url="https://example.com")))
    assert search_payload[0]["title"] == "demo"
    assert alias_payload[0]["link"] == "https://example.com"
    assert fetch_payload["title"] == "Example"
