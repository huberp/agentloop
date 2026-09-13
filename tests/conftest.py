from __future__ import annotations

from pathlib import Path

import pytest

from agentloop.config import Settings


@pytest.fixture
def test_settings(tmp_path: Path) -> Settings:
    return Settings(
        mistral_api_key="test-key",
        workspace_root=tmp_path,
        agent_profiles_dir=str(tmp_path / "profiles"),
        skills_dir=str(tmp_path / "skills"),
        prompt_templates_dir=str(tmp_path / "prompts"),
    )
