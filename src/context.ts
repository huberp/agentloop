import { BaseMessage } from "@langchain/core/messages";
import { getEncoding } from "js-tiktoken";

// cl100k_base is used by GPT-4 and is a reasonable approximation for most modern LLMs
const enc = getEncoding("cl100k_base");

/** Return the token count for a single message's content. */
function messageTokens(msg: BaseMessage): number {
  const text = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
  return enc.encode(text).length;
}

/** Count the total number of tokens across all messages. */
export function countTokens(messages: BaseMessage[]): number {
  return messages.reduce((total, msg) => total + messageTokens(msg), 0);
}

/**
 * Trim the message list to fit within `maxTokens`.
 *
 * Strategy (simple "drop oldest" — no summarisation):
 *   - The first message (system prompt) is always kept.
 *   - The last message (most-recent user turn) is always kept.
 *   - Oldest middle messages are dropped one-by-one until the list fits.
 *
 * Returns the original array unchanged when no trimming is required.
 */
export function trimMessages(messages: BaseMessage[], maxTokens: number): BaseMessage[] {
  if (messages.length <= 1) return messages;

  // Compute per-message token counts in a single pass to avoid redundant
  // tokenizer calls during the drop loop (each enc.encode() call has overhead).
  const tokenCounts = messages.map(messageTokens);
  let total = tokenCounts.reduce((sum, t) => sum + t, 0);

  if (total <= maxTokens) return messages;

  const first = messages[0];   // system prompt — never dropped
  const last = messages[messages.length - 1]; // most-recent message — never dropped
  const middle = messages.slice(1, -1);
  const middleCounts = tokenCounts.slice(1, -1);

  // Drop oldest middle messages, subtracting their pre-computed token count
  let i = 0;
  while (i < middle.length && total > maxTokens) {
    total -= middleCounts[i];
    i++;
  }

  return [first, ...middle.slice(i), last];
}
