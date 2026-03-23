import { HumanMessage, AIMessage, SystemMessage } from "@langchain/core/messages";
import { BaseMessage } from "@langchain/core/messages";
import { countTokens, trimMessages } from "../context";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a HumanMessage whose content is `n` repetitions of "word ". */
function longHuman(words: number): HumanMessage {
  return new HumanMessage("word ".repeat(words));
}

/** Build a system + many human messages that together exceed `targetTokens`. */
function buildLargeHistory(targetTokens: number): BaseMessage[] {
  const system = new SystemMessage("You are a helpful assistant.");
  const messages: BaseMessage[] = [system];
  let total = countTokens([system]);

  while (total < targetTokens) {
    const msg = longHuman(50); // ~50 tokens per message
    messages.push(msg);
    total += countTokens([msg]);
  }
  return messages;
}

// ---------------------------------------------------------------------------
// countTokens
// ---------------------------------------------------------------------------

describe("countTokens", () => {
  it("returns 0 for an empty array", () => {
    expect(countTokens([])).toBe(0);
  });

  it("returns a positive number for a non-empty message", () => {
    const msgs = [new HumanMessage("Hello world")];
    expect(countTokens(msgs)).toBeGreaterThan(0);
  });

  it("increases as more messages are added", () => {
    const one = [new HumanMessage("Hello")];
    const two = [new HumanMessage("Hello"), new AIMessage("World")];
    expect(countTokens(two)).toBeGreaterThan(countTokens(one));
  });

  it("handles messages with non-string content (object → JSON)", () => {
    const msg = new HumanMessage({ text: "nested content" } as any);
    expect(() => countTokens([msg])).not.toThrow();
    expect(countTokens([msg])).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// trimMessages
// ---------------------------------------------------------------------------

describe("trimMessages", () => {
  it("returns the original array when it already fits within maxTokens", () => {
    const msgs = [new SystemMessage("sys"), new HumanMessage("hi")];
    const result = trimMessages(msgs, 10000);
    expect(result).toBe(msgs); // same reference — no copy made
  });

  it("returns the original array when there is only one message", () => {
    const msgs = [new SystemMessage("sys")];
    const result = trimMessages(msgs, 1); // tiny budget but nothing to drop
    expect(result).toBe(msgs);
  });

  it("always keeps the first message (system prompt)", () => {
    const msgs = buildLargeHistory(5000);
    const budget = Math.floor(countTokens(msgs) / 2);

    const result = trimMessages(msgs, budget);
    // First message reference must be preserved
    expect(result[0]).toBe(msgs[0]);
  });

  it("always keeps the last message (most-recent user message)", () => {
    const msgs = buildLargeHistory(5000);
    const last = msgs[msgs.length - 1];
    const budget = Math.floor(countTokens(msgs) / 2);

    const result = trimMessages(msgs, budget);
    expect(result[result.length - 1]).toBe(last);
  });

  it("drops oldest middle messages first", () => {
    const system = new SystemMessage("sys");
    const old1 = new HumanMessage("old message 1");
    const old2 = new HumanMessage("old message 2");
    const recent = new HumanMessage("recent message");

    const msgs = [system, old1, old2, recent];
    // Budget set to exactly the tokens needed for [system, old2, recent] — forces old1 to be dropped
    const tokensAfterDropping = countTokens([system, old2, recent]);

    const result = trimMessages(msgs, tokensAfterDropping);
    expect(result).not.toContainEqual(old1);
    expect(result).toContainEqual(system);
    expect(result).toContainEqual(recent);
  });

  it("result fits within maxTokens after trimming", () => {
    const msgs = buildLargeHistory(10000);
    const budget = 2000;

    const result = trimMessages(msgs, budget);
    expect(countTokens(result)).toBeLessThanOrEqual(budget);
  });

  it("100 synthetic messages: result fits within MAX_CONTEXT_TOKENS (28000)", () => {
    const system = new SystemMessage("You are a helpful AI agent with many tools available.");
    const history: BaseMessage[] = [system];

    // Build 100 alternating human / AI messages (~30 tokens each)
    for (let i = 0; i < 50; i++) {
      history.push(new HumanMessage(`This is user message number ${i}. Please help me with this task.`));
      history.push(new AIMessage(`This is the assistant reply number ${i}. Here is my response.`));
    }

    const MAX_CONTEXT_TOKENS = 28000;
    const result = trimMessages(history, MAX_CONTEXT_TOKENS);

    expect(countTokens(result)).toBeLessThanOrEqual(MAX_CONTEXT_TOKENS);
    // System prompt preserved
    expect(result[0]).toBe(system);
    // Last message preserved
    expect(result[result.length - 1]).toBe(history[history.length - 1]);
  });
});
