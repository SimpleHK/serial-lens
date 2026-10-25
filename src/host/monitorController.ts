import { LineAssembler } from './lineAssembler';
import { LineBatcher } from './lineBatcher';
import { RingCounter } from './ringCounter';
import {
  LINE_ENDING_BYTES,
  LineEnding,
  PortInfo,
  SerialPortBackend,
  SerialPortLike,
  SerialPortSettings,
  Unsubscribe,
} from './serialPortAdapter';

export type ControllerState = 'idle' | 'connecting' | 'connected';

export type HostToWebview =
  | { type: 'ports'; ports: PortInfo[] }
  | { type: 'state'; state: ControllerState; path?: string; message?: string }
  | { type: 'append'; lines: string[]; timestamps?: number[]; dropCount: number };

export interface MonitorControllerOptions {
  /** Batching window for appends to the webview, in milliseconds. */
  flushAfterMs?: number;
  /** Receive buffer cap in lines; oldest lines drop out beyond it (story 26). */
  maxBufferLines?: number;
  /** Attach per-line receive timestamps (display decoration, story 24/25). */
  timestamps?: boolean;
}

/** A line as it travels through the batching stage: raw content plus the
 * moment it was assembled. The timestamp is display data and never part of
 * matched content. */
interface TimedLine {
  text: string;
  ts: number;
}

/**
 * Owns the connection state machine (idle → connecting → connected) and wires
 * one open port through the data seam: byte chunks → LineAssembler →
 * LineBatcher → webview. Knows nothing about vscode or the DOM.
 */
export class MonitorController {
  private port: SerialPortLike | undefined;
  private stateValue: ControllerState = 'idle';
  private assembler: LineAssembler | undefined;
  private batcher: LineBatcher<TimedLine> | undefined;
  private ring: RingCounter;
  private timestampsEnabled: boolean;
  private readonly unsubs: Unsubscribe[] = [];

  constructor(
    private readonly backend: SerialPortBackend,
    private readonly send: (msg: HostToWebview) => void,
    private readonly options: MonitorControllerOptions = {},
  ) {
    this.ring = new RingCounter(options.maxBufferLines ?? DEFAULT_MAX_BUFFER_LINES);
    this.timestampsEnabled = options.timestamps ?? false;
  }

  get state(): ControllerState {
    return this.stateValue;
  }

  async refreshPorts(): Promise<void> {
    try {
      const ports = await this.backend.listPorts();
      this.send({ type: 'ports', ports });
    } catch (err) {
      this.send({
        type: 'state',
        state: 'idle',
        message: `Failed to list serial ports: ${describe(err)}`,
      });
    }
  }

  async connect(settings: SerialPortSettings): Promise<void> {
    if (this.stateValue !== 'idle') {
      this.send({
        type: 'state',
        state: this.stateValue,
        message:
          this.stateValue === 'connected'
            ? 'Already connected; disconnect first.'
            : 'Already connecting.',
      });
      return;
    }

    this.stateValue = 'connecting';
    this.send({ type: 'state', state: 'connecting' });

    try {
      const port = this.backend.createPort(settings);
      this.port = port;
      this.assembler = new LineAssembler();
      this.batcher = new LineBatcher<TimedLine>(
        (entries) => {
          const dropCount = this.ring.push(entries.length);
          this.send({
            type: 'append',
            lines: entries.map((e) => e.text),
            timestamps: this.timestampsEnabled ? entries.map((e) => e.ts) : undefined,
            dropCount,
          });
        },
        { flushAfterMs: this.options.flushAfterMs },
      );
      this.unsubs.push(
        port.onData((chunk) => this.onChunk(chunk)),
        port.onError((err) => this.onPortError(err)),
        port.onClose(() => this.onUnexpectedClose()),
      );
      await port.open();
      if (this.port !== port) {
        // An error or unexpected close tore the connection down while opening.
        return;
      }
      this.stateValue = 'connected';
      this.send({ type: 'state', state: 'connected', path: settings.path });
    } catch (err) {
      if (this.wasTornDown()) {
        return; // a port error or unexpected close during open already handled the failure
      }
      await this.teardown(`Failed to open ${settings.path}: ${describe(err)}`);
    }
  }

  /** Applies a new buffer cap live; drops oldest lines beyond it. */
  setCap(maxBufferLines: number): void {
    const dropCount = this.ring.setCap(maxBufferLines);
    if (dropCount > 0) {
      this.send({ type: 'append', lines: [], dropCount });
    }
  }

  /** Toggles per-line receive timestamps for lines assembled from now on. */
  setTimestamps(enabled: boolean): void {
    this.timestampsEnabled = enabled;
  }

  /** Sends a message with the chosen line ending; clean no-op when idle. */
  async sendText(text: string, lineEnding: LineEnding): Promise<void> {
    if (this.stateValue !== 'connected' || !this.port) {
      this.send({ type: 'state', state: this.stateValue, message: 'Not connected.' });
      return;
    }
    try {
      await this.port.write(text + LINE_ENDING_BYTES[lineEnding]);
    } catch (err) {
      this.send({ type: 'state', state: 'connected', message: `Send failed: ${describe(err)}` });
    }
  }

  async disconnect(): Promise<void> {
    if (this.stateValue === 'idle') {
      return; // clean no-op
    }
    await this.teardown('Disconnected.');
  }

  async dispose(): Promise<void> {
    await this.teardown();
  }

  /**
   * Shared exit path from any non-idle state: flush the seam, detach the
   * port, release the OS handle, and report idle. The port is closed here
   * even on error/unplug paths so the handle is never left open unowned.
   */
  private async teardown(message?: string): Promise<void> {
    const port = this.port;
    if (this.assembler && this.batcher) {
      this.batcher.add(this.assembler.flush().map(timed));
      this.batcher.dispose();
    }
    this.detachPort();
    this.stateValue = 'idle';
    if (port) {
      try {
        await port.close();
      } catch {
        // The port may already be gone (unplug, failed open); nothing to do.
      }
    }
    if (message !== undefined) {
      this.send({ type: 'state', state: 'idle', message });
    }
  }

  private onChunk(chunk: Uint8Array): void {
    if (this.stateValue !== 'connected' || !this.assembler || !this.batcher) {
      return;
    }
    const lines = this.assembler.push(chunk);
    if (lines.length === 0) {
      return;
    }
    const ts = Date.now();
    this.batcher.add(lines.map((text) => ({ text, ts })));
  }

  private onPortError(err: Error): void {
    if (this.stateValue === 'idle') {
      return;
    }
    void this.teardown(`Serial port error: ${describe(err)}`);
  }

  private onUnexpectedClose(): void {
    if (this.stateValue === 'idle') {
      return; // our own disconnect already handled teardown
    }
    void this.teardown('Serial port closed unexpectedly.');
  }

  // A method rather than a direct field comparison: the async teardown
  // handlers mutate stateValue across the awaits in connect(), and TypeScript
  // must not narrow it there.
  private wasTornDown(): boolean {
    return this.stateValue === 'idle';
  }

  private detachPort(): void {
    for (const unsub of this.unsubs.splice(0)) {
      unsub();
    }
    this.assembler = undefined;
    this.batcher = undefined;
    this.port = undefined;
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const DEFAULT_MAX_BUFFER_LINES = 10000;

function timed(text: string): TimedLine {
  return { text, ts: Date.now() };
}
