// Mock ChatMistralAI before any imports — prevents ESM parse errors in Jest
jest.mock("@langchain/mistralai", () => ({
  ChatMistralAI: jest.fn(),
}));

import { z } from "zod";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

import { ToolRegistry } from "../tools/registry";
import { SubagentManager } from "../subagents/manager";
import type { ParallelTask } from "../subagents/types";
import { AgentProfileRegistry } from "../agents/registry";
import { routeRequest, ROUTER_SYSTEM_PROMPT } from "../agents/coordinator";
import type { AgentProfile } from "../agents/types";

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

// ---------------------------------------------------------------------------
// Helper: build a minimal AgentProfile
// ---------------------------------------------------------------------------

function makeProfile(name: string, description: string): AgentProfile {
  return {
    name,
    description,
    version: "1.0.0",
  };
}

/** Populate a fresh registry with a set of profiles. */
function makeProfileRegistry(...profiles: AgentProfile[]): AgentProfileRegistry {
  const reg = new AgentProfileRegistry();
  for (const p of profiles) {
    reg.register(p);
  }
  return reg;
}

// ---------------------------------------------------------------------------
// routeRequest — coordinator router
// ---------------------------------------------------------------------------

describe("routeRequest", () => {
  it("returns the matched profile when the LLM selects a valid name", async () => {
    const coderProfile = makeProfile("coder", "Writes and edits source code");
    const plannerProfile = makeProfile("planner", "Plans complex tasks");
    const profileRegistry = makeProfileRegistry(coderProfile, plannerProfile);
    const registry = new ToolRegistry();

    const invoke = jest
      .fn()
      .mockResolvedValueOnce({ content: JSON.stringify({ profile: "coder" }), tool_calls: [] });

    const result = await routeRequest(
      "Write a function to sort an array",
      profileRegistry,
      registry,
      makeMockLlm(invoke)
    );

    expect(result).not.toBeNull();
    expect(result!.name).toBe("coder");
  });

  it("returns null when the LLM responds with { profile: null }", async () => {
    const profileRegistry = makeProfileRegistry(makeProfile("coder", "Writes code"));
    const registry = new ToolRegistry();

    const invoke = jest
      .fn()
      .mockResolvedValueOnce({ content: JSON.stringify({ profile: null }), tool_calls: [] });

    const result = await routeRequest(
      "What is the capital of France?",
      profileRegistry,
      registry,
      makeMockLlm(invoke)
    );

    expect(result).toBeNull();
  });

  it("returns null when the LLM returns an unknown profile name", async () => {
    const profileRegistry = makeProfileRegistry(makeProfile("coder", "Writes code"));
    const registry = new ToolRegistry();

    const invoke = jest
      .fn()
      .mockResolvedValueOnce({
        content: JSON.stringify({ profile: "nonexistent-profile" }),
        tool_calls: [],
      });

    const result = await routeRequest(
      "Do something",
      profileRegistry,
      registry,
      makeMockLlm(invoke)
    );

    expect(result).toBeNull();
  });

  it("returns null gracefully when the LLM returns invalid JSON", async () => {
    const profileRegistry = makeProfileRegistry(makeProfile("coder", "Writes code"));
    const registry = new ToolRegistry();

    const invoke = jest
      .fn()
      .mockResolvedValueOnce({ content: "this is not json at all", tool_calls: [] });

    const result = await routeRequest(
      "Anything",
      profileRegistry,
      registry,
      makeMockLlm(invoke)
    );

    expect(result).toBeNull();
  });

  it("returns null and does not throw when the subagent rejects", async () => {
    const profileRegistry = makeProfileRegistry(makeProfile("coder", "Writes code"));
    const registry = new ToolRegistry();

    const invoke = jest.fn().mockRejectedValueOnce(new Error("LLM unavailable"));

    await expect(
      routeRequest("Anything", profileRegistry, registry, makeMockLlm(invoke))
    ).resolves.toBeNull();
  });

  it("returns null when no profiles are registered", async () => {
    const profileRegistry = new AgentProfileRegistry();
    const registry = new ToolRegistry();
    const invoke = jest.fn();

    const result = await routeRequest(
      "Write code",
      profileRegistry,
      registry,
      makeMockLlm(invoke)
    );

    expect(result).toBeNull();
    // LLM should not be called when there are no profiles to route to
    expect(invoke).not.toHaveBeenCalled();
  });

  it("passes profile names and descriptions to the LLM in the routing task", async () => {
    const profileRegistry = makeProfileRegistry(
      makeProfile("coder", "Writes source code"),
      makeProfile("devops", "Manages deployment and CI")
    );
    const registry = new ToolRegistry();

    const invoke = jest
      .fn()
      .mockResolvedValueOnce({ content: JSON.stringify({ profile: "coder" }), tool_calls: [] });

    const mockLlm = {
      bindTools: jest.fn().mockReturnValue({ invoke }),
    } as unknown as BaseChatModel;

    await routeRequest("Implement a feature", profileRegistry, registry, mockLlm);

    // The message passed to the LLM should contain the profile names and descriptions
    const messages: Array<{ content: string }> = invoke.mock.calls[0][0];
    const userMsg = messages.find((m) => typeof m.content === "string" && m.content.includes("coder"));
    expect(userMsg).toBeDefined();
    expect(userMsg!.content).toContain("coder");
    expect(userMsg!.content).toContain("devops");
    expect(userMsg!.content).toContain("Writes source code");
  });

  it("uses the ROUTER_SYSTEM_PROMPT as the subagent system prompt", async () => {
    const profileRegistry = makeProfileRegistry(makeProfile("coder", "Writes code"));
    const registry = new ToolRegistry();

    const invoke = jest
      .fn()
      .mockResolvedValueOnce({ content: JSON.stringify({ profile: "coder" }), tool_calls: [] });

    const mockLlm = {
      bindTools: jest.fn().mockReturnValue({ invoke }),
    } as unknown as BaseChatModel;

    await routeRequest("Do coding work", profileRegistry, registry, mockLlm);

    // The system message should contain the ROUTER_SYSTEM_PROMPT content
    const messages: Array<{ content: string }> = invoke.mock.calls[0][0];
    const sysMsg = messages[0];
    expect(sysMsg.content).toContain("routing assistant");
    expect(sysMsg.content).toContain("profile");
    // Verify ROUTER_SYSTEM_PROMPT is exported and non-empty
    expect(ROUTER_SYSTEM_PROMPT).toBeTruthy();
    expect(ROUTER_SYSTEM_PROMPT).toContain("routing assistant");
  });

  it("parses JSON wrapped in markdown code fences", async () => {
    const coderProfile = makeProfile("coder", "Writes code");
    const profileRegistry = makeProfileRegistry(coderProfile);
    const registry = new ToolRegistry();

    const responseJson = JSON.stringify({ profile: "coder" });
    const invoke = jest
      .fn()
      .mockResolvedValueOnce({
        content: `\`\`\`json\n${responseJson}\n\`\`\``,
        tool_calls: [],
      });

    const result = await routeRequest(
      "Write a sort function",
      profileRegistry,
      registry,
      makeMockLlm(invoke)
    );

    expect(result).not.toBeNull();
    expect(result!.name).toBe("coder");
  });
});
