export interface LineBatcherOptions {
  /** How long to wait before delivering a small batch, in milliseconds. */
  flushAfterMs?: number;
  /** Deliver immediately once this many lines are buffered. */
  maxLines?: number;
}

/**
 * Collects assembled lines and delivers them to the webview in batches —
 * one message carrying many lines instead of one message per line, so a
 * fast stream does not flood the extension-host/webview boundary.
 */
export class LineBatcher {
  private buffer: string[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly sink: (lines: string[]) => void,
    private readonly options: LineBatcherOptions = {},
  ) {}

  add(lines: readonly string[]): void {
    if (lines.length === 0) {
      return;
    }
    this.buffer.push(...lines);
    if (this.buffer.length >= this.maxLines) {
      this.flushNow();
      return;
    }
    if (this.timer === undefined) {
      this.timer = setTimeout(() => this.flushNow(), this.flushAfterMs);
    }
  }

  flushNow(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.buffer.length === 0) {
      return;
    }
    const lines = this.buffer;
    this.buffer = [];
    this.sink(lines);
  }

  /** Delivers whatever is still buffered before teardown. */
  dispose(): void {
    this.flushNow();
  }

  private get maxLines(): number {
    return this.options.maxLines ?? 256;
  }

  private get flushAfterMs(): number {
    return this.options.flushAfterMs ?? 16;
  }
}
