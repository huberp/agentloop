from __future__ import annotations

import fnmatch
import json
import re
import subprocess
from pathlib import Path

from pydantic import BaseModel
from pydantic_ai import RunContext

from agentloop.agent import AgentDeps
from agentloop.tools._common import DEFAULT_EXCLUDE_DIRS, command_exists, json_dumps, resolve_workspace_path
from agentloop.tools.registry import tool_def


class CodeSearchInput(BaseModel):
    pattern: str
    mode: str = "literal"
    path: str = "."
    max_results: int = 50
    context_lines: int = 2
    file_glob: str | None = None


def _parse_rg_json(output: str, base: Path, max_results: int) -> list[dict[str, object]]:
    matches: list[dict[str, object]] = []
    for line in output.splitlines():
        payload = json.loads(line)
        if payload.get("type") != "match":
            continue
        data = payload["data"]
        file_path = Path(data["path"]["text"])
        text = data["lines"]["text"].rstrip("\n")
        start = int(data.get("submatches", [{}])[0].get("start", 0)) + 1
        matches.append(
            {
                "file": file_path.relative_to(base).as_posix(),
                "line": int(data.get("line_number", 0)),
                "column": start,
                "content": text,
                "context": [],
            }
        )
        if len(matches) >= max_results:
            break
    return matches


def _fallback_search(base: Path, args: CodeSearchInput) -> list[dict[str, object]]:
    mode = args.mode
    regex = re.compile(re.escape(args.pattern) if mode == "literal" else args.pattern)
    results: list[dict[str, object]] = []
    for path in base.rglob("*"):
        if path.is_dir() or any(part in DEFAULT_EXCLUDE_DIRS for part in path.parts):
            continue
        rel = path.relative_to(base).as_posix()
        if mode == "glob":
            if fnmatch.fnmatch(rel, args.pattern):
                results.append({"file": rel, "line": 0, "column": 0, "content": "", "context": []})
            continue
        if args.file_glob and not fnmatch.fnmatch(rel, args.file_glob):
            continue
        try:
            lines = path.read_text().splitlines()
        except UnicodeDecodeError:
            continue
        for index, line in enumerate(lines, start=1):
            match = regex.search(line)
            if match:
                start = max(index - 1 - args.context_lines, 0)
                end = min(index + args.context_lines, len(lines))
                results.append(
                    {
                        "file": rel,
                        "line": index,
                        "column": match.start() + 1,
                        "content": line,
                        "context": lines[start:index - 1] + lines[index:end],
                    }
                )
            if len(results) >= args.max_results:
                return results
    return results


@tool_def(name="code_search", description="Search code by literal, regex, or glob", permissions="safe")
async def code_search(ctx: RunContext[AgentDeps], args: CodeSearchInput) -> str:
    base = resolve_workspace_path(ctx.deps, args.path)
    if command_exists("rg"):
        if args.mode == "glob":
            proc = subprocess.run(["rg", "--files", str(base), "--glob", args.pattern], text=True, capture_output=True, check=False)
            matches = [
                {"file": Path(line).relative_to(base).as_posix(), "line": 0, "column": 0, "content": "", "context": []}
                for line in proc.stdout.splitlines()[: args.max_results]
            ]
        else:
            command = ["rg", "--json", "-C", str(args.context_lines)]
            if args.mode == "literal":
                command.append("--fixed-strings")
            if args.file_glob:
                command.extend(["--glob", args.file_glob])
            command.extend([args.pattern, str(base)])
            proc = subprocess.run(command, text=True, capture_output=True, check=False)
            if proc.returncode not in (0, 1):
                return json_dumps({"matches": [], "truncated": False, "error": proc.stderr.strip()})
            matches = _parse_rg_json(proc.stdout, base, args.max_results)
        return json_dumps({"matches": matches[: args.max_results], "truncated": len(matches) >= args.max_results})
    matches = _fallback_search(base, args)
    return json_dumps({"matches": matches[: args.max_results], "truncated": len(matches) >= args.max_results})
