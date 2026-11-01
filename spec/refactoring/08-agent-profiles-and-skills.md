# Phase 8 — Agent Profiles, Skills & Prompts

## Objective

Port agent profiles to Pydantic `BaseModel`, replace the custom `SkillRegistry` with **`pydantic-ai-skills`** (PyPI), and simplify the prompt registry to plain Python. No LangChain dependency remains.

---

## Background

### Current Architecture

```
src/agents/
  types.ts            AgentProfile, AgentRuntimeConfig
  loader.ts / registry.ts / activator.ts
  builtin/            *.agent.json profile files

src/skills/
  registry.ts         SkillRegistry singleton
  builtin/            *.skill.md markdown files

src/prompts/
  system.ts / registry.ts / context.ts
```

### What Changes (vs. previous spec)

| Concern | Old plan | Revised (PydanticAI-first) |
|---|---|---|
| Agent profiles | Custom `AgentProfileRegistry` | `pydantic-settings` sub-model; `Agent(**profile.model_dump())` |
| Skills | Custom `SkillRegistry` + markdown injection | **`pydantic-ai-skills`** package (progressive disclosure, local/remote registries) |
| Prompt assembly | Custom `getSystemPrompt()` | Thin wrapper; skills loaded by `pydantic-ai-skills`, injected into `Agent(instructions=...)` |

---

## Deliverables

### 8.1 — Agent Profile Types (`src/agentloop/agents/types.py`)

```python
from pydantic import BaseModel

class AgentProfile(BaseModel):
    name: str
    description: str = ""
    model: str | None = None
    temperature: float | None = None
    max_iterations: int | None = None
    tools: list[str] | None = None          # allowlist override
    blocked_tools: list[str] | None = None
    skills: list[str] | None = None
    system_prompt_override: str | None = None
```

### 8.2 — Agent Profile Registry (`src/agentloop/agents/registry.py`)

```python
class AgentProfileRegistry:
    async def load_from_directory(self, dir_path: Path) -> None:
        for f in dir_path.glob("*.agent.json"):
            profile = AgentProfile.model_validate_json(f.read_text())
            self._profiles[profile.name] = profile

    def get(self, name: str) -> AgentProfile | None: ...
```

`AgentProfile.model_validate_json()` replaces the custom TypeScript parser. Existing `*.agent.json` files need no changes.

### 8.3 — Profile → Agent Constructor

Instead of a bespoke `activateProfile()` that builds a runtime config object, merge profile fields directly into `Agent()` kwargs:

```python
def agent_from_profile(profile: AgentProfile, base: AgentProfile) -> Agent:
    merged = base.model_copy(update=profile.model_dump(exclude_none=True))
    return Agent(
        model=merged.model or settings.llm_model,
        instructions=merged.system_prompt_override or build_system_prompt(merged.skills),
        tools=filtered_tools(merged.tools, merged.blocked_tools),
        model_settings=ModelSettings(temperature=merged.temperature or settings.llm_temperature),
    )
```

No separate `AgentRuntimeConfig` class is needed — `Agent` kwargs serve that purpose directly.

### 8.4 — Skills via `pydantic-ai-skills`

Replace the custom `SkillRegistry` with the **`pydantic-ai-skills`** package:

```
pip install pydantic-ai-skills
```

**Key capabilities:**
- Progressive disclosure: the agent sees only a skill's name and description initially; full instructions/resources are loaded on demand.
- Local folder source: point at `src/agentloop/skills/builtin/` (existing `*.skill.md` files are compatible).
- Remote registries: Git and S3 sources for shared/enterprise skill libraries.
- Sandboxed script execution for skills that include executable scripts.

**Integration:**

```python
from pydantic_ai_skills import SkillsCapability

# One capability object, shared across agents
skills_cap = SkillsCapability('./src/agentloop/skills/builtin')

agent = Agent(
    model=...,
    instructions=base_system_prompt,
    capabilities=[skills_cap],  # skills injected automatically
)
```

The `SkillRegistry` custom class is deleted. Existing `*.skill.md` files are reused without modification.

### 8.5 — Skill File Format

`pydantic-ai-skills` expects a `SKILL.md` at the root of each skill folder with at minimum:
- `# Skill Name` heading
- `## Description` section (used for progressive-disclosure summary)
- `## Instructions` section (loaded on demand)

Existing `*.skill.md` files need a minor renaming/restructuring:
- Move each `skill-name.skill.md` → `skills/skill-name/SKILL.md` (one folder per skill).
- Adjust headings to match the expected format.

### 8.6 — System Prompt Assembly (`src/agentloop/prompts/system.py`)

```python
def build_system_prompt(skill_names: list[str] | None = None) -> str:
    base = _load_prompt_file() or _default_system_prompt()
    # Skills are now injected by SkillsCapability, not manually appended.
    return base
```

The manual `inject_into_prompt()` method is removed — `SkillsCapability` handles injection.

### 8.7 — Prompt Registry (`src/agentloop/prompts/registry.py`)

Thin custom layer (no PydanticAI equivalent):
- Loads templates from `settings.prompt_templates_dir`.
- Template rendering: plain Python `.format(**kwargs)`.
- No LangChain dependency.

---

## Acceptance Criteria

- [ ] All builtin `*.agent.json` profiles load without error.
- [ ] `agent_from_profile("coder")` returns an `Agent` with the correct tool allowlist.
- [ ] `SkillsCapability('./skills')` loads skill folders and the agent can reference skills by name.
- [ ] Skills are not fully loaded into the system prompt until the agent requests them (progressive disclosure).
- [ ] `build_system_prompt()` returns a valid base prompt string.

---

## Files Changed / Created

| Action | Path |
|---|---|
| Create | `src/agentloop/agents/__init__.py` |
| Create | `src/agentloop/agents/types.py` |
| Create | `src/agentloop/agents/registry.py` |
| Restructure | `src/skills/builtin/*.skill.md` → `src/agentloop/skills/builtin/<name>/SKILL.md` |
| Copy | `src/agents/builtin/*.agent.json` → `src/agentloop/agents/builtin/` |
| Create | `src/agentloop/prompts/__init__.py` |
| Create | `src/agentloop/prompts/system.py` |
| Create | `src/agentloop/prompts/registry.py` |
| Create | `tests/test_agents.py` |
| Create | `tests/test_skills.py` |
| Delete (later) | `src/agents/*.ts`, `src/skills/registry.ts`, `src/prompts/*.ts` |

---

## Dependencies Added

| Package | Purpose |
|---|---|
| `pydantic-ai-skills` | Progressive-disclosure skill system with local/remote registries |

## Dependencies Removed

- Custom `SkillRegistry` TypeScript implementation
- Custom `AgentRuntimeConfig` / `activator.ts` — replaced by direct `Agent()` construction

