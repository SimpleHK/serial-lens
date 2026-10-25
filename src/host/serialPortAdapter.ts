/**
 * Serial I/O sits behind this interface so the data path is testable with a
 * test double and no hardware is needed in automated tests.
 */
export interface PortInfo {
  path: string;
  /** Human-friendly description, e.g. "com0com - serial port emulator (COM10)". */
  description?: string;
}

export interface Unsubscribe {
  (): void;
}

export interface SerialPortLike {
  open(): Promise<void>;
  close(): Promise<void>;
  onData(listener: (chunk: Uint8Array) => void): Unsubscribe;
  onError(listener: (err: Error) => void): Unsubscribe;
  /** Fires when the port closes for any reason, including unplug. */
  onClose(listener: () => void): Unsubscribe;
}

export interface SerialPortBackend {
  listPorts(): Promise<PortInfo[]>;
  createPort(path: string, baudRate: number): SerialPortLike;
}
