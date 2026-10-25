import { SerialPort } from 'serialport';

import { PortInfo, SerialPortBackend, SerialPortLike, Unsubscribe } from './serialPortAdapter';

/** The real backend: the `serialport` package wrapped in SerialPortLike. */
export class NodeSerialPortBackend implements SerialPortBackend {
  async listPorts(): Promise<PortInfo[]> {
    const ports = await SerialPort.list();
    return ports.map((p) => ({
      path: p.path,
      // Windows populates friendlyName at runtime but the typings omit it.
      description: (p as { friendlyName?: string }).friendlyName,
    }));
  }

  createPort(path: string, baudRate: number): SerialPortLike {
    return new NodeSerialPort(new SerialPort({ path, baudRate, autoOpen: false }));
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
