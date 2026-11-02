// Unit tests for the extension HOST layer (MonitorViewProvider) through a
// vscode mock — the layer that previously had zero direct coverage. Serial
// I/O is stubbed at the backend seam (prototype spies); dialogs and the
// workspace config are the vscode mock's adjustable surface.
import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { NodeSerialPortBackend } from '../src/host/nodeSerialPortBackend';
import type * as vscodeMockTypes from './vscodeMock';

// One mock instance for the WHOLE module graph (extension.ts included): the
// async factory imports the same mock file, so this suite and the host share
// every mutable surface.
vi.mock('vscode', async () => {
  const m = await import('./vscodeMock');
  return {
    ...m.vscode,
    vscodeMock: m.vscodeMock,
    resetVscodeMock: m.resetVscodeMock,
    setConfig: m.setConfig,
    getConfigUpdates: m.getConfigUpdates,
    fireConfigChange: m.fireConfigChange,
    dialogs: m.dialogs,
  };
});
import * as vscodeNs from 'vscode';
const { vscodeMock, resetVscodeMock, setConfig, getConfigUpdates, fireConfigChange, dialogs } =
  vscodeNs as unknown as typeof vscodeMockTypes;

// The vitest config aliases 'vscode' to ./vscodeMock. The backend prototype
// is spied so every provider-created port is a controllable fake.
type BackendMutable = { createPort: (...a: unknown[]) => unknown; listPorts: (...a: unknown[]) => unknown };
const backendProto = NodeSerialPortBackend.prototype as unknown as BackendMutable;

interface FakePort {
  open: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
  emitData: (text: string) => void;
}

const ports: FakePort[] = [];
/** Set before a connect to make the next port.open fail (set BEFORE firing,
 * because the provider opens the port inside the same tick). */
let openError: Error | undefined;

class FakeBackend {
  async listPorts() {
    return [{ path: 'COM10', description: 'Fake USB' }, { path: 'COM12' }];
  }
  createPort() {
    const dataCbs: ((chunk: Uint8Array) => void)[] = [];
    const port = {
      open: vi.fn(async () => {
        if (openError) {
          throw openError;
        }
      }),
      close: vi.fn(async () => undefined),
      write: vi.fn(async () => undefined),
      onData: (cb: (chunk: Uint8Array) => void) => {
        dataCbs.push(cb);
        return () => void dataCbs.splice(dataCbs.indexOf(cb), 1);
      },
      onError: () => () => undefined,
      onClose: () => () => undefined,
      emitData: (text: string) => {
        for (const cb of [...dataCbs]) cb(new TextEncoder().encode(text));
      },
    };
    ports.push(port as unknown as FakePort);
    return port;
  }
}
vi.spyOn(backendProto, 'createPort').mockImplementation(() => new FakeBackend().createPort());
vi.spyOn(backendProto, 'listPorts').mockImplementation(async () => [
  { path: 'COM10', description: 'Fake USB' },
  { path: 'COM12' },
]);

// -- fake webview view ---------------------------------------------------------

const posted: unknown[] = [];
let receiveHandler: (msg: unknown) => void = () => undefined;

function makeView() {
  return {
    webview: {
      options: undefined as unknown,
      html: '',
      cspSource: 'test',
      asWebviewUri: (u: unknown) => u,
      postMessage: async (msg: unknown) => {
        posted.push(msg);
        return true;
      },
      onDidReceiveMessage: (cb: (msg: unknown) => void) => {
        receiveHandler = cb;
        return { dispose: () => undefined };
      },
    },
    title: '',
    onDidDispose: () => ({ dispose: () => undefined }),
  };
}

const fire = (msg: unknown) => receiveHandler(msg);
const findLastMsg = (type: string, extra?: Record<string, unknown>) => {
  const all = posted.filter(
    (m) =>
      (m as { type: string }).type === type &&
      (!extra || Object.entries(extra).every(([k, v]) => (m as Record<string, unknown>)[k] === v)),
  );
  return all.at(-1);
};
const findMsg = (type: string, extra?: Record<string, unknown>) =>
  posted.find(
    (m) =>
      (m as { type: string }).type === type &&
      (!extra || Object.entries(extra).every(([k, v]) => (m as Record<string, unknown>)[k] === v)),
  );

// -- harness --------------------------------------------------------------------

type ProviderUnderTest = {
  resolveWebviewView(view: unknown): void;
  openLogFile(uri: { fsPath: string }): Promise<void>;
  startMonitoringPort(settings: unknown): Promise<unknown>;
  stopMonitoringPort(portName: string): Promise<boolean>;
  clearMonitorOutput(): void;
};

let provider: ProviderUnderTest;

beforeAll(async () => {
  const mod = await import('../src/extension');
  const Ctor = mod.MonitorViewProvider as unknown as new (uri: unknown) => ProviderUnderTest;
  provider = new Ctor(vscodeMock.Uri.file('repo'));
  provider.resolveWebviewView(makeView());
  fire({ type: 'ready' });
});
afterAll(async () => {
  for (const id of posted
    .filter((m) => (m as { type: string }).type === 'sessionCreated')
    .map((m) => (m as { sessionId: number }).sessionId)) {
    fire({ type: 'closeSession', sessionId: id });
  }
  await new Promise((r) => setTimeout(r, 50));
});
beforeEach(() => {
  posted.length = 0;
  resetVscodeMock();
});

const tick = () => new Promise((r) => setTimeout(r, 30));

/** Log batches flush on a 16ms timer that races with CI runners; poll for
 * the content instead of sleeping a fixed amount. */
async function waitForFileContent(file: string, substr: string, timeoutMs = 3000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const content = await fs.readFile(file, 'utf-8');
      if (content.includes(substr)) {
        return content;
      }
    } catch {
      // file not created yet — keep polling until the deadline
    }
    if (Date.now() > deadline) {
      throw new Error(`waitForFileContent timed out for ${file} (looking for ${JSON.stringify(substr)})`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('MonitorViewProvider (host layer, vscode-mocked)', () => {
  it('lists ports on ready and connects a session end to end', async () => {
    fire({ type: 'connect', port: 'COM10', baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none' });
    await tick();
    const created = findMsg('sessionCreated', { sessionId: 1 }) as { settings: { baudRate: number } };
    expect(created).toBeTruthy();
    expect(created.settings.baudRate).toBe(115200);
    expect(findMsg('state', { sessionId: 1, state: 'connected', path: 'COM10' })).toBeTruthy();
    expect(findMsg('logging', { sessionId: 1, desired: false })).toBeTruthy();
    expect(ports.at(-1)?.open).toHaveBeenCalled();
  });

  it('reports a failed open as sessionFailed and destroys the session', async () => {
    openError = new Error('Access denied');
    const before = ports.length;
    fire({ type: 'connect', port: 'COM404', baudRate: 9600, dataBits: 8, stopBits: 1, parity: 'none' });
    await tick();
    openError = undefined;
    expect(findMsg('sessionFailed', { message: 'Could not open COM404' })).toBeTruthy();
    expect(ports.length).toBe(before + 1);
    expect(ports.at(-1)?.close).toHaveBeenCalled();
  });

  it('appends received lines with timestamps to the right session', async () => {
    setConfig('serialMonitor.timestamps', true);
    fire({ type: 'connect', port: 'COM10', baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none' });
    await tick();
    posted.length = 0;
    ports.at(-1)!.emitData('hello\n');
    // the batcher flushes on a 16ms timer — poll instead of sleeping a
    // fixed amount (CI runners are slower than a dev machine)
    const deadline = Date.now() + 3000;
    let append: { lines: string[]; timestamps?: number[] } | undefined;
    for (;;) {
      append = posted.find(
        (m) => (m as { type: string; sessionId?: number }).type === 'append',
      ) as { lines: string[]; timestamps?: number[] } | undefined;
      if (append || Date.now() > deadline) {
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(append?.lines).toEqual(['hello']);
    expect(append?.timestamps?.length).toBe(1);
  });

  it('live-reconnects in place and keeps the log file across the idle hop', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sm-log-'));
    const logPath = path.join(dir, 'session.log');
    setConfig('serialMonitor.logDirectory', dir);
    fire({ type: 'connect', port: 'COM10', baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none' });
    await tick();
    const sid = (findMsg('sessionCreated') as { sessionId: number }).sessionId;
    dialogs.save.mockReturnValue({ fsPath: logPath });
    fire({ type: 'setLogSession', sessionId: sid, enabled: true });
    await tick();
    const logFileBefore = (findLastMsg('logging', { desired: true }) as { fileName?: string })?.fileName;
    expect(logFileBefore).toBeTruthy();

    posted.length = 0;
    fire({ type: 'reconnect', sessionId: sid, settings: { baudRate: 9600, dataBits: 8, stopBits: 1, parity: 'none' } });
    await tick();
    // no save dialog despite the reconnect hop; the same file stays armed
    expect(dialogs.save).not.toHaveBeenCalled();
    const logFileAfter = (findLastMsg('logging', { desired: true }) as { fileName?: string })?.fileName;
    expect(logFileAfter).toBe(logFileBefore);
    // the new connection actually runs and logs into the same file
    ports.at(-1)!.emitData('after reconnect\n');
    const content = await waitForFileContent(path.join(dir, logFileAfter!), 'after reconnect');
    expect(content).toContain('after reconnect');
    setConfig('serialMonitor.logDirectory', '');
    dialogs.save.mockReset();
  });

  it('exports a session buffer through the save dialog', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sm-exp-'));
    const target = path.join(dir, 'export.log');
    dialogs.save.mockReturnValueOnce({ fsPath: target });
    fire({ type: 'export', sessionId: 2 });
    fire({ type: 'exportData', sessionId: 2, entries: [{ text: 'line one' }, { text: 'line two', ts: Date.now() }] });
    await tick();
    expect(dialogs.save).toHaveBeenCalled();
    const content = await fs.readFile(target, 'utf-8');
    expect(content).toContain('line one');
    expect(content).toContain('line two');
  });

  it('opens a saved log file as a read-only session capped to the newest lines', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sm-open-'));
    const file = path.join(dir, 'old.log');
    await fs.writeFile(file, Array.from({ length: 10010 }, (_, i) => `L${i}`).join('\n') + '\n', 'utf-8');
    dialogs.open.mockReturnValueOnce([{ fsPath: file }]);
    fire({ type: 'openLogFile' });
    await tick();
    const created = findMsg('sessionCreated', { kind: 'file' }) as { sessionId: number; title: string };
    expect(created.title).toBe('old.log');
    const appends = posted.filter(
      (m) =>
        (m as { type: string; sessionId?: number }).type === 'append' &&
        (m as { sessionId?: number }).sessionId === created.sessionId,
    );
    const lines = appends.flatMap((m) => (m as { lines: string[] }).lines);
    expect(lines.length).toBe(10000);
    expect(lines[0]).toBe('L10'); // oldest lines dropped beyond the cap
  });

  it('pushes the API lineEnding to the started session only', async () => {
    const port = await provider.startMonitoringPort({
      port: 'COM12',
      baudRate: 115200,
      lineEnding: '\r\n' as never, // LineEnding.CRLF — its value is the raw bytes
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
    } as never);
    await tick();
    const created = findMsg('sessionCreated', { title: 'COM12' }) as { sessionId: number };
    expect(created).toBeTruthy();
    const le = findLastMsg('lineEnding') as { sessionId: number; value: string } | undefined;
    expect(le).toBeTruthy();
    expect(le?.sessionId).toBe(created.sessionId);
    expect(le?.value).toBe('CRLF');
    expect(await provider.stopMonitoringPort('COM12')).toBe(true);
    await tick();
  });

  it('clearMonitorOutput targets the active pane through the API surface', async () => {
    posted.length = 0;
    provider.clearMonitorOutput();
    await tick();
    expect(posted).toContainEqual(expect.objectContaining({ type: 'clear' }));
  });

  it('honors the start-bar lineEnding on connect', async () => {
    fire({ type: 'connect', port: 'COM10', baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none', lineEnding: 'CRLF' });
    await tick();
    const created = findMsg('sessionCreated', { title: 'COM10' }) as { sessionId: number };
    expect(created).toBeTruthy();
    const le = findLastMsg('lineEnding') as { sessionId: number; value: string } | undefined;
    expect(le?.sessionId).toBe(created.sessionId);
    expect(le?.value).toBe('CRLF');
  });

  it('sends with line ending None append no bytes (UI form normalized)', async () => {
    fire({ type: 'connect', port: 'COM10', baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none' });
    await tick();
    const sid = (findLastMsg('sessionCreated') as { sessionId: number }).sessionId;
    ports.at(-1)!.write.mockClear();
    fire({ type: 'send', sessionId: sid, text: 'hi', lineEnding: 'None' });
    await tick();
    expect(ports.at(-1)!.write).toHaveBeenCalledWith('hi');
  });

  it('persists serialMonitor settings through the config watcher', async () => {
    fire({ type: 'setTimestamps', enabled: true });
    await tick();
    expect(getConfigUpdates()).toContainEqual({ key: 'timestamps', value: true });
    fireConfigChange('serialMonitor.timestamps');
    expect(findMsg('timestamps', { enabled: true })).toBeTruthy();
  });
});
