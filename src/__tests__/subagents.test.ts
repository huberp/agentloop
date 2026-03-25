// Mock ChatMistralAI before any imports — prevents ESM parse errors in Jest
jest.mock("@langchain/mistralai", () => ({
  ChatMistralAI: jest.fn(),
}));

import { z } from "zod";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

import { ToolRegistry } from "../tools/registry";
import { runSubagent } from "../subagents/runner";
import { SubagentManager } from "../subagents/manager";
import type { SubagentDefinition } from "../subagents/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a mock LLM whose `invoke` responses are controlled per test.
 * `bindTools()` returns an object with the same `invoke` mock so the runner
 * can call `agentLlm.bindTools(...).invoke(...)` without errors.
 */
function makeMockLlm(invokeFn: jest.Mock): BaseChatModel {
  return {
    bindTools: jest.fn().mockReturnValue({ invoke: invokeFn }),
  } as unknown as BaseChatModel;
}

/** Build a minimal ToolDefinition and register it in the given registry. */
function addTool(registry: ToolRegistry, name: string, result = "ok"): void {
  registry.register({
    name,
    description: `${name} tool`,
    schema: z.object({}),
    execute: async () => result,
  });
}

// ---------------------------------------------------------------------------
// runSubagent tests
// ---------------------------------------------------------------------------

describe("runSubagent", () => {
  it("(a) runs to completion and returns the final output", async () => {
    const invoke = jest
      .fn()
      // First iteration: request one tool call
      .mockResolvedValueOnce({
        content: "",
        tool_calls: [{ id: "c1", name: "search", args: {} }],
      })
      // Second iteration: no tool calls → done
      .mockResolvedValueOnce({ content: "final answer", tool_calls: [] });

    const registry = new ToolRegistry();
    addTool(registry, "search", "some results");

    const def: SubagentDefinition = { name: "test-agent", tools: ["search"], maxIterations: 5 };
    const result = await runSubagent(def, "find something", registry, makeMockLlm(invoke));

    expect(result.name).toBe("test-agent");
    expect(result.output).toBe("final answer");
    expect(result.iterations).toBe(2);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("(a) returns immediately when the LLM makes zero tool calls", async () => {
    const invoke = jest.fn().mockResolvedValueOnce({ content: "direct answer", tool_calls: [] });

    const registry = new ToolRegistry();
    const def: SubagentDefinition = { name: "fast-agent", tools: [], maxIterations: 5 };
    const result = await runSubagent(def, "quick task", registry, makeMockLlm(invoke));

    expect(result.output).toBe("direct answer");
    expect(result.iterations).toBe(1);
  });

  it("(b) respects its own maxIterations and returns a warning when the budget is exhausted", async () => {
    // Always return a tool call → loop would be infinite without the guard
    const invoke = jest.fn().mockResolvedValue({
      content: "still thinking",
      tool_calls: [{ id: "c1", name: "search", args: {} }],
    });

    const registry = new ToolRegistry();
    addTool(registry, "search");

    const def: SubagentDefinition = { name: "loopy", tools: ["search"], maxIterations: 3 };
    const result = await runSubagent(def, "never-ending task", registry, makeMockLlm(invoke));

    expect(result.output).toMatch(/\[Warning: Maximum iterations reached\]/);
    // With maxIterations=3, the 3rd LLM call happens (iteration=3 >= maxIterations=3),
    // so the guard fires after that call and before any further tool execution.
    expect(invoke).toHaveBeenCalledTimes(3);
  });

  it("(c) only exposes tools listed in SubagentDefinition.tools to the LLM", async () => {
    const invoke = jest.fn().mockResolvedValue({ content: "done", tool_calls: [] });

    const registry = new ToolRegistry();
    addTool(registry, "search");
    addTool(registry, "calculate"); // NOT listed in the definition

    const mockLlm = {
      bindTools: jest.fn().mockReturnValue({ invoke }),
    } as unknown as BaseChatModel;

    const def: SubagentDefinition = { name: "restricted", tools: ["search"], maxIterations: 5 };
    await runSubagent(def, "task", registry, mockLlm);

    // bindTools must have been called with exactly the allowed tools
    const toolsPassedToLlm: Array<{ name: string }> = (mockLlm.bindTools as jest.Mock).mock
      .calls[0][0];
    expect(toolsPassedToLlm).toHaveLength(1);
    expect(toolsPassedToLlm[0].name).toBe("search");
  });

  it("(c) a tool not in the allowed list is unavailable even if registered", async () => {
    // The LLM requests "calculate", which is NOT in definition.tools
    const invoke = jest
      .fn()
      .mockResolvedValueOnce({
        content: "",
        tool_calls: [{ id: "c1", name: "calculate", args: {} }],
      })
      .mockResolvedValueOnce({ content: "gave up", tool_calls: [] });

    const registry = new ToolRegistry();
    addTool(registry, "search");
    addTool(registry, "calculate");

    const def: SubagentDefinition = {
      name: "no-calc",
      tools: ["search"], // "calculate" deliberately excluded
      maxIterations: 5,
    };
    const result = await runSubagent(def, "compute 2+2", registry, makeMockLlm(invoke));

    // The final answer from the second iteration (after "tool not found" is fed back)
    expect(result.output).toBe("gave up");
    // Two LLM calls: one requesting the blocked tool, one after the "not found" message
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("uses a custom systemPrompt when provided in the definition", async () => {
    const invoke = jest.fn().mockResolvedValue({ content: "done", tool_calls: [] });

    const mockLlm = {
      bindTools: jest.fn().mockReturnValue({ invoke }),
    } as unknown as BaseChatModel;

    const def: SubagentDefinition = {
      name: "custom-prompt-agent",
      systemPrompt: "You are a custom bot.",
      tools: [],
      maxIterations: 1,
    };

    const registry = new ToolRegistry();
    await runSubagent(def, "hello", registry, mockLlm);

    // The first argument to invoke is the message array; the first element is the SystemMessage
    const messagesArg: Array<{ content: string }> = invoke.mock.calls[0][0];
    expect(messagesArg[0].content).toBe("You are a custom bot.");
  });
});

// ---------------------------------------------------------------------------
// SubagentManager tests
// ---------------------------------------------------------------------------

describe("SubagentManager", () => {
  it("(a) runs a single subagent to completion", async () => {
    const invoke = jest.fn().mockResolvedValue({ content: "result", tool_calls: [] });
    const registry = new ToolRegistry();
    const manager = new SubagentManager(2, registry, makeMockLlm(invoke));

    const def: SubagentDefinition = { name: "solo", tools: [], maxIterations: 5 };
    const result = await manager.run(def, "task");

    expect(result.output).toBe("result");
    expect(result.name).toBe("solo");
  });

  it("(d) enforces concurrency limit — at most N subagents run simultaneously", async () => {
    let concurrentCount = 0;
    let maxConcurrent = 0;

    // Slow LLM mock: tracks how many subagents are executing at the same time
    const invoke = jest.fn().mockImplementation(async () => {
      concurrentCount++;
      maxConcurrent = Math.max(maxConcurrent, concurrentCount);
      // Artificial delay so subagents overlap in time when limit allows it
      await new Promise((resolve) => setTimeout(resolve, 30));
      concurrentCount--;
      return { content: "done", tool_calls: [] };
    });

    const registry = new ToolRegistry();
    const manager = new SubagentManager(2, registry, makeMockLlm(invoke));

    const def: SubagentDefinition = { name: "t", tools: [], maxIterations: 5 };

    // Launch 3 subagents concurrently; only 2 should run at a time
    await Promise.all([
      manager.run({ ...def, name: "a" }, "task a"),
      manager.run({ ...def, name: "b" }, "task b"),
      manager.run({ ...def, name: "c" }, "task c"),
    ]);

    expect(maxConcurrent).toBeLessThanOrEqual(2);
    expect(invoke).toHaveBeenCalledTimes(3); // all 3 subagents completed
  });

  it("(d) queued subagent starts after a running one finishes", async () => {
    const completionOrder: string[] = [];

    let resolveFirst!: () => void;
    const firstLatch = new Promise<void>((res) => (resolveFirst = res));

    // First subagent: blocks until we release it explicitly
    const invokeFirst = jest.fn().mockImplementation(async () => {
      await firstLatch;
      completionOrder.push("first");
      return { content: "first done", tool_calls: [] };
    });

    // Second and third subagents: return immediately
    const invokeFast = jest.fn().mockImplementation(async () => {
      completionOrder.push("fast");
      return { content: "fast done", tool_calls: [] };
    });

    const makeBlockingLlm = (invokeFn: jest.Mock): BaseChatModel =>
      ({ bindTools: jest.fn().mockReturnValue({ invoke: invokeFn }) } as unknown as BaseChatModel);

    const registry = new ToolRegistry();
    // Limit 1 so the second subagent must queue behind the first
    const manager = new SubagentManager(1, registry, makeBlockingLlm(invokeFast));

    // Override the LLM for only the first subagent by using a separate manager
    // (manager holds one LLM; easiest way is to spy via the invoke path)
    // Simpler: give both subagents the same slow mock and release manually
    const slowInvoke = jest
      .fn()
      .mockImplementationOnce(async () => {
        await firstLatch; // blocks until released
        completionOrder.push("first");
        return { content: "done", tool_calls: [] };
      })
      .mockImplementationOnce(async () => {
        completionOrder.push("second");
        return { content: "done", tool_calls: [] };
      });

    const manager2 = new SubagentManager(
      1,
      registry,
      makeBlockingLlm(slowInvoke)
    );

    const def: SubagentDefinition = { name: "t", tools: [], maxIterations: 5 };

    // Start both; second must wait behind first
    const p1 = manager2.run({ ...def, name: "first" }, "t1");
    const p2 = manager2.run({ ...def, name: "second" }, "t2");

    // Give a tick for both promises to initialise, then release the first
    await new Promise((resolve) => setTimeout(resolve, 10));
    resolveFirst();

    await Promise.all([p1, p2]);

    // First subagent must complete before second starts (due to limit=1)
    expect(completionOrder).toEqual(["first", "second"]);
  });
});
