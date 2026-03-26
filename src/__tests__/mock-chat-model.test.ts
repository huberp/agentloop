import * as path from "path";
import { HumanMessage, AIMessage } from "@langchain/core/messages";
import { MockChatModel } from "../testing/mock-chat-model";
import type { MockResponse } from "../testing/mock-chat-model";

// Fixtures directory relative to the workspace root
const FIXTURE_DIR = path.resolve(__dirname, "../../tests/fixtures/llm-responses");

// ── Helper ────────────────────────────────────────────────────────────────────

/** Call BaseChatModel.invoke(), which internally calls _generate(). */
async function callModel(
  model: MockChatModel,
  userText: string,
): Promise<AIMessage> {
  return model.invoke([new HumanMessage(userText)]) as Promise<AIMessage>;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("MockChatModel", () => {
  // ── Constructor & defaults ─────────────────────────────────────────────────

  it("has _llmType() === 'mock'", () => {
    const model = new MockChatModel();
    expect(model._llmType()).toBe("mock");
  });

  it("returns a default response before setResponses is called", async () => {
    const model = new MockChatModel();
    const result = await callModel(model, "ping");
    expect(result.content).toBe("Mock response");
  });

  // ── setResponses / callCount / reset ─────────────────────────────────────

  it("throws when setResponses is called with an empty array", () => {
    const model = new MockChatModel();
    expect(() => model.setResponses([])).toThrow(
      /responses array must not be empty/i,
    );
  });

  it("increments callCount on each invocation", async () => {
    const model = new MockChatModel();
    model.setResponses([{ role: "ai", content: "a", tool_calls: [] }]);

    expect(model.callCount).toBe(0);
    await callModel(model, "1");
    expect(model.callCount).toBe(1);
    await callModel(model, "2");
    expect(model.callCount).toBe(2);
  });

  it("reset() resets callCount to 0", async () => {
    const model = new MockChatModel();
    model.setResponses([{ role: "ai", content: "a", tool_calls: [] }]);
    await callModel(model, "x");
    expect(model.callCount).toBe(1);
    model.reset();
    expect(model.callCount).toBe(0);
  });

  // ── Simple text replay ────────────────────────────────────────────────────

  it("replays a simple text response with no tool calls", async () => {
    const model = new MockChatModel();
    const responses: MockResponse[] = [
      { role: "ai", content: "Hello there!", tool_calls: [] },
    ];
    model.setResponses(responses);

    const result = await callModel(model, "Hello");

    expect(result.content).toBe("Hello there!");
    expect(result.tool_calls).toHaveLength(0);
  });

  it("replays responses in sequence", async () => {
    const model = new MockChatModel();
    model.setResponses([
      { role: "ai", content: "first", tool_calls: [] },
      { role: "ai", content: "second", tool_calls: [] },
      { role: "ai", content: "third", tool_calls: [] },
    ]);

    const r1 = await callModel(model, "q1");
    const r2 = await callModel(model, "q2");
    const r3 = await callModel(model, "q3");

    expect(r1.content).toBe("first");
    expect(r2.content).toBe("second");
    expect(r3.content).toBe("third");
  });

  it("repeats the last response once all responses are consumed", async () => {
    const model = new MockChatModel();
    model.setResponses([
      { role: "ai", content: "only one", tool_calls: [] },
    ]);

    await callModel(model, "q1");
    const r2 = await callModel(model, "q2");
    const r3 = await callModel(model, "q3");

    expect(r2.content).toBe("only one");
    expect(r3.content).toBe("only one");
    expect(model.callCount).toBe(3);
  });

  // ── Tool-call replay ─────────────────────────────────────────────────────

  it("replays a response containing a tool call", async () => {
    const model = new MockChatModel();
    model.setResponses([
      {
        role: "ai",
        content: "",
        tool_calls: [
          { id: "call_1", name: "search", args: { query: "TypeScript" } },
        ],
      },
    ]);

    const result = await callModel(model, "Search TypeScript");
    const toolCalls = result.tool_calls ?? [];

    expect(result.content).toBe("");
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].name).toBe("search");
    expect(toolCalls[0].args).toEqual({ query: "TypeScript" });
    expect(toolCalls[0].id).toBe("call_1");
  });

  it("replays multiple tool calls in a single response", async () => {
    const model = new MockChatModel();
    model.setResponses([
      {
        role: "ai",
        content: "",
        tool_calls: [
          { id: "c1", name: "file-read", args: { path: "a.ts" } },
          { id: "c2", name: "file-read", args: { path: "b.ts" } },
        ],
      },
    ]);

    const result = await callModel(model, "read both files");
    const toolCalls = result.tool_calls ?? [];

    expect(toolCalls).toHaveLength(2);
    expect(toolCalls[0].name).toBe("file-read");
    expect(toolCalls[1].name).toBe("file-read");
  });

  // ── Multi-turn replay ─────────────────────────────────────────────────────

  it("replays a multi-turn conversation with a tool call then final answer", async () => {
    const model = new MockChatModel();
    model.setResponses([
      // Turn 1: request a tool call
      {
        role: "ai",
        content: "",
        tool_calls: [
          { id: "call_abc", name: "search", args: { query: "LangChain" } },
        ],
      },
      // Turn 2: final text answer after tool result
      {
        role: "ai",
        content: "LangChain is a framework for building LLM applications.",
        tool_calls: [],
      },
    ]);

    const turn1 = await callModel(model, "Tell me about LangChain");
    const turn1Calls = turn1.tool_calls ?? [];
    expect(turn1Calls).toHaveLength(1);
    expect(turn1Calls[0].name).toBe("search");

    const turn2 = await callModel(model, "tool result: LangChain is ...");
    expect(turn2.content).toBe(
      "LangChain is a framework for building LLM applications.",
    );
    expect(turn2.tool_calls).toHaveLength(0);

    expect(model.callCount).toBe(2);
  });

  // ── bindTools passthrough ─────────────────────────────────────────────────

  it("bindTools returns the same model instance", () => {
    const model = new MockChatModel();
    const bound = model.bindTools([]);
    expect(bound).toBe(model);
  });

  it("bindTools does not reset responses or callCount", async () => {
    const model = new MockChatModel();
    model.setResponses([{ role: "ai", content: "hi", tool_calls: [] }]);
    await callModel(model, "x");
    model.bindTools([]);
    expect(model.callCount).toBe(1);
  });

  // ── fromFixture ───────────────────────────────────────────────────────────

  it("fromFixture loads no-tool-call fixture and replays it", async () => {
    const model = MockChatModel.fromFixture(
      path.join(FIXTURE_DIR, "no-tool-call.json"),
    );

    const result = await callModel(model, "Hello");

    expect(result.content).toBe("I'm doing well, thank you for asking!");
    expect(result.tool_calls).toHaveLength(0);
  });

  it("fromFixture loads single-tool-call fixture and replays both turns", async () => {
    const model = MockChatModel.fromFixture(
      path.join(FIXTURE_DIR, "single-tool-call.json"),
    );

    // Turn 1: should request a tool call
    const turn1 = await callModel(model, "user message turn 1");
    const turn1Calls = turn1.tool_calls ?? [];
    expect(turn1Calls).toHaveLength(1);
    expect(turn1Calls[0].name).toBe("search");

    // Turn 2: should return a final text answer
    const turn2 = await callModel(model, "user message turn 2");
    expect(typeof turn2.content).toBe("string");
    expect((turn2.content as string).length).toBeGreaterThan(0);
    expect(turn2.tool_calls).toHaveLength(0);
  });

  it("fromFixture loads multi-turn-with-tools fixture and replays all 4 turns", async () => {
    const model = MockChatModel.fromFixture(
      path.join(FIXTURE_DIR, "multi-turn-with-tools.json"),
    );

    // Turn 1: file-read tool call
    const t1 = await callModel(model, "q1");
    const t1Calls = t1.tool_calls ?? [];
    expect(t1Calls).toHaveLength(1);
    expect(t1Calls[0].name).toBe("file-read");

    // Turn 2: final answer after tool result
    const t2 = await callModel(model, "q2");
    expect(t2.tool_calls).toHaveLength(0);
    expect(t2.content).toMatch(/hello\.js/i);

    // Turn 3: another file-read tool call
    const t3 = await callModel(model, "q3");
    expect(t3.tool_calls ?? []).toHaveLength(1);

    // Turn 4: final answer
    const t4 = await callModel(model, "q4");
    expect(t4.tool_calls).toHaveLength(0);
    expect(t4.content).toMatch(/package\.json/i);

    expect(model.callCount).toBe(4);
  });

  it("fromFixture throws when the file does not exist", () => {
    expect(() =>
      MockChatModel.fromFixture("tests/fixtures/llm-responses/nonexistent.json"),
    ).toThrow();
  });
});
