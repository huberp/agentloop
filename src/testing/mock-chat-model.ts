import * as fs from "fs";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { BaseMessage } from "@langchain/core/messages";
import { AIMessage } from "@langchain/core/messages";
import type { ChatResult, ChatGeneration } from "@langchain/core/outputs";
import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";

// ── Fixture types ─────────────────────────────────────────────────────────────

/** A single tool call entry inside a fixture turn output. */
export interface FixtureToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/** One input/output turn in a fixture file. */
export interface FixtureTurn {
  input: Array<{ role: string; content: string; tool_call_id?: string }>;
  output: {
    role: string;
    content: string;
    tool_calls: FixtureToolCall[];
  };
}

/** Top-level fixture file shape written/read by the recorder and MockChatModel. */
export interface LlmFixture {
  name: string;
  description: string;
  turns: FixtureTurn[];
}

/** A single deterministic response — matches the output shape of a FixtureTurn. */
export type MockResponse = FixtureTurn["output"];

// ── MockChatModel ─────────────────────────────────────────────────────────────

/**
 * A LangChain-compatible chat model that replays pre-recorded responses.
 *
 * Responses are consumed **sequentially** (index 0, 1, 2 …).  Once all
 * responses are consumed the last one repeats on every subsequent call —
 * this mirrors the behaviour of the E2E `createMockLlm` helper.
 *
 * ### Loading responses
 *
 * ```ts
 * // In-memory sequence
 * const model = new MockChatModel();
 * model.setResponses([
 *   { role: "ai", content: "", tool_calls: [{ id: "c1", name: "search", args: { q: "hi" } }] },
 *   { role: "ai", content: "Done.", tool_calls: [] },
 * ]);
 *
 * // From a recorded fixture file
 * const model = MockChatModel.fromFixture("tests/fixtures/llm-responses/single-tool-call.json");
 * ```
 */
export class MockChatModel extends BaseChatModel {
  private _responses: MockResponse[] = [
    { role: "ai", content: "Mock response", tool_calls: [] },
  ];
  private _callIndex = 0;

  constructor() {
    super({});
  }

  // ── BaseChatModel required overrides ─────────────────────────────────────

  _llmType(): string {
    return "mock";
  }

  async _generate(
    _messages: BaseMessage[],
    _options: this["ParsedCallOptions"],
    _runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    const idx = Math.min(this._callIndex, this._responses.length - 1);
    this._callIndex++;

    const resp = this._responses[idx];

    const message = new AIMessage({
      content: resp.content,
      tool_calls: resp.tool_calls.map((tc) => ({
        id: tc.id,
        name: tc.name,
        args: tc.args,
        type: "tool_call" as const,
      })),
    });

    const generation: ChatGeneration = { text: resp.content, message };
    return { generations: [generation] };
  }

  /**
   * Return `this` so callers that do `llm.bindTools(tools).invoke(…)` work
   * without any real tool-binding logic.  The MockChatModel ignores the
   * provided tool schemas.
   */
  bindTools(
    _tools: unknown[],
    _kwargs?: unknown,
  ): this {
    return this;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Replace the response queue and reset the call counter.
   * @throws if `responses` is empty.
   */
  setResponses(responses: MockResponse[]): void {
    if (responses.length === 0) {
      throw new Error(
        "MockChatModel.setResponses: responses array must not be empty",
      );
    }
    this._responses = responses;
    this._callIndex = 0;
  }

  /** Reset the call counter so the response sequence replays from the start. */
  reset(): void {
    this._callIndex = 0;
  }

  /** How many times `_generate` has been called since the last reset. */
  get callCount(): number {
    return this._callIndex;
  }

  // ── Static factories ─────────────────────────────────────────────────────

  /**
   * Load a JSON fixture file and return a `MockChatModel` pre-loaded with
   * all turn outputs in sequence.
   *
   * @param fixturePath Absolute or CWD-relative path to a `.json` fixture.
   */
  static fromFixture(fixturePath: string): MockChatModel {
    const raw = fs.readFileSync(fixturePath, "utf-8");
    const fixture = JSON.parse(raw) as LlmFixture;
    const model = new MockChatModel();
    model.setResponses(fixture.turns.map((t) => t.output));
    return model;
  }
}
