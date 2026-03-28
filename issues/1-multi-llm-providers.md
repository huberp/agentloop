## Summary

Extend `agentloop` to support multiple LLM backends — OpenAI, Anthropic, Google Gemini, and Ollama — alongside the existing Mistral integration. Agent profiles will be able to declare a `provider` field so that different agents can use different LLMs within the same session, enabling true mixed-provider orchestration.

---

## Problem Statement

`src/llm.ts` is a single-provider factory:

```typescript
// src/llm.ts (current)
switch (config.llmProvider.toLowerCase()) {
  case "mistral":
    model = new ChatMistralAI({ ... });
    break;
  default:
    throw new Error(`Unknown LLM provider: "${config.llmProvider}". Supported providers: mistral`);
}
```

`LLM_PROVIDER` in `src/config.ts` accepts only `"mistral"` at runtime. Every code path in `src/index.ts` that re-instantiates the LLM for a profile override (`createLLM({ ...appConfig, llmModel: runtimeConfig.model })`) inherits `llmProvider` from `appConfig`, making it impossible to route a profile to a different backend even if the profile declares a different model name.

**Latent bug:** The builtin `coder.agent.json` declares `"model": "gpt-4o"` with no `provider` field. Today, if the coder profile is activated and `LLM_PROVIDER=mistral`, `createLLM` is called with `llmProvider: "mistral"` and `llmModel: "gpt-4o"`, which sends an invalid model name to the Mistral API and fails at runtime. There is no validation or warning.

---

## Motivation

### BMW Agents Paper

The BMW Agents architecture (Schimanski et al., 2024) identifies **pluggable LLM backends** as a core requirement for enterprise multi-agent systems. Their framework routes different agent roles to different LLMs based on task complexity:

- Planning agents → high-capability frontier models (GPT-4, Claude 3 Opus)
- Execution agents → cost-effective models (GPT-3.5, Mistral 7B, local Ollama)
- Specialised agents → domain-fine-tuned models

`agentloop` already has the agent profile system (`src/agents/builtin/`) to express these role distinctions, but the LLM factory cannot fulfil them. The `coder.agent.json` with `"model": "gpt-4o"` is direct evidence that the intent is already there.

### Industry Validation

- **LangChain** provides `@langchain/openai`, `@langchain/anthropic`, `@langchain/google-genai`, and `@langchain/ollama` as first-class packages — all expose the same `BaseChatModel` interface already used by `createLLM`.
- **AutoGen**, **CrewAI**, and **LangGraph** all treat multi-provider LLM routing as table-stakes for enterprise adoption.
- Enterprise deployments frequently require on-premises Ollama alongside cloud providers for data governance reasons.

### Specific User Impact

1. The builtin `coder` profile is silently broken unless `LLM_PROVIDER=mistral` and a Mistral-native model name is set manually.
2. Users cannot run a planner on a cheap Mistral model while routing code execution to GPT-4o.
3. There is no Ollama path for offline/air-gapped deployments.

---

## Proposed Design

### Core Principle

Extend the existing `createLLM` factory and `LLMConfig` interface; add a `provider` field to `AgentProfile` and `AgentRuntimeConfig`; fix the two call-sites in `src/index.ts` that re-instantiate the LLM for profile overrides; add new API-key config entries.

No new abstraction layer is needed — `BaseChatModel` already provides the common interface. The change is additive and backward-compatible: omitting `provider` from a profile continues to use `LLM_PROVIDER` from the environment.

### TypeScript API

**`src/llm.ts` — extended `LLMConfig` and factory:**

```typescript
export interface LLMConfig {
  llmProvider: string;
  llmModel: string;
  llmTemperature: number;
  // Provider-specific API keys
  mistralApiKey: string;
  openaiApiKey: string;
  anthropicApiKey: string;
  googleApiKey: string;
  // Ollama endpoint (no API key needed)
  ollamaBaseUrl: string;
}

export function createLLM(config: LLMConfig): BaseChatModel {
  switch (config.llmProvider.toLowerCase()) {
    case "mistral":
      return new ChatMistralAI({ apiKey: config.mistralApiKey, ... });
    case "openai":
      return new ChatOpenAI({ apiKey: config.openaiApiKey, ... });
    case "anthropic":
      return new ChatAnthropic({ apiKey: config.anthropicApiKey, ... });
    case "google":
    case "google-genai":
      return new ChatGoogleGenerativeAI({ apiKey: config.googleApiKey, ... });
    case "ollama":
      return new ChatOllama({ baseUrl: config.ollamaBaseUrl, model: config.llmModel, ... });
    default:
      throw new Error(
        `Unknown LLM provider: "${config.llmProvider}". ` +
        `Supported providers: mistral, openai, anthropic, google, ollama`
      );
  }
}
```

**`src/agents/types.ts` — add `provider` to profile and runtime config:**

```typescript
export interface AgentProfile {
  // ... existing fields ...
  provider?: string;  // overrides LLM_PROVIDER for this profile
  model?: string;
  temperature?: number;
}

export interface AgentRuntimeConfig {
  provider?: string;  // resolved from profile.provider
  model?: string;
  temperature?: number;
  // ... existing fields unchanged ...
}
```

**`src/agents/activator.ts` — thread `provider` through:**

```typescript
return {
  provider: effective.provider,   // NEW
  model: effective.model,
  temperature: effective.temperature,
  // ...
};
```

**`src/index.ts` — fix profile LLM re-instantiation (two call-sites, lines ~173 and ~388):**

```typescript
// Before (broken for cross-provider profiles):
const needsNewLlm = runtimeConfig.model !== undefined || runtimeConfig.temperature !== undefined;
const baseLlm = needsNewLlm
  ? createLLM({ ...appConfig, llmModel: runtimeConfig.model ?? appConfig.llmModel, ... })
  : llm;

// After:
const needsNewLlm =
  runtimeConfig.provider !== undefined ||
  runtimeConfig.model !== undefined ||
  runtimeConfig.temperature !== undefined;
const baseLlm = needsNewLlm
  ? createLLM({
      ...appConfig,
      ...(runtimeConfig.provider !== undefined && { llmProvider: runtimeConfig.provider }),
      ...(runtimeConfig.model !== undefined && { llmModel: runtimeConfig.model }),
      ...(runtimeConfig.temperature !== undefined && { llmTemperature: runtimeConfig.temperature }),
    })
  : llm;
```

**`src/agents/builtin/coder.agent.json` — add `provider` field:**

```json
{
  "name": "coder",
  "provider": "openai",
  "model": "gpt-4o",
  "temperature": 0.2,
  ...
}
```

---

## Implementation Steps

### Step 1 — Install new LangChain provider packages

```bash
npm install @langchain/openai @langchain/anthropic @langchain/google-genai @langchain/ollama
```

Check each for known CVEs before installing (GitHub Advisory DB). Pin to the same major version line as `@langchain/core` (`^1.x`) to avoid peer-dependency conflicts.

### Step 2 — Extend `LLMConfig` and the `createLLM` factory (`src/llm.ts`)

1. Add `openaiApiKey`, `anthropicApiKey`, `googleApiKey`, `ollamaBaseUrl` fields to `LLMConfig`.
2. Add `import` statements for `ChatOpenAI`, `ChatAnthropic`, `ChatGoogleGenerativeAI`, `ChatOllama`.
3. Add a `case` block for each provider in the `switch` statement.
4. Update the error message in the `default` case to list all supported providers.
5. The `bindTools` guard at the bottom requires no changes — it already validates universally.

**Ollama note:** `ChatOllama` uses `baseUrl` (default: `http://localhost:11434`) and `model` is mandatory. If `llmModel` is empty when `llmProvider === "ollama"`, throw a descriptive error: `"Ollama requires LLM_MODEL to be set"`.

**Google note:** Google GenAI uses `model` as a required constructor argument (e.g. `gemini-1.5-pro`). Apply the same empty-model guard as Ollama.

### Step 3 — Add new config keys to `src/config.ts`

Add to `appConfig`:

```typescript
openaiApiKey:    process.env.OPENAI_API_KEY    ?? "",
anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
googleApiKey:    process.env.GOOGLE_API_KEY    ?? "",
ollamaBaseUrl:   process.env.OLLAMA_BASE_URL   ?? "http://localhost:11434",
```

No changes to the existing `mistralApiKey` or `llmProvider` entries.

### Step 4 — Add `provider` to `AgentProfile` and `AgentRuntimeConfig` (`src/agents/types.ts`)

1. Add `provider?: string` to `AgentProfile` (alongside existing `model?: string`).
2. Add `provider?: string` to `AgentRuntimeConfig`.

### Step 5 — Thread `provider` through `activateProfile` (`src/agents/activator.ts`)

The `activateProfile` function builds `AgentRuntimeConfig` from a merged profile. Add `provider: effective.provider` to the returned object. No merge logic needed — `provider` is a scalar, so the child profile wins (same pattern as `model` and `temperature`).

### Step 6 — Fix the two LLM re-instantiation call-sites in `src/index.ts`

**Call-site 1:** `executeWithTools` function (~line 170). The `needsNewLlm` guard must now also trigger on `runtimeConfig.provider !== undefined`. Pass `llmProvider: runtimeConfig.provider` when set.

**Call-site 2:** The streaming path (~line 384, the `stream` function). Identical fix — copy the same guard expansion.

Both call-sites already spread `...appConfig`, so new fields (`openaiApiKey`, etc.) are automatically available once Step 3 is complete.

### Step 7 — Update builtin agent profiles (`src/agents/builtin/`)

Add `"provider": "openai"` to `coder.agent.json` (which already declares `"model": "gpt-4o"`). All other builtin profiles currently have no `model` field and should remain provider-agnostic (they inherit `LLM_PROVIDER` from the environment).

```json
// coder.agent.json
{
  "name": "coder",
  "description": "Expert software engineer focused on writing, editing, and running code",
  "version": "1.0.0",
  "provider": "openai",
  "model": "gpt-4o",
  "temperature": 0.2,
  ...
}
```

### Step 8 — Update `.env.example`

Under the existing `# LLM provider settings` block, add:

```dotenv
# LLM provider settings
LLM_PROVIDER=mistral
LLM_MODEL=
LLM_TEMPERATURE=0.7

# Provider API keys — set only the key(s) for your chosen provider(s)
MISTRAL_API_KEY=your_mistral_api_key_here
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
GOOGLE_API_KEY=

# Ollama (local, no API key required)
# Base URL of the Ollama server (default: http://localhost:11434)
OLLAMA_BASE_URL=http://localhost:11434
```

Move `MISTRAL_API_KEY` into this group (it currently lives at the top of the file as the only documented key). Keep it in `appConfig` under `mistralApiKey` — no rename needed for backward compatibility.

### Step 9 — Update `src/__tests__/llm.test.ts`

1. Add `jest.mock` stubs for `@langchain/openai`, `@langchain/anthropic`, `@langchain/google-genai`, and `@langchain/ollama` (same pattern as the existing `@langchain/mistralai` mock at the top of the file).
2. Add `openaiApiKey`, `anthropicApiKey`, `googleApiKey`, `ollamaBaseUrl` to `baseConfig` with empty/default test values.
3. Add test groups for each new provider:
   - `"returns a ChatOpenAI instance for provider 'openai'"` — verifies constructor called with `apiKey` and `model`.
   - `"returns a ChatAnthropic instance for provider 'anthropic'"`.
   - `"returns a ChatGoogleGenerativeAI instance for provider 'google'"`.
   - `"returns a ChatOllama instance for provider 'ollama'"`.
   - `"throws when provider is ollama and llmModel is empty"`.
   - `"throws when provider is google and llmModel is empty"`.
   - Update the existing `"throws a descriptive error for an unknown provider"` assertion to cover the new providers list in the error message.

### Step 10 — Update `src/__tests__/builtin-agent-profiles.test.ts`

Update the `coder` profile assertion to also check `provider`:

```typescript
it("coder profile has provider === 'openai' and model === 'gpt-4o'", () => {
  const profile = registry.get("coder");
  expect(profile!.provider).toBe("openai");
  expect(profile!.model).toBe("gpt-4o");
});
```

### Step 11 — Update `src/__tests__/agent-activation.test.ts`

Add a test that `activateProfile` threads `provider` through to `AgentRuntimeConfig`:

```typescript
it("preserves provider from profile in AgentRuntimeConfig", () => {
  const profile: AgentProfile = {
    name: "test", description: "", version: "1.0.0",
    provider: "openai", model: "gpt-4o",
  };
  const config = activateProfile(profile);
  expect(config.provider).toBe("openai");
});
```

### Step 12 — Update `README.md`

In the configuration reference section, add a table row or code block for each new env var (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, `OLLAMA_BASE_URL`) and update the `LLM_PROVIDER` description to list all supported values: `mistral | openai | anthropic | google | ollama`.

---

## Files to Modify

| File | Change |
|---|---|
| `src/llm.ts` | Extend `LLMConfig`; add 4 new provider cases to `createLLM` switch |
| `src/config.ts` | Add `openaiApiKey`, `anthropicApiKey`, `googleApiKey`, `ollamaBaseUrl` to `appConfig` |
| `src/agents/types.ts` | Add `provider?: string` to `AgentProfile` and `AgentRuntimeConfig` |
| `src/agents/activator.ts` | Thread `provider` into the returned `AgentRuntimeConfig` |
| `src/index.ts` | Fix `needsNewLlm` guard and `createLLM` calls at both call-sites (~line 170, ~line 388) |
| `src/agents/builtin/coder.agent.json` | Add `"provider": "openai"` |
| `.env.example` | Add new API key vars; reorganise LLM provider section |
| `README.md` | Update LLM provider documentation |
| `src/__tests__/llm.test.ts` | Add mocks and test cases for all new providers |
| `src/__tests__/builtin-agent-profiles.test.ts` | Update coder profile assertion |
| `src/__tests__/agent-activation.test.ts` | Add provider threading test |
| `package.json` | Add 4 new `@langchain/*` dependencies |

---

## Configuration Changes

### New environment variables

| Variable | Default | Description |
|---|---|---|
| `OPENAI_API_KEY` | `""` | OpenAI API key. Required when `LLM_PROVIDER=openai` or an agent profile sets `provider: openai`. |
| `ANTHROPIC_API_KEY` | `""` | Anthropic API key. Required when `LLM_PROVIDER=anthropic` or a profile sets `provider: anthropic`. |
| `GOOGLE_API_KEY` | `""` | Google AI Studio / Vertex API key. Required for `google`/`google-genai` provider. |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Base URL of the Ollama HTTP server. Used when `LLM_PROVIDER=ollama`. No API key required. |

### Updated existing variables

| Variable | Before | After |
|---|---|---|
| `LLM_PROVIDER` | `"mistral"` (only valid value) | `"mistral" \| "openai" \| "anthropic" \| "google" \| "ollama"` |

### New agent profile fields

| Field | Type | Description |
|---|---|---|
| `provider` | `string?` | Overrides `LLM_PROVIDER` for this profile only. Must match one of the supported provider names. |

---

## Testing Approach

### Unit tests (`src/__tests__/llm.test.ts`)

- Mock all five provider packages with `jest.mock(...)` at the top of the file (following the existing `@langchain/mistralai` mock pattern).
- Test that each provider case constructs the correct class with the correct arguments.
- Test that `ollama` and `google` throw when `llmModel` is empty.
- Test case-insensitivity for all provider names.
- Verify the updated error message for unknown providers lists all five names.

### Integration-style unit tests (`src/__tests__/agent-activation.test.ts`)

- Verify `provider` is passed through `activateProfile` to `AgentRuntimeConfig`.
- Verify profiles without `provider` produce `AgentRuntimeConfig.provider === undefined`.

### Profile regression tests (`src/__tests__/builtin-agent-profiles.test.ts`)

- Update the coder profile assertion to include `provider === "openai"`.
- Optionally add assertions that all other builtin profiles have `provider === undefined` (they inherit from env).

### Manual smoke tests (not automated)

- Set `LLM_PROVIDER=openai`, `OPENAI_API_KEY=<key>`, `LLM_MODEL=gpt-4o-mini` and verify the agent loop completes.
- Activate the `coder` profile with `OPENAI_API_KEY` set; verify the override fires without touching `LLM_PROVIDER`.
- Set `LLM_PROVIDER=ollama`, `LLM_MODEL=llama3`, start a local Ollama server; verify tool calls complete.

---

## Acceptance Criteria

- [ ] `createLLM` accepts `llmProvider` values `"openai"`, `"anthropic"`, `"google"`, and `"ollama"` without throwing.
- [ ] Setting `LLM_PROVIDER=openai` and providing `OPENAI_API_KEY` enables the agent loop to call GPT models end-to-end.
- [ ] Setting `LLM_PROVIDER=anthropic` and providing `ANTHROPIC_API_KEY` enables the agent loop to call Claude models end-to-end.
- [ ] Setting `LLM_PROVIDER=ollama` and `LLM_MODEL=<model>` routes calls to the local Ollama server.
- [ ] The builtin `coder` agent profile activates an OpenAI LLM when `OPENAI_API_KEY` is set, without requiring the user to set `LLM_PROVIDER=openai` globally.
- [ ] Agent profiles without a `provider` field continue to use `LLM_PROVIDER` from the environment (no regression).
- [ ] `createLLM` throws a clear error when `llmProvider` is `"ollama"` or `"google"` and `llmModel` is empty.
- [ ] The error message for an unknown provider lists all five supported provider names.
- [ ] All existing tests (`npx jest`) pass without modification other than the planned test file updates.
- [ ] `.env.example` documents all four new API key variables and all five valid `LLM_PROVIDER` values.
- [ ] No `process.env` reads for new API keys appear in business logic files — all go through `appConfig`.
