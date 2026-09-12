# Phase 8 — Agent Profiles, Skills & Prompts

## Objective

Port agent profiles (JSON → Pydantic `BaseModel`), skills (Markdown injection), and the prompt registry to Python. No PydanticAI built-in directly replaces these features; they remain as thin custom layers, simplified by Pydantic.

---

## Background

### Current Architecture

```
src/agents/
  types.ts            AgentProfile, AgentRuntimeConfig interfaces
  loader.ts           loadAgentProfiles() from JSON files
  registry.ts         AgentProfileRegistry singleton
  activator.ts        activateProfile() → AgentRuntimeConfig
  builtin/            *.agent.json profile files

src/skills/
  registry.ts         SkillRegistry singleton
  builtin/            *.skill.md markdown files

src/prompts/
  system.ts           getSystemPrompt() — assembles system prompt
  registry.ts         PromptRegistry — versioned templates
  context.ts          getCachedPromptContext() — runtime context injection
```

### What Changes

| TypeScript | Python |
|---|---|
| `AgentProfile` interface | `AgentProfile(BaseModel)` |
| `AgentRuntimeConfig` interface | `AgentRuntimeConfig(BaseModel)` |
| `AgentProfileRegistry` (custom Map) | `AgentProfileRegistry` (thin class, same API) |
| `SkillRegistry` (custom Map) | `SkillRegistry` (thin class, same API) |
| `PromptRegistry` (custom Map + history) | `PromptRegistry` (simplified, no LangChain) |
| JSON profile files | Same JSON files (parsed by Pydantic) |
| Markdown skill files | Same Markdown files (read as plain text) |

---

## Deliverables

### 8.1 — Agent Profile Types (`src/agentloop/agents/types.py`)

```python
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

class AgentRuntimeConfig(BaseModel):
    system_prompt: str
    model: str
    temperature: float
    max_iterations: int
    tool_allowlist: list[str]
    tool_blocklist: list[str]
    skills: list[str]
```

### 8.2 — Agent Profile Registry (`src/agentloop/agents/registry.py`)

```python
class AgentProfileRegistry:
    async def load_from_directory(self, dir_path: Path, source: str) -> None:
        """Load all *.agent.json files from dir_path."""
        for f in dir_path.glob("*.agent.json"):
            profile = AgentProfile.model_validate_json(f.read_text())
            self._profiles[profile.name] = (profile, source)

    def get(self, name: str) -> AgentProfile | None: ...
    def list(self) -> list[dict]: ...
```

- `AgentProfile.model_validate_json()` replaces the custom TypeScript JSON parser.
- Existing `*.agent.json` files require no changes.

### 8.3 — Profile Activator (`src/agentloop/agents/activator.py`)

```python
def activate_profile(
    base: AgentRuntimeConfig,
    profile: AgentProfile,
    skill_registry: SkillRegistry,
) -> AgentRuntimeConfig:
    ...
```

Merges profile overrides onto the base config. Array fields (tools, skills) become deduplicated unions — identical logic to `mergeProfiles()` in `activator.ts`.

### 8.4 — Skill Registry (`src/agentloop/skills/registry.py`)

```python
class SkillRegistry:
    async def load_from_directory(self, dir_path: Path, source: str) -> None:
        for f in dir_path.glob("*.skill.md"):
            content = f.read_text()
            name = f.stem.replace(".skill", "")
            self._skills[name] = (content, source)

    def get(self, name: str) -> str | None: ...
    def list(self) -> list[dict]: ...
    def inject_into_prompt(self, skill_names: list[str], base_prompt: str) -> str: ...
```

- `inject_into_prompt()` appends skill Markdown blocks to the system prompt — same behaviour as the TypeScript `skillRegistry.injectSkills()`.

### 8.5 — System Prompt Assembly (`src/agentloop/prompts/system.py`)

```python
async def get_system_prompt(
    config: AgentRuntimeConfig,
    skill_registry: SkillRegistry,
    runtime_context: str | None = None,
) -> str:
    base = _load_prompt_file(config) or _default_system_prompt()
    prompt = skill_registry.inject_into_prompt(config.skills, base)
    if runtime_context:
        prompt += f"\n\n## Runtime Context\n{runtime_context}"
    return prompt
```

### 8.6 — Prompt Registry (`src/agentloop/prompts/registry.py`)

Simplified port of `PromptRegistry`:
- Loads custom prompt templates from `settings.prompt_templates_dir`.
- Tracks prompt usage history in a JSON file (`settings.prompt_history_file`).
- No LangChain dependency; templates are plain Python strings with `.format(**kwargs)`.

---

## Acceptance Criteria

- [ ] All builtin `*.agent.json` profiles load without error.
- [ ] `activate_profile("coder")` returns a config with the correct tool allowlist.
- [ ] All builtin `*.skill.md` files load without error.
- [ ] `inject_into_prompt(["typescript-expert"], base)` returns the base prompt with the skill appended.
- [ ] `get_system_prompt()` with skills and runtime context returns a valid prompt string.

---

## Files Changed / Created

| Action | Path |
|---|---|
| Create | `src/agentloop/agents/__init__.py` |
| Create | `src/agentloop/agents/types.py` |
| Create | `src/agentloop/agents/registry.py` |
| Create | `src/agentloop/agents/activator.py` |
| Create | `src/agentloop/skills/__init__.py` |
| Create | `src/agentloop/skills/registry.py` |
| Copy | `src/skills/builtin/*.skill.md` → `src/agentloop/skills/builtin/` |
| Copy | `src/agents/builtin/*.agent.json` → `src/agentloop/agents/builtin/` |
| Create | `src/agentloop/prompts/__init__.py` |
| Create | `src/agentloop/prompts/system.py` |
| Create | `src/agentloop/prompts/registry.py` |
| Create | `tests/test_agents.py` |
| Create | `tests/test_skills.py` |
| Delete (later) | `src/agents/*.ts`, `src/skills/registry.ts`, `src/prompts/*.ts` |
