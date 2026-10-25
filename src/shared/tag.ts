/**
 * Unified Tag model (ADR-0003): a named row-matching rule — pattern
 * (substring or regex) plus color and enabled state. Highlighting and
 * filtering both consume tags; there are no highlight-only or filter-only
 * rules. Filtered/shared module so the webview and the extension host speak
 * the same shapes.
 */
export interface Tag {
  /** Stable identity: chips, panel edits, toggles, and deletes address tags
   * by id — never by name, which is display-only and may be deduplicated. */
  id: string;
  /** Display name. */
  name: string;
  /** Match text: a literal substring, or a regex source when isRegex. */
  pattern: string;
  isRegex: boolean;
  /** Hex color like '#RRGGBB'; rows get a translucent tint of it. */
  color: string;
  /** Participates in full-line highlighting. */
  highlight: boolean;
  /** Participates in filtering (drives include/exclude with the global mode). */
  filter: boolean;
}

export type FilterMode = 'off' | 'include' | 'exclude';

/**
 * Distinguishable auto-assignment palette (the auto-color half of spec
 * story 15): first unused color wins; past palette size it cycles.
 */
export const TAG_PALETTE: readonly string[] = [
  '#e06c75', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2',
  '#d19a66', '#7aa2f7', '#f78166', '#56d364', '#db61a2', '#ffa657',
];

export function nextFreeColor(existing: readonly Tag[]): string {
  const used = new Set(existing.map((t) => t.color));
  return TAG_PALETTE.find((c) => !used.has(c)) ?? TAG_PALETTE[existing.length % TAG_PALETTE.length];
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/** A persisted entry before normalization: `highlight`/`filter` may be
 * absent on pre-split settings, where legacy `enabled` applies to both. */
export type RawTag = Omit<Tag, 'id' | 'highlight' | 'filter'> & {
  id?: string;
  highlight?: boolean;
  filter?: boolean;
  /** Legacy single switch (pre-split settings). */
  enabled?: boolean;
};

export function isValidTag(value: unknown): value is RawTag {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const t = value as Record<string, unknown>;
  return (
    typeof t.name === 'string' && t.name.length > 0 &&
    typeof t.pattern === 'string' &&
    typeof t.isRegex === 'boolean' &&
    typeof t.color === 'string' && HEX_COLOR.test(t.color)
  );
}

/** Normalizes a raw entry: fills ids and maps the legacy enabled switch. */
export function normalizeTag(t: RawTag): Tag {
  const enabled = t.enabled ?? false;
  return {
    id: t.id ?? '',
    name: t.name,
    pattern: t.pattern,
    isRegex: t.isRegex,
    color: t.color,
    highlight: t.highlight ?? enabled,
    filter: t.filter ?? enabled,
  };
}
