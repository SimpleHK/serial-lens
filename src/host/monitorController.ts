import { LineAssembler } from './lineAssembler';
import { LineBatcher } from './lineBatcher';
import { PortInfo, SerialPortBackend, SerialPortLike, Unsubscribe } from './serialPortAdapter';

export type ControllerState = 'idle' | 'connecting' | 'connected';

export type HostToWebview =
  | { type: 'ports'; ports: PortInfo[] }
  | { type: 'state'; state: ControllerState; message?: string }
  | { type: 'append'; lines: string[] };

export interface MonitorControllerOptions {
  /** Batching window for appends to the webview, in milliseconds. */
  flushAfterMs?: number;
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
  private batcher: LineBatcher | undefined;
  private readonly unsubs: Unsubscribe[] = [];

  constructor(
    private readonly backend: SerialPortBackend,
    private readonly send: (msg: HostToWebview) => void,
    private readonly options: MonitorControllerOptions = {},
  ) {}

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

  async connect(path: string, baudRate: number): Promise<void> {
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
      const port = this.backend.createPort(path, baudRate);
      this.port = port;
      this.assembler = new LineAssembler();
      this.batcher = new LineBatcher(
        (lines) => this.send({ type: 'append', lines }),
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
      this.send({ type: 'state', state: 'connected' });
    } catch (err) {
      if (this.wasTornDown()) {
        return; // a port error or unexpected close during open already handled the failure
      }
      await this.teardown(`Failed to open ${path}: ${describe(err)}`);
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
      this.batcher.add(this.assembler.flush());
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
    this.batcher.add(this.assembler.push(chunk));
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
