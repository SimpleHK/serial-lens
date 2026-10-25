import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HostToWebview, MonitorController } from '../src/host/monitorController';
import {
  PortInfo,
  SerialPortBackend,
  SerialPortLike,
  SerialPortSettings,
  Unsubscribe,
} from '../src/host/serialPortAdapter';

const S = (path = 'COM3', baudRate = 115200): SerialPortSettings => ({
  path,
  baudRate,
  dataBits: 8,
  stopBits: 1,
  parity: 'none',
});

class FakePort implements SerialPortLike {
  openError: Error | undefined;
  writeError: Error | undefined;
  opened = false;
  closeCount = 0;
  readonly written: string[] = [];
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

  async write(data: string): Promise<void> {
    if (this.writeError) {
      throw this.writeError;
    }
    this.written.push(data);
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
  readonly created: { settings: SerialPortSettings; port: FakePort }[] = [];
  constructor(readonly paths: string[] = ['COM3']) {}

  async listPorts(): Promise<PortInfo[]> {
    return this.paths.map((path) => ({ path }));
  }

  createPort(settings: SerialPortSettings): SerialPortLike {
    const port = new FakePort();
    this.created.push({ settings, port });
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

  function setup(paths?: string[], opts: { maxBufferLines?: number } = {}) {
    const backend = new FakeBackend(paths);
    const messages: HostToWebview[] = [];
    const controller = new MonitorController(backend, (msg) => messages.push(msg), {
      flushAfterMs: 10,
      ...opts,
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

    const connectPromise = controller.connect(S('COM3', 115200));
    expect(controller.state).toBe('connecting');
    await connectPromise;

    expect(backend.created.map((c) => c.settings)).toEqual([S('COM3')]);
    expect(controller.state).toBe('connected');
    expect(messages).toEqual([
      { type: 'state', state: 'connecting' },
      { type: 'state', state: 'connected', path: 'COM3' },
    ]);
  });

  it('reports open failure as a state message, releases the port, and returns to idle', async () => {
    const backend = new FakeBackend();
    const port = new FakePort();
    port.openError = new Error('access denied');
    backend.createPort = () => port;
    const messages: HostToWebview[] = [];
    const controller = new MonitorController(backend, (msg) => messages.push(msg));

    await controller.connect(S('COM3', 9600));

    expect(controller.state).toBe('idle');
    expect(port.closeCount).toBe(1);
    expect(messages).toEqual([
      { type: 'state', state: 'connecting' },
      { type: 'state', state: 'idle', message: 'Failed to open COM3: access denied' },
    ]);
  });

  it('streams data through the data seam in batched appends', async () => {
    const { messages, controller } = setup();
    await controller.connect(S('COM3', 115200));
    const port = (controller as unknown as { port: FakePort }).port;

    port.emitData(Buffer.from('he'));
    port.emitData(Buffer.from('llo\nwo'));
    port.emitData(Buffer.from('rld\n'));
    expect(types(messages)).toEqual(['state', 'state']); // nothing delivered before the batch window

    vi.advanceTimersByTime(10);
    const appends = messages.filter((m) => m.type === 'append');
    expect(appends).toEqual([{ type: 'append', lines: ['hello', 'world'], dropCount: 0 }]);
  });

  it('rejects a second connect while connected without touching the port', async () => {
    const { backend, messages, controller } = setup();
    await controller.connect(S('COM3', 115200));
    messages.length = 0;

    await controller.connect(S('COM9', 9600));

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
    await controller.connect(S('COM3', 115200));
    const port = backend.created[0].port;
    port.emitData(Buffer.from('partial line'));
    messages.length = 0;

    await controller.disconnect();

    expect(controller.state).toBe('idle');
    expect(port.closeCount).toBe(1);
    expect(port.opened).toBe(false);
    expect(messages).toEqual([
      { type: 'append', lines: ['partial line'], dropCount: 0 },
      { type: 'state', state: 'idle', message: 'Disconnected.' },
    ]);
  });

  it('port error transitions to idle, releases the port, and survives the trailing close event', async () => {
    const { messages, controller } = setup();
    await controller.connect(S('COM3', 115200));
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
    await controller.connect(S('COM3', 115200));
    const port = (controller as unknown as { port: FakePort }).port;
    port.emitData(Buffer.from('half a line'));
    messages.length = 0;

    port.emitClose();
    await Promise.resolve(); // the teardown microtask delivers the state message

    expect(controller.state).toBe('idle');
    expect(port.closeCount).toBe(1);
    expect(messages).toEqual([
      { type: 'append', lines: ['half a line'], dropCount: 0 },
      { type: 'state', state: 'idle', message: 'Serial port closed unexpectedly.' },
    ]);
  });

  it('dispose flushes buffered lines and closes the port without a state message', async () => {
    const { backend, messages, controller } = setup();
    await controller.connect(S('COM3', 115200));
    const port = backend.created[0].port;
    port.emitData(Buffer.from('tail\nmore coming'));
    messages.length = 0;

    await controller.dispose();

    expect(port.opened).toBe(false);
    expect(messages).toEqual([{ type: 'append', lines: ['tail', 'more coming'], dropCount: 0 }]);
  });

  it('send while idle reports Not connected without crashing', async () => {
    const { messages, controller } = setup();

    await controller.sendText('hello', 'CRLF');

    expect(messages).toEqual([{ type: 'state', state: 'idle', message: 'Not connected.' }]);
  });

  it('send appends the chosen line ending to the written data', async () => {
    const { backend, controller } = setup();
    await controller.connect(S('COM3', 115200));
    const port = backend.created[0].port;

    await controller.sendText('ping', 'CRLF');
    await controller.sendText('reset', 'CR');
    await controller.sendText('bare', 'none');
    await controller.sendText('n', 'LF');

    expect(port.written).toEqual(['ping\r\n', 'reset\r', 'bare', 'n\n']);
  });

  it('send failure surfaces as a state message and keeps the connection', async () => {
    const { backend, messages, controller } = setup();
    await controller.connect(S('COM3', 115200));
    const port = backend.created[0].port;
    port.writeError = new Error('driver exploded');
    messages.length = 0;

    await controller.sendText('x', 'LF');

    expect(controller.state).toBe('connected');
    expect(messages).toEqual([
      { type: 'state', state: 'connected', message: 'Send failed: driver exploded' },
    ]);
  });

  it('reports drops when the buffer cap is exceeded', async () => {
    const { backend, messages, controller } = setup(['COM3'], { maxBufferLines: 3 });
    await controller.connect(S('COM3'));
    const port = backend.created[0].port;
    messages.length = 0;

    port.emitData(Buffer.from('a\nb\nc\nd\ne\n')); // 5 lines, cap 3 → oldest 2 drop
    vi.advanceTimersByTime(10);

    expect(messages).toEqual([
      { type: 'append', lines: ['a', 'b', 'c', 'd', 'e'], dropCount: 2 },
    ]);
  });

  it('setCap shrink drops the difference immediately', async () => {
    const { backend, messages, controller } = setup(['COM3'], { maxBufferLines: 10 });
    await controller.connect(S('COM3'));
    const port = backend.created[0].port;
    port.emitData(Buffer.from('a\nb\nc\n'));
    vi.advanceTimersByTime(10);
    messages.length = 0;

    controller.setCap(1);

    expect(messages).toEqual([{ type: 'append', lines: [], dropCount: 2 }]);
  });

  it('timestamps option attaches receive times to appends', async () => {
    const { backend, messages, controller } = setup(['COM3'], { timestamps: true });
    await controller.connect(S('COM3'));
    const port = backend.created[0].port;
    messages.length = 0;

    port.emitData(Buffer.from('a\nb\n'));
    vi.advanceTimersByTime(10);

    const append = messages.find((m) => m.type === 'append');
    assert(append && append.type === 'append');
    expect(append.lines).toEqual(['a', 'b']); // raw content, no timestamp prefix
    expect(append.timestamps).toHaveLength(2);
  });

  it('timestamps stay off by default and toggle live', async () => {
    const { backend, messages, controller } = setup();
    await controller.connect(S('COM3'));
    const port = backend.created[0].port;
    port.emitData(Buffer.from('a\n'));
    vi.advanceTimersByTime(10);
    const before = messages.find((m) => m.type === 'append');
    assert(before && before.type === 'append');
    expect(before.timestamps).toBeUndefined();

    controller.setTimestamps(true);
    messages.length = 0;
    port.emitData(Buffer.from('b\n'));
    vi.advanceTimersByTime(10);
    const after = messages.find((m) => m.type === 'append');
    assert(after && after.type === 'append');
    expect(after.timestamps).toHaveLength(1);
  });
});
