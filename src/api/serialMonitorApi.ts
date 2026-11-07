// Vendored from microsoft/vscode-serial-monitor `api.ts`
// (© Microsoft Corporation, MIT License; repository archived Aug 2025).
// Adaptations for this fork, kept minimal and marked below:
//   1. getSerialMonitorApi resolves this extension after the original one,
//      so integrations work against either.
//   2. The TCP surface exists in the types but the implementation reports
//      unsupported (ADR-0002: TCP is out of MVP scope).

import * as vscode from 'vscode';

export enum StopBits {
  One = 'one',
  Onepointfive = 'onepointfive',
  Two = 'two',
}

export enum Parity {
  None = 'none',
  Odd = 'odd',
  Even = 'even',
  Mark = 'mark',
  Space = 'space',
}

export enum LineEnding {
  None = 'none',
  LF = '\n',
  CR = '\r',
  CRLF = '\r\n',
}

export type DataBit = 5 | 6 | 7 | 8;

export interface MonitorPortSettings {
  port: string;
  baudRate: number;
  lineEnding: LineEnding;
  dataBits: DataBit;
  stopBits: StopBits;
  parity: Parity;
}

export interface MonitorTCPConnectionSettings {
  host: string;
  port: number;
  swoEnabled: boolean;
}

export interface Port {
  /** Stop monitoring this port. */
  stopMonitoring(): Promise<void>;
  /** Event for when this port, for any reason, was closed. */
  onClosed: vscode.Event<void>;
}

export interface PortInformation {
  /** Name of the port. i.e. `COM3` */
  portName: string;
  friendlyName?: string;
  /** Vendor identifier made of 4 hex characters. */
  vid?: string;
  /** Product identifier made of 4 hex characters. */
  pid?: string;
}

export interface SerialMonitorApi extends vscode.Disposable {
  /** List the available serial ports on the system. */
  listAvailablePorts(): Promise<PortInformation[]>;

  /** Start monitoring a specific port with specific settings. */
  startMonitoringPort(monitorSettings: MonitorPortSettings): Promise<Port>;

  /** Stop monitoring a specific port. */
  stopMonitoringPort(portName: string): Promise<boolean>;

  /** Start monitoring a specific TCP connection (unsupported in this version). */
  startMonitoringTCPConnection(connectionSettings: MonitorTCPConnectionSettings): Promise<Port>;

  /** Stop monitoring a specific connection. */
  stopMonitoringTCPConnection(host: string, port: number): Promise<boolean>;

  /** Clear the output of the serial monitor view. */
  clearOutput(): Promise<void>;
}

/** API version information. */
export enum Version {
  v0 = 0, // 0.x.x
  latest = v0,
}

const EXTENSION_IDS = ['ms-vscode.vscode-serial-monitor', 'simplehk.serial-lens'];

export async function getSerialMonitorApi(
  version: Version,
  extensionContext: vscode.ExtensionContext,
): Promise<SerialMonitorApi | undefined> {
  // Adaptation 1: resolve either the original extension or this one.
  const serialMonitorExtension = EXTENSION_IDS.map((id) => vscode.extensions.getExtension(id)).find(
    (e) => e !== undefined,
  );
  if (!serialMonitorExtension) {
    throw new Error('The Serial Lens extension is not installed.');
  }

  let extensionApi: { getApi(v: Version, c: vscode.ExtensionContext): Promise<SerialMonitorApi | undefined> };
  if (!serialMonitorExtension.isActive) {
    try {
      extensionApi = await serialMonitorExtension.activate();
    } catch {
      // Mirrors the original: swallow activation errors and surface the
      // TypeError from the non-null assertion below.
      extensionApi = undefined as never;
    }
  } else {
    extensionApi = serialMonitorExtension.exports;
  }

  return extensionApi.getApi(version, extensionContext);
}
