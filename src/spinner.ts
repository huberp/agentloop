/** Braille spinner frames — widely supported in modern terminals. */
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const INTERVAL_MS = 80;

/**
 * Lightweight TTY spinner that writes to stderr.
 *
 * Writing to stderr keeps the spinner separate from the agent's conversational
 * output on stdout, so piping stdout stays clean.
 *
 * When stderr is not a TTY (CI, pipe, redirect) the spinner is entirely silent —
 * no escape codes or spinner characters are emitted.
 */
export class Spinner {
  private frameIndex = 0;
  private interval: NodeJS.Timeout | null = null;
  private currentMessage = "";

  /** Start spinning with an initial message. No-op when stderr is not a TTY. */
  start(message: string): void {
    if (!process.stderr.isTTY) return;
    this.currentMessage = message;
    this.frameIndex = 0;
    this.render();
    this.interval = setInterval(() => this.render(), INTERVAL_MS);
  }

  /**
   * Replace the spinner message while it is still running.
   * Useful for reflecting coarse-grained progress without stopping the spinner.
   */
  update(message: string): void {
    this.currentMessage = message;
  }

  /**
   * Write a line of output while the spinner may be running.
   * Clears the spinner line first (prevents the spinner frame from overwriting
   * the message via a subsequent \r render), then writes the message followed
   * by a newline so the next spinner render lands on a fresh blank line.
   *
   * Use this instead of process.stdout/stderr.write() for any status or
   * progress text that must not interleave with the spinner.
   */
  writeLine(message: string): void {
    if (process.stderr.isTTY) {
      // \r\x1b[K clears the current line (removes any partial spinner frame),
      // then the message + \n leaves the cursor on a new blank line.
      process.stderr.write(`\r\x1b[K${message}\n`);
    } else {
      process.stderr.write(`${message}\n`);
    }
  }

  /**
   * Stop the spinner and erase its line from the terminal.
   * Always call this before writing the next line to stdout so the agent
   * response starts cleanly on a fresh line.
   */
  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    if (process.stderr.isTTY) {
      // \r moves to column 0; \x1b[K erases from cursor to end of line.
      process.stderr.write("\r\x1b[K");
    }
  }

  private render(): void {
    const frame = FRAMES[this.frameIndex % FRAMES.length];
    this.frameIndex++;
    process.stderr.write(`\r${frame} ${this.currentMessage}`);
  }
}

/** Module-level singleton shared by the CLI and tools that emit progress output. */
export const spinner = new Spinner();
