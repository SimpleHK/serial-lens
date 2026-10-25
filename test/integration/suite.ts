import * as assert from 'assert';
import * as vscode from 'vscode';
import { SerialPort } from 'serialport';

import { HostToWebview, MonitorController } from '../../src/host/monitorController';
import { NodeSerialPortBackend } from '../../src/host/nodeSerialPortBackend';

const EXT_ID = 'simplehk.vscode-serial-monitor-oss';
const COM_A = 'COM10'; // monitor side of the com0com pair
const COM_B = 'COM11'; // device side

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const opened = (port: SerialPort, what: string) =>
  new Promise<void>((resolve, reject) => {
    port.once('error', (err) =>
      reject(new Error(`${what} could not be opened (${err.message}). Is another process (e.g. the smoke:device feeder) holding it?`)),
    );
    port.once('open', () => resolve());
  });

const waitFor = async <T>(probe: () => T | undefined, timeoutMs: number, what: string): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    }
    await sleep(25);
  }
};

// Suites register at module load time: mocha requires this file with the
// tdd UI globals (suite/test) active, so top-level registration is required.
suite('Serial Monitor integration', () => {
    test('extension activates and the command runs', async function () {
      this.timeout(30000);
      const ext = vscode.extensions.getExtension(EXT_ID);
      assert.ok(ext, `extension ${EXT_ID} is not present in the development host`);
      await ext.activate();
      assert.strictEqual(ext.isActive, true);
      await vscode.commands.executeCommand('serialMonitor.open');
    });

    test('monitor view resolves (focus succeeds)', async function () {
      this.timeout(10000);
      // Focusing a view that was never registered throws, so this doubles as
      // a check that the viewsContainer contribution actually landed.
      await vscode.commands.executeCommand('serialMonitor.view.focus');
    });

    suite('virtual port pair (com0com COM10 <-> COM11)', () => {
      let hasPair = false;

      suiteSetup(async function () {
        this.timeout(15000);
        const ports = await new NodeSerialPortBackend().listPorts();
        hasPair = ports.some((p) => p.path === COM_A) && ports.some((p) => p.path === COM_B);
        if (!hasPair) {
          console.warn(`[skip] ${COM_A}/${COM_B} not found — is the com0com pair installed?`);
        }
      });

      test('port listing includes both ends of the pair', async function () {
        if (!hasPair) {
          this.skip();
        }
        const ports = await new NodeSerialPortBackend().listPorts();
        assert.ok(ports.some((p) => p.path === COM_A));
        assert.ok(ports.some((p) => p.path === COM_B));
      });

      test('streams torn chunks through real serialport into assembled batches', async function () {
        if (!hasPair) {
          this.skip();
        }
        this.timeout(20000);

        const messages: HostToWebview[] = [];
        const controller = new MonitorController(
          new NodeSerialPortBackend(),
          (msg) => messages.push(msg),
          { flushAfterMs: 30 },
        );

        try {
          await controller.connect({ path: COM_A, baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none' });
          assert.strictEqual(controller.state, 'connected');

          const feeder = new SerialPort({ path: COM_B, baudRate: 115200 });
          await opened(feeder, COM_B);
          feeder.write(Buffer.from('he'));
          await sleep(5);
          feeder.write(Buffer.from('llo\nwo'));
          feeder.write(Buffer.from('rld\n'));

          const appends = await waitFor(() => {
            const found = messages.filter((m) => m.type === 'append');
            return found.length > 0 ? found : undefined;
          }, 5000, 'append batches');
          const text = appends
            .flatMap((m) => (m.type === 'append' ? m.lines : []))
            .join('\n');
          assert.ok(text.includes('hello'), `expected reassembled "hello" in: ${JSON.stringify(text)}`);
          assert.ok(text.includes('world'), `expected reassembled "world" in: ${JSON.stringify(text)}`);

          feeder.close();
          await controller.disconnect();
          assert.strictEqual(controller.state, 'idle');

          // Disconnect must release the port: opening it directly succeeds.
          const again = new SerialPort({ path: COM_A, baudRate: 115200 });
          await opened(again, COM_A);
          again.close();
          await sleep(50);
        } finally {
          await controller.dispose();
        }
      });

      test('sends text with the chosen line ending out the real port', async function () {
        if (!hasPair) {
          this.skip();
        }
        this.timeout(20000);

        const controller = new MonitorController(new NodeSerialPortBackend(), () => undefined);
        try {
          await controller.connect({ path: COM_A, baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none' });

          const reader = new SerialPort({ path: COM_B, baudRate: 115200 });
          await opened(reader, COM_B);
          let received = '';
          reader.on('data', (chunk: Buffer) => {
            received += chunk.toString('utf-8');
          });

          await controller.sendText('ping', 'CRLF');
          await waitFor(
            () => (received.includes('ping\r\n') ? received : undefined),
            5000,
            'sent text on the wire',
          );

          reader.close();
          await controller.disconnect();
        } finally {
          await controller.dispose();
        }
      });

      test('caps the buffer and reports dropped oldest lines', async function () {
        if (!hasPair) {
          this.skip();
        }
        this.timeout(20000);

        const messages: HostToWebview[] = [];
        const controller = new MonitorController(new NodeSerialPortBackend(), (msg) => messages.push(msg), {
          flushAfterMs: 30,
          maxBufferLines: 5,
        });

        try {
          await controller.connect({ path: COM_A, baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none' });

          const feeder = new SerialPort({ path: COM_B, baudRate: 115200 });
          await opened(feeder, COM_B);
          const batch = Array.from({ length: 20 }, (_, i) => `line-${i}\n`).join('');
          feeder.write(Buffer.from(batch));

          await waitFor(() => {
            const lines = messages
              .filter((m) => m.type === 'append')
              .flatMap((m) => (m.type === 'append' ? m.lines : []));
            return lines.length >= 20 ? lines : undefined;
          }, 5000, 'all 20 lines');
          const drops = messages
            .filter((m) => m.type === 'append')
            .reduce((sum, m) => sum + (m.type === 'append' ? m.dropCount : 0), 0);
          assert.strictEqual(drops, 15, 'expected 20 lines with cap 5 to drop 15');

          feeder.close();
          await controller.disconnect();
        } finally {
          await controller.dispose();
        }
      });

      test('attaches receive timestamps when enabled', async function () {
        if (!hasPair) {
          this.skip();
        }
        this.timeout(20000);

        const messages: HostToWebview[] = [];
        const controller = new MonitorController(new NodeSerialPortBackend(), (msg) => messages.push(msg), {
          flushAfterMs: 30,
          timestamps: true,
        });

        try {
          await controller.connect({ path: COM_A, baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none' });

          const feeder = new SerialPort({ path: COM_B, baudRate: 115200 });
          await opened(feeder, COM_B);
          feeder.write(Buffer.from('ts-line\n'));

          const append = await waitFor(() => {
            const found = messages.find((m) => m.type === 'append' && m.lines.includes('ts-line'));
            return found && found.type === 'append' ? found : undefined;
          }, 5000, 'timestamped append');
          expect(append.timestamps).toHaveLength(1);

          feeder.close();
          await controller.disconnect();
        } finally {
          await controller.dispose();
        }
      });

      test('double connect while connected is rejected without touching the port', async function () {
        if (!hasPair) {
          this.skip();
        }
        this.timeout(20000);

        const messages: HostToWebview[] = [];
        const controller = new MonitorController(new NodeSerialPortBackend(), (msg) => messages.push(msg));

        try {
          await controller.connect({ path: COM_A, baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none' });
          messages.length = 0;

          await controller.connect({ path: COM_B, baudRate: 9600, dataBits: 8, stopBits: 1, parity: 'none' });
          assert.strictEqual(controller.state, 'connected');
          const last = messages.at(-1);
          assert.ok(last && last.type === 'state' && last.message?.includes('Already connected'));

          await controller.disconnect();
        } finally {
          await controller.dispose();
        }
      });
    });
  });

