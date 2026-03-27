import { appConfig } from "../config";
import { addLogListener, type LogEntry } from "../logger";

interface InvokeResult {
  output: string;
}

export interface TuiAgentExecutor {
  invoke: (input: string) => Promise<InvokeResult>;
  stream: (input: string) => AsyncGenerator<string>;
}

interface StatsState {
  requests: number;
  successes: number;
  failures: number;
  totalOutputChars: number;
  lastDurationMs: number;
}

const OUTPUT_HISTORY_LIMIT = 500;
const LOG_HISTORY_LIMIT = 250;

const MIN_TERMINAL_ROWS = 14;
const MIN_TERMINAL_COLS = 60;

function appendLine(lines: string[], line: string, maxLines: number): string[] {
  const next = [...lines, line];
  if (next.length <= maxLines) return next;
  return next.slice(next.length - maxLines);
}

function appendToLastLine(lines: string[], chunk: string): string[] {
  if (lines.length === 0) return [chunk];
  const next = [...lines];
  next[next.length - 1] = `${next[next.length - 1]}${chunk}`;
  return next;
}

function flattenLines(lines: string[]): string[] {
  const flat: string[] = [];
  for (const line of lines) {
    const parts = line.split(/\r?\n/);
    for (const part of parts) flat.push(part);
  }
  return flat;
}

function truncateToWidth(value: string, width: number): string {
  if (width <= 0) return "";
  if (value.length <= width) return value;
  if (width <= 3) return value.slice(0, width);
  return `${value.slice(0, width - 3)}...`;
}

function fitLinesToWidth(lines: string[], width: number): string[] {
  return lines.map((line) => truncateToWidth(line, width));
}

function getWindowedLines(lines: string[], viewportHeight: number, scrollOffset: number): {
  visible: string[];
  maxOffset: number;
  clampedOffset: number;
} {
  const safeViewport = Math.max(1, viewportHeight);
  const maxOffset = Math.max(0, lines.length - safeViewport);
  const clampedOffset = Math.min(Math.max(0, scrollOffset), maxOffset);
  const start = Math.max(0, lines.length - safeViewport - clampedOffset);
  const visible = lines.slice(start, start + safeViewport);
  return { visible, maxOffset, clampedOffset };
}

function buildScrollbar(viewportHeight: number, totalLines: number, scrollOffset: number): string[] {
  const safeViewport = Math.max(1, viewportHeight);
  const bar = Array.from({ length: safeViewport }, () => "|");
  if (totalLines <= safeViewport) return bar;

  const maxOffset = Math.max(1, totalLines - safeViewport);
  const thumbSize = Math.max(1, Math.floor((safeViewport * safeViewport) / totalLines));
  const thumbTravel = Math.max(0, safeViewport - thumbSize);
  const thumbTop = Math.round((Math.min(Math.max(0, scrollOffset), maxOffset) / maxOffset) * thumbTravel);

  for (let i = 0; i < thumbSize; i += 1) {
    const index = thumbTop + i;
    if (index >= 0 && index < bar.length) bar[index] = "#";
  }

  return bar;
}

function dynamicImport<T>(specifier: string): Promise<T> {
  const importer = new Function("s", "return import(s)") as (s: string) => Promise<T>;
  return importer(specifier);
}

function formatLogEntry(entry: LogEntry): string {
  const timestamp = new Date(entry.timestamp).toLocaleTimeString();
  const message = entry.message?.trim() || "(log)";
  return `[${timestamp}] ${message}`;
}

export async function runInkTui(agentExecutor: TuiAgentExecutor): Promise<void> {
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    throw new Error("TUI mode requires an interactive TTY terminal.");
  }

  const reactNs = await dynamicImport<any>("react");
  const inkNs = await dynamicImport<any>("ink");

  const React = reactNs.default ?? reactNs;
  const {
    render,
    Box,
    Text,
    useInput,
    useApp,
  } = inkNs;

  const { useEffect, useState } = React as {
    useEffect: (effect: () => (() => void) | void, deps?: unknown[]) => void;
    useState: <T>(initial: T) => [T, (value: T | ((prev: T) => T)) => void];
  };

  const App = () => {
    const { exit } = useApp();
    const rows = Math.max(MIN_TERMINAL_ROWS, process.stdout.rows ?? 40);
    const cols = Math.max(MIN_TERMINAL_COLS, process.stdout.columns ?? 120);

    const [input, setInput] = useState("");
    const [isBusy, setIsBusy] = useState(false);
    const [showStats, setShowStats] = useState(true);
    const [outputScrollOffset, setOutputScrollOffset] = useState(0);
    const [logScrollOffset, setLogScrollOffset] = useState(0);
    const [outputLines, setOutputLines] = useState<string[]>([
      "AgentLoop TUI ready. Enter sends prompt. Arrows scroll logs. Ctrl+Arrows scroll output. Ctrl+S toggles stats. Ctrl+C exits.",
    ]);
    const [logLines, setLogLines] = useState<string[]>([]);
    const [stats, setStats] = useState<StatsState>({
      requests: 0,
      successes: 0,
      failures: 0,
      totalOutputChars: 0,
      lastDurationMs: 0,
    });

    useEffect(() => {
      const unsubscribe = addLogListener((entry) => {
        setLogLines((prev) => appendLine(prev, formatLogEntry(entry), LOG_HISTORY_LIMIT));
      });
      return unsubscribe;
    }, []);

    const submitPrompt = async (prompt: string) => {
      const trimmed = prompt.trim();
      if (!trimmed || isBusy) return;

      setIsBusy(true);
      setStats((prev) => ({ ...prev, requests: prev.requests + 1 }));
      setOutputLines((prev) => appendLine(appendLine(prev, `User> ${trimmed}`, OUTPUT_HISTORY_LIMIT), "Agent> ", OUTPUT_HISTORY_LIMIT));

      const startedAt = Date.now();
      let outputChars = 0;
      try {
        if (appConfig.streamingEnabled) {
          for await (const chunk of agentExecutor.stream(trimmed)) {
            outputChars += chunk.length;
            setOutputLines((prev) => appendToLastLine(prev, chunk));
          }
        } else {
          const result = await agentExecutor.invoke(trimmed);
          outputChars = result.output.length;
          setOutputLines((prev) => appendToLastLine(prev, result.output));
        }

        setStats((prev) => ({
          ...prev,
          successes: prev.successes + 1,
          totalOutputChars: prev.totalOutputChars + outputChars,
          lastDurationMs: Date.now() - startedAt,
        }));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setOutputLines((prev) => appendLine(prev, `Error> ${message}`, OUTPUT_HISTORY_LIMIT));
        setStats((prev) => ({
          ...prev,
          failures: prev.failures + 1,
          lastDurationMs: Date.now() - startedAt,
        }));
      } finally {
        setIsBusy(false);
      }
    };

    useInput((value: string, key: any) => {
      if (key?.ctrl && value === "c") {
        exit();
        return;
      }
      if (key?.ctrl && value.toLowerCase() === "s") {
        setShowStats((prev) => !prev);
        return;
      }
      if (key?.ctrl && key?.upArrow) {
        setOutputScrollOffset((prev) => prev + 1);
        return;
      }
      if (key?.ctrl && key?.downArrow) {
        setOutputScrollOffset((prev) => Math.max(0, prev - 1));
        return;
      }
      if (key?.ctrl && key?.pageUp) {
        setOutputScrollOffset((prev) => prev + 5);
        return;
      }
      if (key?.ctrl && key?.pageDown) {
        setOutputScrollOffset((prev) => Math.max(0, prev - 5));
        return;
      }
      if (key?.ctrl && key?.home) {
        setOutputScrollOffset(999999);
        return;
      }
      if (key?.ctrl && key?.end) {
        setOutputScrollOffset(0);
        return;
      }
      if (key?.upArrow) {
        setLogScrollOffset((prev) => prev + 1);
        return;
      }
      if (key?.downArrow) {
        setLogScrollOffset((prev) => Math.max(0, prev - 1));
        return;
      }
      if (key?.pageUp) {
        setLogScrollOffset((prev) => prev + 5);
        return;
      }
      if (key?.pageDown) {
        setLogScrollOffset((prev) => Math.max(0, prev - 5));
        return;
      }
      if (key?.home) {
        setLogScrollOffset(999999);
        return;
      }
      if (key?.end) {
        setLogScrollOffset(0);
        return;
      }
      if (key?.return) {
        const toSend = input;
        setInput("");
        void submitPrompt(toSend);
        return;
      }
      if (key?.backspace || key?.delete) {
        setInput((prev) => prev.slice(0, -1));
        return;
      }
      if (!key?.ctrl && !key?.meta && !key?.escape && value) {
        setInput((prev) => prev + value);
      }
    });

    const headerHeight = 4;
    const middleHeight = showStats ? 8 : 6;
    const inputHeight = 4;
    const outputHeight = Math.max(4, rows - headerHeight - middleHeight - inputHeight);

    const outputViewportHeight = Math.max(1, outputHeight - 3);
    const logViewportHeight = Math.max(1, middleHeight - 3);
    const statsViewportHeight = Math.max(1, middleHeight - 3);

    const statsPaneWidth = showStats ? Math.max(24, Math.floor(cols * 0.3)) : 0;
    const logPaneWidth = showStats ? Math.max(24, cols - statsPaneWidth) : cols;
    const outputContentWidth = Math.max(8, cols - 4);
    const logContentWidth = Math.max(8, (showStats ? logPaneWidth : cols) - 6);
    const statsContentWidth = Math.max(8, statsPaneWidth - 4);

    const outputPrepared = fitLinesToWidth(flattenLines(outputLines), outputContentWidth - 2);
    const outputWindow = getWindowedLines(outputPrepared, outputViewportHeight, outputScrollOffset);
    const outputScrollbar = buildScrollbar(outputViewportHeight, outputPrepared.length, outputWindow.clampedOffset);
    const paddedOutputLines = [...outputWindow.visible, ...Array.from({ length: Math.max(0, outputViewportHeight - outputWindow.visible.length) }, () => "")];

    const logPrepared = fitLinesToWidth(logLines.length > 0 ? logLines : ["(no logs yet)"], logContentWidth);
    const logWindow = getWindowedLines(logPrepared, logViewportHeight, logScrollOffset);
    const logScrollbar = buildScrollbar(logViewportHeight, logPrepared.length, logWindow.clampedOffset);
    const paddedLogLines = [...logWindow.visible, ...Array.from({ length: Math.max(0, logViewportHeight - logWindow.visible.length) }, () => "")];

    useEffect(() => {
      setOutputScrollOffset((prev) => Math.min(prev, outputWindow.maxOffset));
    }, [outputWindow.maxOffset]);

    useEffect(() => {
      setLogScrollOffset((prev) => Math.min(prev, logWindow.maxOffset));
    }, [logWindow.maxOffset]);

    const statusLabel = isBusy ? "busy" : "idle";
    const statsLines = fitLinesToWidth([
      `Status: ${statusLabel}`,
      `Requests: ${stats.requests}`,
      `Successes: ${stats.successes}`,
      `Failures: ${stats.failures}`,
      `Last duration: ${stats.lastDurationMs} ms`,
      `Output chars: ${stats.totalOutputChars}`,
      `Output scroll: ${outputWindow.clampedOffset}/${outputWindow.maxOffset}`,
      `Log lines: ${logLines.length}`,
      `Log scroll: ${logWindow.clampedOffset}/${logWindow.maxOffset}`,
      `Terminal rows: ${rows}`,
      `Terminal cols: ${cols}`,
    ], statsContentWidth);
    const statsVisible = statsLines.slice(0, statsViewportHeight);
    const statsPadded = [...statsVisible, ...Array.from({ length: Math.max(0, statsViewportHeight - statsVisible.length) }, () => "")];

    return React.createElement(
      Box,
      { flexDirection: "column", height: rows },
      React.createElement(
        Box,
        { borderStyle: "round", flexDirection: "column", height: headerHeight },
        React.createElement(Text, { bold: true }, "AgentLoop TUI"),
        React.createElement(Text, { dimColor: true }, "Ctrl+S stats | Up/Down logs | Ctrl+Up/Down output | Enter send | Ctrl+C exit")
      ),
      React.createElement(
        Box,
        { borderStyle: "round", flexDirection: "column", height: outputHeight },
        React.createElement(Text, { bold: true }, "Agent Output"),
        ...paddedOutputLines.map((line, index) =>
          React.createElement(
            Box,
            { key: `out-row-${index}`, flexDirection: "row" },
            React.createElement(Text, null, truncateToWidth(line, outputContentWidth - 2)),
            React.createElement(Text, { dimColor: true }, outputScrollbar[index] ?? " ")
          )
        )
      ),
      React.createElement(
        Box,
        { flexDirection: "row", height: middleHeight },
        React.createElement(
          Box,
          {
            borderStyle: "round",
            flexDirection: "column",
            width: showStats ? logPaneWidth : cols,
          },
          React.createElement(Text, { bold: true }, "Logs"),
          ...paddedLogLines.map((line, index) =>
            React.createElement(
              Box,
              { key: `log-row-${index}`, flexDirection: "row" },
              React.createElement(Text, null, truncateToWidth(line, logContentWidth)),
              React.createElement(Text, { dimColor: true }, logScrollbar[index] ?? " ")
            )
          )
        ),
        showStats
          ? React.createElement(
              Box,
              { borderStyle: "round", flexDirection: "column", width: statsPaneWidth },
              React.createElement(Text, { bold: true }, "Statistics"),
              ...statsPadded.map((line, index) => React.createElement(Text, { key: `stat-${index}` }, line))
            )
          : null
      ),
      React.createElement(
        Box,
        { borderStyle: "round", flexDirection: "column", height: inputHeight },
        React.createElement(Text, { bold: true }, "Input"),
        React.createElement(Text, null, truncateToWidth(`> ${input}${isBusy ? " (processing...)" : ""}`, cols - 4))
      )
    );
  };

  const instance = render(React.createElement(App), {
    exitOnCtrlC: true,
    patchConsole: true,
    alternateScreen: true,
  });

  await instance.waitUntilExit();
}
