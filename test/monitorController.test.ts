import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HostToWebview, MonitorController } from '../src/host/monitorController';
import { PortInfo, SerialPortBackend, SerialPortLike, Unsubscribe } from '../src/host/serialPortAdapter';

class FakePort implements SerialPortLike {
  openError: Error | undefined;
  opened = false;
  closeCount = 0;
  private readonly dataListeners: ((chunk: Uint8Array) => void)[] = [];
  private readonly errorListeners: ((err: Error) => void)[] = [];
  private readonly closeListeners: (() => void)[] = [];

  async open(): Promise<void> {
    if (this.openError) {
      throw this.openError;
    }
    this.opened = true;
  }

  async close(): Promise<void> {
    this.closeCount++;
    this.opened = false;
    // Mirror the real port: the 'close' event fires after close() as well.
    this.emitClose();
  }

  onData(listener: (chunk: Uint8Array) => void): Unsubscribe {
    return subscribe(this.dataListeners, listener);
  }

  onError(listener: (err: Error) => void): Unsubscribe {
    return subscribe(this.errorListeners, listener);
  }

  onClose(listener: () => void): Unsubscribe {
    return subscribe(this.closeListeners, listener);
  }

  emitData(chunk: Uint8Array): void {
    emit(this.dataListeners, chunk);
  }

  emitError(err: Error): void {
    emit(this.errorListeners, err);
  }

  emitClose(): void {
    emit(this.closeListeners);
  }
}

class FakeBackend implements SerialPortBackend {
  readonly created: { path: string; baudRate: number; port: FakePort }[] = [];
  constructor(readonly paths: string[] = ['COM3']) {}

  async listPorts(): Promise<PortInfo[]> {
    return this.paths.map((path) => ({ path }));
  }

  createPort(path: string, baudRate: number): SerialPortLike {
    const port = new FakePort();
    this.created.push({ path, baudRate, port });
    return port;
  }
}

function subscribe<T>(listeners: T[], listener: T): Unsubscribe {
  listeners.push(listener);
  return () => {
    const i = listeners.indexOf(listener);
    if (i >= 0) {
      listeners.splice(i, 1);
    }
  };
}

function emit<T extends unknown[]>(listeners: ((...args: T) => void)[], ...args: T): void {
  for (const listener of [...listeners]) {
    listener(...args);
  }
}

describe('MonitorController', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function setup(paths?: string[]) {
    const backend = new FakeBackend(paths);
    const messages: HostToWebview[] = [];
    const controller = new MonitorController(backend, (msg) => messages.push(msg), {
      flushAfterMs: 10,
    });
    return { backend, messages, controller };
  }

  const types = (messages: HostToWebview[]) => messages.map((m) => m.type);

  it('sends the port list on refreshPorts', async () => {
    const { messages, controller } = setup(['COM3', 'COM7']);

    await controller.refreshPorts();

    expect(messages).toEqual([
      { type: 'ports', ports: [{ path: 'COM3' }, { path: 'COM7' }] },
    ]);
  });

  it('reports list failure as a state message instead of crashing', async () => {
    const backend = new FakeBackend();
    backend.listPorts = async () => {
      throw new Error('usb boom');
    };
    const messages: HostToWebview[] = [];
    const controller = new MonitorController(backend, (msg) => messages.push(msg));

    await controller.refreshPorts();

    expect(messages).toEqual([
      { type: 'state', state: 'idle', message: 'Failed to list serial ports: usb boom' },
    ]);
  });

  it('connects: creates the port with the requested path and baud, reporting connecting then connected', async () => {
    const { backend, messages, controller } = setup();

    const connectPromise = controller.connect('COM3', 115200);
    expect(controller.state).toBe('connecting');
    await connectPromise;

    expect(backend.created).toEqual([
      { path: 'COM3', baudRate: 115200, port: backend.created[0].port },
    ]);
    expect(controller.state).toBe('connected');
    expect(messages).toEqual([
      { type: 'state', state: 'connecting' },
      { type: 'state', state: 'connected' },
    ]);
  });

  it('reports open failure as a state message, releases the port, and returns to idle', async () => {
    const backend = new FakeBackend();
    const port = new FakePort();
    port.openError = new Error('access denied');
    backend.createPort = () => port;
    const messages: HostToWebview[] = [];
    const controller = new MonitorController(backend, (msg) => messages.push(msg));

    await controller.connect('COM3', 9600);

    expect(controller.state).toBe('idle');
    expect(port.closeCount).toBe(1);
    expect(messages).toEqual([
      { type: 'state', state: 'connecting' },
      { type: 'state', state: 'idle', message: 'Failed to open COM3: access denied' },
    ]);
  });

  it('streams data through the data seam in batched appends', async () => {
    const { messages, controller } = setup();
    await controller.connect('COM3', 115200);
    const port = (controller as unknown as { port: FakePort }).port;

    port.emitData(Buffer.from('he'));
    port.emitData(Buffer.from('llo\nwo'));
    port.emitData(Buffer.from('rld\n'));
    expect(types(messages)).toEqual(['state', 'state']); // nothing delivered before the batch window

    vi.advanceTimersByTime(10);
    const appends = messages.filter((m) => m.type === 'append');
    expect(appends).toEqual([{ type: 'append', lines: ['hello', 'world'] }]);
  });

  it('rejects a second connect while connected without touching the port', async () => {
    const { backend, messages, controller } = setup();
    await controller.connect('COM3', 115200);
    messages.length = 0;

    await controller.connect('COM9', 9600);

    expect(backend.created).toHaveLength(1);
    expect(controller.state).toBe('connected');
    expect(messages).toEqual([
      { type: 'state', state: 'connected', message: 'Already connected; disconnect first.' },
    ]);
  });

  it('disconnect while idle is a clean no-op', async () => {
    const { messages, controller } = setup();

    await expect(controller.disconnect()).resolves.toBeUndefined();

    expect(controller.state).toBe('idle');
    expect(messages).toEqual([]);
  });

  it('explicit disconnect flushes the pending partial line, releases the port, reports idle', async () => {
    const { backend, messages, controller } = setup();
    await controller.connect('COM3', 115200);
    const port = backend.created[0].port;
    port.emitData(Buffer.from('partial line'));
    messages.length = 0;

    await controller.disconnect();

    expect(controller.state).toBe('idle');
    expect(port.closeCount).toBe(1);
    expect(port.opened).toBe(false);
    expect(messages).toEqual([
      { type: 'append', lines: ['partial line'] },
      { type: 'state', state: 'idle', message: 'Disconnected.' },
    ]);
  });

  it('port error transitions to idle, releases the port, and survives the trailing close event', async () => {
    const { messages, controller } = setup();
    await controller.connect('COM3', 115200);
    const port = (controller as unknown as { port: FakePort }).port;
    messages.length = 0;

    port.emitError(new Error('device unplugged'));
    await Promise.resolve(); // the teardown microtask delivers the state message
    expect(controller.state).toBe('idle');
    expect(port.closeCount).toBe(1); // handle released even on the error path
    expect(messages).toEqual([
      { type: 'state', state: 'idle', message: 'Serial port error: device unplugged' },
    ]);

    port.emitClose(); // the real port emits 'close' right after the error
    expect(controller.state).toBe('idle');
    expect(messages).toHaveLength(1); // no duplicate teardown message
  });

  it('unexpected close transitions to idle, releases the port, and flushes the partial line', async () => {
    const { messages, controller } = setup();
    await controller.connect('COM3', 115200);
    const port = (controller as unknown as { port: FakePort }).port;
    port.emitData(Buffer.from('half a line'));
    messages.length = 0;

    port.emitClose();
    await Promise.resolve(); // the teardown microtask delivers the state message

    expect(controller.state).toBe('idle');
    expect(port.closeCount).toBe(1);
    expect(messages).toEqual([
      { type: 'append', lines: ['half a line'] },
      { type: 'state', state: 'idle', message: 'Serial port closed unexpectedly.' },
    ]);
  });

  it('dispose flushes buffered lines and closes the port without a state message', async () => {
    const { backend, messages, controller } = setup();
    await controller.connect('COM3', 115200);
    const port = backend.created[0].port;
    port.emitData(Buffer.from('tail\nmore coming'));
    messages.length = 0;

    await controller.dispose();

    expect(port.opened).toBe(false);
    expect(messages).toEqual([{ type: 'append', lines: ['tail', 'more coming'] }]);
  });
});
