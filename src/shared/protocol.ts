/**
 * The webview↔host wire protocol, owned in ONE place: both unions plus the
 * parameter shapes they carry. Renaming a field here breaks compilation on
 * the other side — that is the point. Controller-emitted messages (the
 * MonitorController's own narrow union) live in the host module; the host
 * session-tags them when forwarding, per ADR-0005.
 */
import { Tag } from './tag';

export interface SerialParams {
  baudRate: number;
  dataBits: number;
  stopBits: number;
  parity: string;
}

export interface PortInfoLike {
  path: string;
  description?: string;
}

export type PaneState = 'idle' | 'connecting' | 'connected';

/** Messages the host sends into the webview. */
export type HostToWebview =
  | { type: 'ports'; ports: PortInfoLike[] }
  | { type: 'state'; sessionId: number; state: PaneState; path?: string; message?: string }
  | { type: 'append'; sessionId: number; lines: string[]; timestamps?: number[]; dropCount: number }
  | {
      type: 'sessionCreated';
      sessionId: number;
      kind: 'port' | 'file';
      title: string;
      state: PaneState;
      settings?: SerialParams;
    }
  | { type: 'sessionFailed'; sessionId: number; message: string }
  | { type: 'sessionClosed'; sessionId: number }
  | { type: 'timestamps'; enabled: boolean }
  | {
      type: 'logging';
      sessionId: number;
      active: boolean;
      fileName?: string;
      directory?: string;
      desired: boolean;
    }
  | { type: 'recentBauds'; values: number[] }
  | { type: 'exportRequest'; sessionId: number }
  | { type: 'status'; message: string }
  | { type: 'clear' }
  | { type: 'lineEnding'; sessionId: number; value: string }
  | { type: 'tags'; tags: Tag[] };

/** Messages the webview sends to the host. */
export type WebviewToHost =
  | { type: 'ready' }
  | { type: 'refreshPorts' }
  | { type: 'connect'; port: string; baudRate: number; dataBits: number; stopBits: number; parity: string; lineEnding?: string }
  | { type: 'reconnect'; sessionId: number; settings: SerialParams }
  | { type: 'disconnect'; sessionId: number }
  | { type: 'closeSession'; sessionId: number }
  | { type: 'openLogFile' }
  | { type: 'clear'; sessionId?: number }
  | { type: 'send'; sessionId: number; text: string; lineEnding: string }
  | { type: 'setTimestamps'; enabled: boolean }
  | { type: 'setLogSession'; sessionId: number; enabled: boolean }
  | { type: 'chooseLogDirectory' }
  | { type: 'clearLogDirectory' }
  | { type: 'export'; sessionId: number }
  | { type: 'exportData'; sessionId: number; entries: { text: string; ts?: number }[] }
  | { type: 'createTag'; pattern: string }
  | {
      type: 'updateTag';
      id: string;
      patch: { name?: string; pattern?: string; isRegex?: boolean; color?: string; highlight?: boolean; filter?: boolean };
    }
  | { type: 'removeTag'; id: string }
  | { type: 'clearTags' };
