import * as fs from "fs";
import * as path from "path";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { BaseMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import type { LlmFixture, FixtureTurn, FixtureToolCall } from "./mock-chat-model";

// ── Internal helpers ─────────────────────────────────────────────────────────

function serializeMessages(
  messages: BaseMessage[],
): FixtureTurn["input"] {
  return messages.map((m) => {
    const base: { role: string; content: string; tool_call_id?: string } = {
      role: m._getType(),
      content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
    };
    // Attach tool_call_id for ToolMessage
    if ("tool_call_id" in m && typeof (m as Record<string, unknown>).tool_call_id === "string") {
      base.tool_call_id = (m as Record<string, unknown>).tool_call_id as string;
    }
    return base;
  });
}

function serializeToolCalls(
  toolCalls: Array<{ id?: string; name: string; args: Record<string, unknown> }>,
): FixtureToolCall[] {
  return toolCalls.map((tc, i) => ({
    id: tc.id ?? `call_${i}`,
    name: tc.name,
    args: tc.args,
  }));
}

// ── RecordingChatModel ────────────────────────────────────────────────────────

/**
 * A transparent proxy around a real `BaseChatModel` that records every
 * `_generate` call as a fixture turn.
 *
 * Activate via the `RECORD_LLM_RESPONSES=true` environment variable (or
 * pass `active: true` in options).  When recording is **inactive** the proxy
 * simply forwards calls to the wrapped model without any overhead.
 *
 * ### Usage
 *
 * ```ts
 * import { RecordingChatModel } from "../testing/recorder";
 * import { createLLM } from "./llm";
 *
 * const real = createLLM(appConfig);
 * const model = new RecordingChatModel(real, {
 *   fixturePath: "tests/fixtures/llm-responses/my-session.json",
 *   name: "my-session",
 *   description: "Recorded during manual QA on 2026-03-26",
 * });
 *
 * // … use model as you would use real …
 * await model.invoke([new HumanMessage("hello")]);
 *
 * // Flush (write) the captured turns to disk:
 * model.flush();
 * ```
 */
export class RecordingChatModel extends BaseChatModel {
  private readonly _inner: BaseChatModel;
  private readonly _fixturePath: string;
  private readonly _fixtureName: string;
  private readonly _fixtureDescription: string;
  private readonly _active: boolean;
  private readonly _capturedTurns: FixtureTurn[] = [];

  constructor(
    inner: BaseChatModel,
    options: {
      /** Destination fixture file path (absolute or CWD-relative). */
      fixturePath: string;
      /** `name` field written into the fixture JSON. */
      name?: string;
      /** `description` field written into the fixture JSON. */
      description?: string;
      /**
       * Whether recording is active.  Defaults to `true` when
       * `RECORD_LLM_RESPONSES=true` in the environment, otherwise `false`.
       */
      active?: boolean;
    },
  ) {
    super({});
    this._inner = inner;
    this._fixturePath = options.fixturePath;
    this._fixtureName = options.name ?? path.basename(options.fixturePath, ".json");
    this._fixtureDescription = options.description ?? "Recorded LLM responses";
    this._active =
      options.active ??
      (process.env.RECORD_LLM_RESPONSES ?? "").toLowerCase() === "true";
  }

  // ── BaseChatModel required overrides ─────────────────────────────────────

  _llmType(): string {
    return `recording(${this._inner._llmType()})`;
  }

  async _generate(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    const result = await (this._inner as BaseChatModel & {
      _generate(
        m: BaseMessage[],
        o: unknown,
        r?: CallbackManagerForLLMRun,
      ): Promise<ChatResult>;
    })._generate(messages, options, runManager);

    if (this._active) {
      const gen = result.generations[0];
      const aiMsg = gen?.message;
      const rawToolCalls: Array<{ id?: string; name: string; args: Record<string, unknown> }> =
        (aiMsg &&
          "tool_calls" in aiMsg &&
          Array.isArray((aiMsg as Record<string, unknown>).tool_calls)
          ? (aiMsg as Record<string, unknown>).tool_calls
          : []) as Array<{ id?: string; name: string; args: Record<string, unknown> }>;

      const turn: FixtureTurn = {
        input: serializeMessages(messages),
        output: {
          role: "ai",
          content: typeof aiMsg?.content === "string" ? aiMsg.content : "",
          tool_calls: serializeToolCalls(rawToolCalls),
        },
      };
      this._capturedTurns.push(turn);
    }

    return result;
  }

  /** Forward `bindTools` to the inner model so tool schemas are respected. */
  bindTools(
    tools: unknown[],
    kwargs?: unknown,
  ): this {
    if (this._inner.bindTools) {
      (this._inner.bindTools as (t: unknown[], k?: unknown) => unknown)(tools, kwargs);
    }
    return this;
  }

  // ── Recording API ─────────────────────────────────────────────────────────

  /** Returns `true` when the recorder is actively capturing turns. */
  get isRecording(): boolean {
    return this._active;
  }

  /** Number of turns captured so far. */
  get capturedTurnCount(): number {
    return this._capturedTurns.length;
  }

  /**
   * Write all captured turns to the configured fixture file.
   * Creates parent directories automatically.  No-op when recording is inactive.
   */
  flush(): void {
    if (!this._active || this._capturedTurns.length === 0) {
      return;
    }

    const fixture: LlmFixture = {
      name: this._fixtureName,
      description: this._fixtureDescription,
      turns: this._capturedTurns,
    };

    const dir = path.dirname(path.resolve(this._fixturePath));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.resolve(this._fixturePath),
      JSON.stringify(fixture, null, 2),
      "utf-8",
    );
  }
}
