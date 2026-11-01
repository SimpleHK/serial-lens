/** The single definition of how a line renders in the console, the log file,
 * and exports — they must never disagree about the timestamp decoration. */
import { formatTimestamp } from './timestamp';

export interface TimedLineLike {
  text: string;
  ts?: number;
}

export function formatLineText(entry: TimedLineLike, withTimestamps: boolean): string {
  if (withTimestamps && entry.ts !== undefined) {
    return `[${formatTimestamp(entry.ts)}] ${entry.text}`;
  }
  return entry.text;
}
