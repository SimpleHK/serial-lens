import { FilterMode, Tag } from './tag';

export interface LineDecision {
  /** Filter visibility (#7): include shows only matches, exclude hides them. */
  visible: boolean;
  /** Full-line highlight color from the first enabled matching tag, if any. */
  highlightColor?: string;
}

/**
 * Matching seam: pure functions over (lines, tags, filter mode) → decisions.
 * Enabled tags only — a disabled tag drives neither highlight nor filter.
 * Several enabled tags matching one line: the first in tag order wins.
 * An invalid regex never matches and never throws.
 */
export function matchLine(line: string, tags: readonly Tag[], mode: FilterMode): LineDecision {
  let highlightColor: string | undefined;
  let matched = false;
  for (const tag of tags) {
    if (!tag.enabled || !lineMatches(line, tag)) {
      continue;
    }
    matched = true;
    if (highlightColor === undefined) {
      highlightColor = tag.color;
    }
    break; // first enabled match decides both highlight and filter membership
  }

  const visible = mode === 'include' ? matched : mode === 'exclude' ? !matched : true;
  return { visible, highlightColor };
}

export function matchLines(lines: readonly string[], tags: readonly Tag[], mode: FilterMode): LineDecision[] {
  return lines.map((line) => matchLine(line, tags, mode));
}

function lineMatches(line: string, tag: Tag): boolean {
  if (!tag.isRegex) {
    return line.includes(tag.pattern);
  }
  try {
    return new RegExp(tag.pattern).test(line);
  } catch {
    return false; // invalid pattern: non-matching, surfaced at edit time instead
  }
}
