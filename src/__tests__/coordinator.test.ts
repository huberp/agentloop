// Mock ChatMistralAI before any imports — prevents ESM parse errors in Jest
jest.mock("@langchain/mistralai", () => ({
  ChatMistralAI: jest.fn(),
}));

import { z } from "zod";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

import { ToolRegistry } from "../tools/registry";
import { SubagentManager } from "../subagents/manager";
import type { ParallelTask } from "../subagents/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockLlm(invokeFn: jest.Mock): BaseChatModel {
  return {
    bindTools: jest.fn().mockReturnValue({ invoke: invokeFn }),
  } as unknown as BaseChatModel;
}

/** Register a simple tool that optionally reports a mutated file path. */
function addTool(
  registry: ToolRegistry,
  name: string,
  result = "ok",
  mutatesFile?: (args: Record<string, unknown>) => string | undefined
): void {
  registry.register({
    name,
    description: `${name} tool`,
    schema: z.object({ path: z.string().optional() }),
    execute: async () => result,
    mutatesFile,
  });
}

// ---------------------------------------------------------------------------
// runParallel — Task 3.5
// ---------------------------------------------------------------------------

describe("SubagentManager.runParallel", () => {
  // (a) 3 parallel subagents complete independently
  it("(a) runs 3 subagents concurrently and returns all results", async () => {
    const invoke = jest.fn().mockResolvedValue({ content: "done", tool_calls: [] });
    const registry = new ToolRegistry();
    const manager = new SubagentManager(3, registry, makeMockLlm(invoke));

    const tasks: ParallelTask[] = [
      { definition: { name: "agent-1", tools: [], maxIterations: 5 }, task: "task 1" },
      { definition: { name: "agent-2", tools: [], maxIterations: 5 }, task: "task 2" },
      { definition: { name: "agent-3", tools: [], maxIterations: 5 }, task: "task 3" },
    ];

    const { results, conflicts } = await manager.runParallel(tasks);

    // All three subagents should succeed
    expect(results).toHaveLength(3);
    const names = results.map((r) => r.name);
    expect(names).toContain("agent-1");
    expect(names).toContain("agent-2");
    expect(names).toContain("agent-3");

    // All fulfilled results carry the expected output
    for (const r of results) {
      expect("output" in r).toBe(true);
      if ("output" in r) expect(r.output).toBe("done");
    }

    // No conflicts when agents write to different files (or no files at all)
    expect(conflicts).toHaveLength(0);
    expect(invoke).toHaveBeenCalledTimes(3);
  });

  // (b) conflict detection triggers on overlapping file edits
  it("(b) flags a conflict when two subagents write to the same file", async () => {
    // Both agents follow the same pattern: 1st call → tool call, 2nd call → done
    // Use concurrencyLimit=1 so they execute sequentially, making mock order predictable
    const invoke = jest
      .fn()
      .mockResolvedValueOnce({
        content: "",
        tool_calls: [{ id: "c1", name: "file_write", args: { path: "shared.txt" } }],
      })
      .mockResolvedValueOnce({ content: "agent-1 done", tool_calls: [] })
      .mockResolvedValueOnce({
        content: "",
        tool_calls: [{ id: "c2", name: "file_write", args: { path: "shared.txt" } }],
      })
      .mockResolvedValueOnce({ content: "agent-2 done", tool_calls: [] });

    const registry = new ToolRegistry();
    // file_write tool reports the mutated file path via mutatesFile
    addTool(registry, "file_write", "written", (args) => args.path as string | undefined);

    // Sequential execution (limit=1) ensures mock responses are consumed in order
    const manager = new SubagentManager(1, registry, makeMockLlm(invoke));

    const tasks: ParallelTask[] = [
      {
        definition: { name: "writer-1", tools: ["file_write"], maxIterations: 5 },
        task: "write shared.txt",
      },
      {
        definition: { name: "writer-2", tools: ["file_write"], maxIterations: 5 },
        task: "also write shared.txt",
      },
    ];

    const { results, conflicts } = await manager.runParallel(tasks);

    // Both results should be present
    expect(results).toHaveLength(2);

    // Exactly one conflict for "shared.txt"
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].file).toBe("shared.txt");
    expect(conflicts[0].agents).toContain("writer-1");
    expect(conflicts[0].agents).toContain("writer-2");
  });

  // (b) no false conflict when agents write to different files
  it("(b) does not flag a conflict when agents write to different files", async () => {
    // concurrencyLimit=1 ensures sequential execution so mock order is predictable:
    // w1 writes a.txt (calls 1-2), then w2 writes b.txt (calls 3-4)
    const invoke = jest
      .fn()
      .mockResolvedValueOnce({
        content: "",
        tool_calls: [{ id: "c1", name: "file_write", args: { path: "a.txt" } }],
      })
      .mockResolvedValueOnce({ content: "w1 done", tool_calls: [] })
      .mockResolvedValueOnce({
        content: "",
        tool_calls: [{ id: "c2", name: "file_write", args: { path: "b.txt" } }],
      })
      .mockResolvedValueOnce({ content: "w2 done", tool_calls: [] });

    const registry = new ToolRegistry();
    addTool(registry, "file_write", "written", (args) => args.path as string | undefined);

    // Sequential execution so mock responses are consumed in a known order
    const manager = new SubagentManager(1, registry, makeMockLlm(invoke));

    const tasks: ParallelTask[] = [
      { definition: { name: "w1", tools: ["file_write"], maxIterations: 5 }, task: "write a.txt" },
      { definition: { name: "w2", tools: ["file_write"], maxIterations: 5 }, task: "write b.txt" },
    ];

    const { conflicts } = await manager.runParallel(tasks);
    expect(conflicts).toHaveLength(0);
  });

  // (c) aggregated results contain all outputs
  it("(c) aggregated results contain outputs from every subagent", async () => {
    const invoke = jest
      .fn()
      .mockResolvedValueOnce({ content: "output-A", tool_calls: [] })
      .mockResolvedValueOnce({ content: "output-B", tool_calls: [] })
      .mockResolvedValueOnce({ content: "output-C", tool_calls: [] });

    const registry = new ToolRegistry();
    const manager = new SubagentManager(3, registry, makeMockLlm(invoke));

    const tasks: ParallelTask[] = [
      { definition: { name: "a", tools: [], maxIterations: 5 }, task: "task a" },
      { definition: { name: "b", tools: [], maxIterations: 5 }, task: "task b" },
      { definition: { name: "c", tools: [], maxIterations: 5 }, task: "task c" },
    ];

    const { results } = await manager.runParallel(tasks);

    expect(results).toHaveLength(3);
    const outputs = results.map((r) => ("output" in r ? r.output : null));
    expect(outputs).toContain("output-A");
    expect(outputs).toContain("output-B");
    expect(outputs).toContain("output-C");
  });

  // (c) failed subagent is captured as an error record, not thrown
  it("(c) captures errors from failed subagents without rejecting the whole call", async () => {
    // First invocation throws; second succeeds
    const invoke = jest
      .fn()
      .mockRejectedValueOnce(new Error("subagent exploded"))
      .mockResolvedValueOnce({ content: "success", tool_calls: [] });

    const registry = new ToolRegistry();
    const manager = new SubagentManager(2, registry, makeMockLlm(invoke));

    const tasks: ParallelTask[] = [
      { definition: { name: "bad-agent", tools: [], maxIterations: 5 }, task: "fail" },
      { definition: { name: "good-agent", tools: [], maxIterations: 5 }, task: "succeed" },
    ];

    const { results } = await manager.runParallel(tasks);

    expect(results).toHaveLength(2);

    const bad = results.find((r) => r.name === "bad-agent");
    expect(bad).toBeDefined();
    expect("error" in bad!).toBe(true);
    if ("error" in bad!) expect(bad!.error).toContain("subagent exploded");

    const good = results.find((r) => r.name === "good-agent");
    expect(good).toBeDefined();
    expect("output" in good!).toBe(true);
  });

  // Shared context is injected into the system prompt
  it("injects sharedContext into the subagent system prompt as read-only", async () => {
    const invoke = jest.fn().mockResolvedValue({ content: "done", tool_calls: [] });

    const mockLlm = {
      bindTools: jest.fn().mockReturnValue({ invoke }),
    } as unknown as BaseChatModel;

    const registry = new ToolRegistry();
    const manager = new SubagentManager(1, registry, mockLlm);

    const tasks: ParallelTask[] = [
      {
        definition: {
          name: "ctx-agent",
          tools: [],
          maxIterations: 1,
          sharedContext: { projectName: "agentloop", version: 2 },
        },
        task: "use shared context",
      },
    ];

    await manager.runParallel(tasks);

    // The system prompt passed to invoke should contain the shared context JSON
    const messagesArg: Array<{ content: string }> = invoke.mock.calls[0][0];
    const systemContent = messagesArg[0].content;
    expect(systemContent).toContain("Shared Context (read-only)");
    expect(systemContent).toContain('"projectName": "agentloop"');
    expect(systemContent).toContain('"version": 2');
  });
});
