import { FilterMode, Tag } from './tag';

export interface LineDecision {
  /** Filter visibility (#7): include shows only matches, exclude hides them. */
  visible: boolean;
  /** Colors of ALL enabled tags matching the line, in tag order. The row
   * tints with the first; every match stays visible in the line's color bar
   * so overlapping tags never mask each other. */
  highlightColors: string[];
}

/**
 * Matching seam: pure functions over (lines, tags, filter mode) → decisions.
 * Enabled tags only — a disabled tag drives neither highlight nor filter.
 * Every enabled matching tag contributes its color. An invalid regex never
 * matches and never throws.
 */
export function matchLine(line: string, tags: readonly Tag[], mode: FilterMode): LineDecision {
  const highlightColors: string[] = [];
  let matched = false;
  for (const tag of tags) {
    if (!tag.enabled || !lineMatches(line, tag)) {
      continue;
    }
    matched = true;
    highlightColors.push(tag.color);
  }

  const visible = mode === 'include' ? matched : mode === 'exclude' ? !matched : true;
  return { visible, highlightColors };
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
