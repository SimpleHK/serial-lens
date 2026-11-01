export interface LineBatcherOptions {
  /** How long to wait before delivering a small batch, in milliseconds. */
  flushAfterMs?: number;
  /** Deliver immediately once this many items are buffered. */
  maxItems?: number;
}

/**
 * Collects assembled items and delivers them to the webview in batches —
 * one message carrying many items instead of one message per line, so a
 * fast stream does not flood the extension-host/webview boundary. Generic
 * over the item shape (plain lines now, timestamped lines with #10).
 */
export class LineBatcher<T> {
  private buffer: T[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly sink: (items: T[]) => void,
    private readonly options: LineBatcherOptions = {},
  ) {}

  add(items: readonly T[]): void {
    if (items.length === 0) {
      return;
    }
    this.buffer.push(...items);
    if (this.buffer.length >= this.maxItems) {
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
    const items = this.buffer;
    this.buffer = [];
    this.sink(items);
  }

  /** Delivers whatever is still buffered before teardown. */
  dispose(): void {
    this.flushNow();
  }

  private get maxItems(): number {
    return this.options.maxItems ?? 256;
  }

  private get flushAfterMs(): number {
    return this.options.flushAfterMs ?? 16;
  }
}
