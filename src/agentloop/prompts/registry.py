from __future__ import annotations

from pathlib import Path


class PromptRegistry:
    def __init__(self) -> None:
        self._templates: dict[str, str] = {}

    def load_from_directory(self, path: Path) -> None:
        if not path.exists():
            return
        for file_path in path.glob("*.txt"):
            self._templates[file_path.stem] = file_path.read_text()

    def register(self, name: str, template: str) -> None:
        self._templates[name] = template

    def get(self, name: str) -> str | None:
        return self._templates.get(name)

    def render(self, name: str, **kwargs: str) -> str:
        template = self._templates.get(name)
        if template is None:
            raise KeyError(name)
        return template.format(**kwargs)
