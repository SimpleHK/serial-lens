/**
 * Pure core of the per-pane find widget: matcher construction and occurrence
 * scanning over visible lines. DOM rendering (CSS Custom Highlight API) and
 * navigation state live in main.ts; this module owns the invariants that the
 * find regressions depend on — the test surface is exactly these functions.
 */

export interface FindMatcherOptions {
  query: string;
  matchCase: boolean;
  wholeWord: boolean;
  regex: boolean;
}

export interface FindOccurrence {
  lineIndex: number;
  start: number;
  end: number;
}

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Builds the occurrence matcher, or undefined for an invalid regex source
 * (reported as "Bad pattern" by the widget). */
export function buildFindRegex(f: FindMatcherOptions): RegExp | undefined {
  try {
    let source = f.regex ? f.query : escapeRegExp(f.query);
    if (f.wholeWord) {
      source = `\\b(?:${source})\\b`;
    }
    return new RegExp(source, f.matchCase ? 'g' : 'gi');
  } catch {
    return undefined;
  }
}

/** Scans the VISIBLE lines for occurrences, offsets in rendered-text
 * coordinates so ranges land on the row text nodes exactly as displayed.
 * Zero-length matches are skipped so a degenerate pattern cannot loop. */
export function scanOccurrences(
  re: RegExp,
  visibleIndexes: readonly number[],
  textFor: (lineIndex: number) => string,
): FindOccurrence[] {
  const occurrences: FindOccurrence[] = [];
  for (const lineIndex of visibleIndexes) {
    const text = textFor(lineIndex);
    let m: RegExpExecArray | null;
    let guard = 0;
    while ((m = re.exec(text)) !== null && guard++ < 1000) {
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      occurrences.push({ lineIndex, start: m.index, end: m.index + m[0].length });
    }
  }
  return occurrences;
}

/** Wrapping occurrence navigation. */
export function stepIndex(current: number, count: number, dir: 1 | -1): number {
  if (count === 0) {
    return current;
  }
  return (current + dir + count) % count;
}
