/**
 * Receive buffer cap bookkeeping (story 26): the host counts buffered lines
 * and reports how many oldest lines fall out of the ring on each push, so
 * the webview can mirror the drop. Line payloads themselves live in the
 * webview; the host only tracks the count.
 */
export class RingCounter {
  private countValue: number;

  constructor(
    private cap: number,
    count = 0,
  ) {
    this.countValue = Math.min(count, cap);
  }

  get size(): number {
    return this.countValue;
  }

  /** Pushes n lines; returns how many oldest lines dropped out. */
  push(n: number): number {
    const buffered = this.countValue + n;
    const dropped = Math.max(0, buffered - this.cap);
    this.countValue = Math.min(buffered, this.cap);
    return dropped;
  }

  /** Applies a new cap; returns how many oldest lines dropped out. */
  setCap(cap: number): number {
    this.cap = cap;
    const dropped = Math.max(0, this.countValue - cap);
    this.countValue -= dropped;
    return dropped;
  }
}
