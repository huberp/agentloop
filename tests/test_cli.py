from __future__ import annotations

import json

from click.testing import CliRunner

from agentloop.cli.main import cli


class DummyExecutor:
    def __init__(self, *args, **kwargs) -> None:
        self.settings = kwargs.get("settings")

    async def invoke(self, prompt: str, profile: str | None = None) -> str:
        del profile
        return f"reply:{prompt}"

    async def stream(self, prompt: str, profile: str | None = None):
        del profile
        yield f"reply:{prompt}"


def test_agent_command_outputs_text(monkeypatch) -> None:
    monkeypatch.setattr("agentloop.cli.main.AgentExecutor", DummyExecutor)
    result = CliRunner().invoke(cli, ["agent", "-u", "hello"])
    assert result.exit_code == 0
    assert "reply:hello" in result.output


def test_agent_command_outputs_json(monkeypatch) -> None:
    monkeypatch.setattr("agentloop.cli.main.AgentExecutor", DummyExecutor)
    result = CliRunner().invoke(cli, ["agent", "-u", "hello", "--json"])
    assert json.loads(result.output)["output"] == "reply:hello"


def test_list_tools_command() -> None:
    result = CliRunner().invoke(cli, ["list", "tools", "--json"])
    assert result.exit_code == 0
    payload = json.loads(result.output)
    assert any(item["name"] == "file_read" for item in payload)
