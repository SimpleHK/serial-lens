import { LineAssembler } from './lineAssembler';
import { LineBatcher } from './lineBatcher';
import { PortInfo, SerialPortBackend, SerialPortLike, Unsubscribe } from './serialPortAdapter';

export type HostToWebview =
  | { type: 'ports'; ports: PortInfo[] }
  | { type: 'state'; connected: boolean; connecting: boolean; message?: string }
  | { type: 'append'; lines: string[] };

export type ControllerState = 'idle' | 'connecting' | 'connected';

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
        connected: false,
        connecting: false,
        message: `Failed to list serial ports: ${describe(err)}`,
      });
    }
  }

  async connect(path: string, baudRate: number): Promise<void> {
    if (this.stateValue !== 'idle') {
      this.send({
        type: 'state',
        connected: this.stateValue === 'connected',
        connecting: this.stateValue === 'connecting',
        message:
          this.stateValue === 'connected'
            ? 'Already connected; disconnect first.'
            : 'Already connecting.',
      });
      return;
    }

    this.stateValue = 'connecting';
    this.send({ type: 'state', connected: false, connecting: true });

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
      this.send({ type: 'state', connected: true, connecting: false });
    } catch (err) {
      if (this.wasTornDown()) {
        return; // a port error or unexpected close during open already handled the failure
      }
      this.discardPort();
      this.stateValue = 'idle';
      this.send({
        type: 'state',
        connected: false,
        connecting: false,
        message: `Failed to open ${path}: ${describe(err)}`,
      });
    }
  }

  async disconnect(): Promise<void> {
    if (this.stateValue === 'idle') {
      return; // clean no-op
    }
    const port = this.port;
    const rest = this.assembler ? this.assembler.flush() : [];
    if (this.batcher) {
      this.batcher.add(rest);
      this.batcher.dispose();
    }
    this.discardPort();
    this.stateValue = 'idle';
    if (port) {
      try {
        await port.close();
      } catch {
        // The port may already be gone; the user asked to close it either way.
      }
    }
    this.send({ type: 'state', connected: false, connecting: false, message: 'Disconnected.' });
  }

  async dispose(): Promise<void> {
    const port = this.port;
    if (this.batcher) {
      this.batcher.dispose();
    }
    this.discardPort();
    this.stateValue = 'idle';
    if (port) {
      try {
        await port.close();
      } catch {
        // Best effort during teardown.
      }
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
    this.discardPort();
    this.stateValue = 'idle';
    this.send({
      type: 'state',
      connected: false,
      connecting: false,
      message: `Serial port error: ${describe(err)}`,
    });
  }

  private onUnexpectedClose(): void {
    if (this.stateValue === 'idle') {
      return; // our own disconnect already handled teardown
    }
    this.discardPort();
    this.stateValue = 'idle';
    this.send({
      type: 'state',
      connected: false,
      connecting: false,
      message: 'Serial port closed unexpectedly.',
    });
  }

  // A method rather than a direct field comparison: the async teardown
  // handlers mutate stateValue across the awaits in connect(), and TypeScript
  // must not narrow it there.
  private wasTornDown(): boolean {
    return this.stateValue === 'idle';
  }

  private discardPort(): void {
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
