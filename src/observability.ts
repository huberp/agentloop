import * as fs from "fs/promises";
import * as path from "path";
import { randomUUID } from "crypto";

/** A single LLM call span recorded within an invocation trace. */
export interface LlmCallSpan {
  startedAt: number;
  endedAt: number;
  durationMs: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Number of tool calls the LLM requested in this call. */
  toolCallCount: number;
}

/** A single tool execution span recorded within an invocation trace. */
export interface ToolExecutionSpan {
  startedAt: number;
  endedAt: number;
  durationMs: number;
  toolName: string;
  callId: string;
  success: boolean;
  /** Error message when success is false. */
  error?: string;
}

/** Full trace record written to disk for one agent invocation. */
export interface InvocationTrace {
  invocationId: string;
  input: string;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  llmCalls: LlmCallSpan[];
  toolExecutions: ToolExecutionSpan[];
  /** Sum of prompt tokens across all LLM calls. */
  totalPromptTokens: number;
  /** Sum of completion tokens across all LLM calls. */
  totalCompletionTokens: number;
  totalTokens: number;
  /** Estimated USD cost based on configured per-token pricing. */
  estimatedCostUsd: number;
}

/**
 * Pluggable tracer interface.
 * Implement to swap in OpenTelemetry, LangSmith, or any other backend.
 */
export interface Tracer {
  /** Called at the start of an agent invocation. */
  startInvocation(invocationId: string, input: string): void;
  /** Record a completed LLM call span. */
  recordLlmCall(invocationId: string, span: LlmCallSpan): void;
  /** Record a completed tool execution span. */
  recordToolExecution(invocationId: string, span: ToolExecutionSpan): void;
  /** Called when the invocation finishes; may perform async I/O (e.g. file write). */
  endInvocation(invocationId: string): Promise<void>;
}

/** No-op tracer used when tracing is disabled — zero overhead. */
export class NoopTracer implements Tracer {
  startInvocation(_invocationId: string, _input: string): void {}
  recordLlmCall(_invocationId: string, _span: LlmCallSpan): void {}
  recordToolExecution(_invocationId: string, _span: ToolExecutionSpan): void {}
  async endInvocation(_invocationId: string): Promise<void> {}
}

/** Configuration for FileTracer. */
export interface FileTracerConfig {
  /** Directory where trace JSON files are written (created if missing). */
  outputDir: string;
  /** USD cost per input (prompt) token; used for cost estimation. */
  costPerInputTokenUsd: number;
  /** USD cost per output (completion) token; used for cost estimation. */
  costPerOutputTokenUsd: number;
}

/**
 * Default tracer: writes one structured JSON file per invocation.
 * File name: `<invocationId>.json` inside `outputDir`.
 */
export class FileTracer implements Tracer {
  private readonly config: FileTracerConfig;

  // In-progress traces keyed by invocationId
  private readonly pending = new Map<
    string,
    { input: string; startedAt: number; llmCalls: LlmCallSpan[]; toolExecutions: ToolExecutionSpan[] }
  >();

  constructor(config: FileTracerConfig) {
    this.config = config;
  }

  startInvocation(invocationId: string, input: string): void {
    this.pending.set(invocationId, {
      input,
      startedAt: Date.now(),
      llmCalls: [],
      toolExecutions: [],
    });
  }

  recordLlmCall(invocationId: string, span: LlmCallSpan): void {
    this.pending.get(invocationId)?.llmCalls.push(span);
  }

  recordToolExecution(invocationId: string, span: ToolExecutionSpan): void {
    this.pending.get(invocationId)?.toolExecutions.push(span);
  }

  async endInvocation(invocationId: string): Promise<void> {
    const state = this.pending.get(invocationId);
    if (!state) return;

    const endedAt = Date.now();
    const totalPromptTokens = state.llmCalls.reduce((s, c) => s + c.promptTokens, 0);
    const totalCompletionTokens = state.llmCalls.reduce((s, c) => s + c.completionTokens, 0);
    const totalTokens = totalPromptTokens + totalCompletionTokens;
    const estimatedCostUsd =
      totalPromptTokens * this.config.costPerInputTokenUsd +
      totalCompletionTokens * this.config.costPerOutputTokenUsd;

    const trace: InvocationTrace = {
      invocationId,
      input: state.input,
      startedAt: state.startedAt,
      endedAt,
      durationMs: endedAt - state.startedAt,
      llmCalls: state.llmCalls,
      toolExecutions: state.toolExecutions,
      totalPromptTokens,
      totalCompletionTokens,
      totalTokens,
      estimatedCostUsd,
    };

    await fs.mkdir(this.config.outputDir, { recursive: true });
    const filePath = path.join(this.config.outputDir, `${invocationId}.json`);
    await fs.writeFile(filePath, JSON.stringify(trace, null, 2), "utf-8");

    this.pending.delete(invocationId);
  }
}

/** Factory: returns a FileTracer when enabled, NoopTracer otherwise. */
export function createTracer(config: {
  enabled: boolean;
  outputDir: string;
  costPerInputTokenUsd: number;
  costPerOutputTokenUsd: number;
}): Tracer {
  if (!config.enabled) return new NoopTracer();
  return new FileTracer({
    outputDir: config.outputDir,
    costPerInputTokenUsd: config.costPerInputTokenUsd,
    costPerOutputTokenUsd: config.costPerOutputTokenUsd,
  });
}

/** Generate a new unique invocation ID (UUIDv4). */
export function newInvocationId(): string {
  return randomUUID();
}
