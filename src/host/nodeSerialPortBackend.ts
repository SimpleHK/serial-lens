import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { SerialPort } from 'serialport';

import { PortInfo, SerialPortBackend, SerialPortLike, Unsubscribe } from './serialPortAdapter';

const execFileAsync = promisify(execFile);

/** The real backend: the `serialport` package wrapped in SerialPortLike. */
export class NodeSerialPortBackend implements SerialPortBackend {
  async listPorts(): Promise<PortInfo[]> {
    // serialport's PnP enumeration misses software ports such as com0com
    // pairs, so merge in the registry's SERIALLCOMM map as a fallback.
    const [listed, fromRegistry] = await Promise.all([
      SerialPort.list().catch(() => []),
      listRegistryPorts(),
    ]);

    const merged = new Map<string, PortInfo>();
    for (const p of listed) {
      // Windows populates friendlyName at runtime but the typings omit it.
      merged.set(p.path, { path: p.path, description: (p as { friendlyName?: string }).friendlyName });
    }
    for (const path of fromRegistry) {
      if (!merged.has(path)) {
        merged.set(path, { path });
      }
    }
    return [...merged.values()].sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
  }

  createPort(path: string, baudRate: number): SerialPortLike {
    return new NodeSerialPort(new SerialPort({ path, baudRate, autoOpen: false }));
  }
}

/** Reads HKLM\HARDWARE\DEVICEMAP\SERIALCOMM: lines like "... REG_SZ COM10". */
async function listRegistryPorts(): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync('reg', ['query', 'HKLM\\HARDWARE\\DEVICEMAP\\SERIALCOMM']);
    const paths: string[] = [];
    for (const line of stdout.split(/\r?\n/)) {
      const match = line.match(/REG_SZ\s+(\S+)\s*$/);
      if (match) {
        paths.push(match[1]);
      }
    }
    return paths;
  } catch {
    return []; // reg missing or inaccessible — the PnP list above still applies
  }
}

class NodeSerialPort implements SerialPortLike {
  constructor(private readonly port: SerialPort) {}

  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.port.open((err) => (err ? reject(err) : resolve()));
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      this.port.close(() => resolve());
    });
  }

  onData(listener: (chunk: Uint8Array) => void): Unsubscribe {
    const handler = (chunk: Buffer) => listener(new Uint8Array(chunk));
    this.port.on('data', handler);
    return () => this.port.off('data', handler);
  }

  onError(listener: (err: Error) => void): Unsubscribe {
    this.port.on('error', listener);
    return () => this.port.off('error', listener);
  }

  onClose(listener: () => void): Unsubscribe {
    const handler = () => listener();
    this.port.on('close', handler);
    return () => this.port.off('close', handler);
  }
}
