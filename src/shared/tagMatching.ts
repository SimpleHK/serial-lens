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
 * Highlight and filter are independent per tag: only tags with highlight
 * contribute colors, only tags with filter drive include/exclude. An
 * invalid regex never matches and never throws.
 */
export function matchLine(line: string, tags: readonly Tag[], mode: FilterMode): LineDecision {
  const highlightColors: string[] = [];
  let filterMatched = false;
  for (const tag of tags) {
    if (!lineMatches(line, tag)) {
      continue;
    }
    if (tag.highlight) {
      highlightColors.push(tag.color);
    }
    if (tag.filter) {
      filterMatched = true;
    }
  }

  const visible = mode === 'include' ? filterMatched : mode === 'exclude' ? !filterMatched : true;
  return { visible, highlightColors };
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
