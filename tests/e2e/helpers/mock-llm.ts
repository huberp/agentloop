import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

/** Shape of a single deterministic response from the mock LLM. */
export interface MockResponse {
  /** Text content of the response (empty string when the model is requesting a tool call). */
  content: string;
  /** Tool calls requested by the model; omit or leave empty for a final text response. */
  tool_calls?: Array<{
    id: string;
    name: string;
    args: Record<string, unknown>;
  }>;
}

/**
 * Create a minimal mock BaseChatModel for E2E tests.
 *
 * Responses are consumed in sequence. Once all responses are consumed,
 * the last response repeats on every subsequent call.
 *
 * Usage:
 *   const llm = createMockLlm([
 *     { content: "", tool_calls: [{ id: "c1", name: "file-write", args: { path: "x.txt", content: "hi" } }] },
 *     { content: "Done." },
 *   ]);
 *
 * Note: For live LLM testing (E2E_USE_REAL_LLM=true), do not use this factory —
 * pass `undefined` to runSubagent/generatePlan and remove the jest.mock for
 * @langchain/mistralai in the test file.
 */
export function createMockLlm(responses: MockResponse[]): BaseChatModel {
  let callIndex = 0;

  const invoke = async (_messages: unknown) => {
    const idx = Math.min(callIndex, responses.length - 1);
    callIndex++;
    const resp = responses[idx];
    return {
      content: resp.content,
      tool_calls: resp.tool_calls ?? [],
    };
  };

  return {
    bindTools: (_tools: unknown) => ({ invoke }),
  } as unknown as BaseChatModel;
}
