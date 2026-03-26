# Testing Strategy for AgentLoop

## Overview

AgentLoop tests are split into three layers:

| Layer | Location | Runner | Purpose |
|-------|----------|--------|---------|
| Unit / integration | `src/__tests__/*.test.ts` | `jest` | Fast, no real API calls |
| E2E scenarios | `tests/e2e/scenarios/` | `jest --config jest.e2e.config.js` | Full agent-loop smoke tests |
| Benchmarks | `benchmarks/` | `tsx benchmarks/run-all.ts` | Performance baselines |

The key principle is **no real LLM API calls in CI**.  All unit and integration
tests replace the LLM with `MockChatModel`, a deterministic replay engine that
returns pre-recorded responses.

---

## MockChatModel

`MockChatModel` lives in `src/testing/mock-chat-model.ts`.  It extends
LangChain's `BaseChatModel`, meaning it satisfies every type that accepts a
`BaseChatModel` — including the `createLLM` return type, `executePlan`, and
subagent runners.

### How it works

1. You provide an ordered list of `MockResponse` objects (or load them from a
   fixture file).
2. Each call to `invoke()` or `_generate()` returns the next response in the
   sequence.
3. Once the sequence is exhausted the last response repeats on every subsequent
   call.

### In-memory usage

```ts
import { MockChatModel } from "../testing/mock-chat-model";

const model = new MockChatModel();
model.setResponses([
  // Turn 1: model requests a tool call
  {
    role: "ai",
    content: "",
    tool_calls: [{ id: "c1", name: "search", args: { query: "TypeScript" } }],
  },
  // Turn 2: model returns the final answer
  {
    role: "ai",
    content: "TypeScript 5.4 brings exciting new features.",
    tool_calls: [],
  },
]);

const response = await model.invoke([new HumanMessage("Latest TS news?")]);
// response is an AIMessage with the first MockResponse
```

### Loading from a fixture file

```ts
import { MockChatModel } from "../testing/mock-chat-model";

const model = MockChatModel.fromFixture(
  "tests/fixtures/llm-responses/single-tool-call.json",
);

const r1 = await model.invoke([new HumanMessage("Search for TypeScript")]);
```

### Assertions

```ts
expect(model.callCount).toBe(2);  // how many times _generate was called
model.reset();                     // replay from the beginning
```

### Tool binding

`bindTools()` on `MockChatModel` returns `this`, so you can write:

```ts
const llmWithTools = model.bindTools(registry.toLangChainTools());
const result = await llmWithTools.invoke(messages);  // still calls MockChatModel._generate
```

---

## Fixture File Format

Fixture files live in `tests/fixtures/llm-responses/` and are plain JSON:

```json
{
  "name": "single-tool-call",
  "description": "Human-readable description of what this fixture captures",
  "turns": [
    {
      "input": [
        { "role": "human", "content": "Search for the latest news on TypeScript" }
      ],
      "output": {
        "role": "ai",
        "content": "",
        "tool_calls": [
          {
            "id": "call_abc123",
            "name": "search",
            "args": { "query": "TypeScript latest news" }
          }
        ]
      }
    },
    {
      "input": [
        { "role": "human", "content": "Search for the latest news on TypeScript" },
        { "role": "tool", "content": "TypeScript 5.4 released", "tool_call_id": "call_abc123" }
      ],
      "output": {
        "role": "ai",
        "content": "TypeScript 5.4 was released with new features.",
        "tool_calls": []
      }
    }
  ]
}
```

**Fields:**

| Field | Type | Description |
|-------|------|-------------|
| `name` | `string` | Unique identifier for this fixture |
| `description` | `string` | Human-readable description |
| `turns[].input` | `array` | Messages sent to the LLM for this turn |
| `turns[].output.role` | `"ai"` | Always `"ai"` |
| `turns[].output.content` | `string` | Text content; empty string when only tool calls are returned |
| `turns[].output.tool_calls` | `array` | LangChain `ToolCall` objects (may be `[]`) |

`MockChatModel.fromFixture` only uses `turns[].output`; the `input` fields are
there for documentation and for the recorder to produce self-contained files.

---

## Recording Mode

`RecordingChatModel` (`src/testing/recorder.ts`) wraps a real `BaseChatModel`
and transparently records every request/response pair.

### Enabling recording

Set the environment variable before running the agent:

```bash
RECORD_LLM_RESPONSES=true \
LLM_FIXTURE_DIR=tests/fixtures/llm-responses \
npx tsx src/index.ts
```

Or configure in `.env`:

```
RECORD_LLM_RESPONSES=true
LLM_FIXTURE_DIR=tests/fixtures/llm-responses
```

### Programmatic usage

```ts
import { RecordingChatModel } from "../testing/recorder";
import { createLLM } from "./llm";
import { appConfig } from "./config";

const real = createLLM(appConfig);
const recorder = new RecordingChatModel(real, {
  fixturePath: "tests/fixtures/llm-responses/my-session.json",
  name: "my-session",
  description: "Captured during manual QA on 2026-03-26",
  active: true,   // or omit to read from RECORD_LLM_RESPONSES env var
});

// Use recorder exactly as you would the real model:
await recorder.invoke([new HumanMessage("Hello")]);

// Write all captured turns to disk:
recorder.flush();
```

`flush()` writes only if recording is active and at least one turn was captured.
The output file is valid JSON that `MockChatModel.fromFixture` can load directly.

---

## CI vs Local Testing

| Scenario | Configuration |
|----------|---------------|
| CI (GitHub Actions, etc.) | `RECORD_LLM_RESPONSES=false` (default). All unit tests use `MockChatModel`. No API key required. |
| Local development | Same as CI by default. Set `MISTRAL_API_KEY` only when running E2E tests or recording sessions. |
| Recording a new fixture | `RECORD_LLM_RESPONSES=true` + a valid `MISTRAL_API_KEY`. Run the target scenario, call `recorder.flush()`, commit the new fixture. |
| Replaying a recorded fixture | Use `MockChatModel.fromFixture(path)` — no API key required. |

### Why no API calls in CI?

- **Stability**: LLM outputs are non-deterministic; real API calls make tests
  flaky.
- **Cost**: Avoiding unnecessary tokens reduces operating costs.
- **Speed**: Local inference or recorded fixtures are orders of magnitude faster.

---

## Migrating Existing Tests

Existing tests in `src/__tests__/` currently mock at the `@langchain/mistralai`
module level using `jest.mock`.  That approach works but couples tests to a
specific provider.

**Recommended migration path:**

1. Remove the `jest.mock("@langchain/mistralai", …)` block.
2. Replace `makeMockLlm(invokeFn)` with a `MockChatModel` instance:

```ts
// Before
const llm = makeMockLlm(jest.fn().mockResolvedValue({ content: "ok", tool_calls: [] }));

// After
import { MockChatModel } from "../testing/mock-chat-model";
const llm = new MockChatModel();
llm.setResponses([{ role: "ai", content: "ok", tool_calls: [] }]);
```

3. Use `llm.callCount` instead of `expect(invokeFn).toHaveBeenCalledTimes(n)`.

This migration is **not required immediately** — existing tests continue to
pass.  Prefer `MockChatModel` for all *new* tests.

---

## Meta-tests

Tests for the testing infrastructure itself live in
`src/__tests__/mock-chat-model.test.ts`.  They verify:

- Sequential response replay
- Tool-call replay (single and multiple tool calls)
- Multi-turn conversation replay
- Repeat-last-response behaviour when the sequence is exhausted
- `fromFixture` loading all three bundled fixture files
- `bindTools` passthrough semantics
- `callCount` and `reset()`
