/**
 * Toolbar icon set — one consistent 16×16 single-stroke family rendered as
 * inline SVG with `currentColor`, so every glyph follows the VS Code theme
 * and state colors (recording red, focus blue). Replaces emoji glyphs,
 * which Windows renders as full-color emoji and which clash with the
 * monochrome UI (ui-ux-pro-max Priority 4: "SVG icons, no emoji").
 *
 * CSP note: inline SVG needs no external resources, same pattern as the
 * funnel glyph that already ships.
 */

const ATTRS = 'width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';

const wrap = (body: string): string => `<svg ${ATTRS}>${body}</svg>`;

export const icons = {
  plus: wrap('<path d="M8 3v10M3 8h10"/>'),
  refresh: wrap('<path d="M13.5 8a5.5 5.5 0 1 1-1.7-4M13.5 2.5v3h-3"/>'),
  clock: wrap('<circle cx="8" cy="8" r="5.5"/><path d="M8 4.8V8l2 2"/>'),
  folder: wrap('<path d="M2.5 12.5v-8h4l1.5 1.8h5.5v6.2a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z"/>'),
  'folder-open': wrap('<path d="M2.5 12.5v-8h4l1.5 1.8h5.5v1.7"/><path d="M2 12.5l1.6-3.6h10.9l-1.6 3.6a1 1 0 0 1-1 .8H3a1 1 0 0 1-1-.8z"/>'),
  tag: wrap('<path d="M2.5 7.5v-5h5L14 9l-4.5 4.5L2.5 7.5z"/><circle cx="5" cy="5" r="0.9"/>'),
  gear: wrap('<circle cx="8" cy="8" r="2.2"/><path d="M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2M3.6 3.6l1.4 1.4M11 11l1.4 1.4M12.4 3.6L11 5M5 11l-1.4 1.4"/>'),
  keyboard: wrap('<rect x="1.8" y="4.8" width="12.4" height="6.9" rx="1"/><path d="M4.2 8h7.6M4.2 10h4.6"/>'),
  trash: wrap('<path d="M2.8 4.2h10.4M6.2 4.2V2.8h3.6v1.4M4.3 4.2l.6 8.8a1 1 0 0 0 1 .9h4.2a1 1 0 0 0 1-.9l.6-8.8M6.7 6.8v3.6M9.3 6.8v3.6"/>'),
  circle: wrap('<circle cx="8" cy="8" r="5.2"/>'),
  'circle-record': wrap('<circle cx="8" cy="8" r="5.2"/><circle cx="8" cy="8" r="2.2" fill="currentColor" stroke="none"/>'),
  export: wrap('<path d="M8 9.5V2.8M5.4 5.2L8 2.6l2.6 2.6M3.2 9.2v3a1 1 0 0 0 1 1h7.6a1 1 0 0 0 1-1v-3"/>'),
  'arrow-down': wrap('<path d="M8 2.8v9.4M4.4 8.6L8 12.2l3.6-3.6"/>'),
  lock: wrap('<rect x="3.4" y="7.2" width="9.2" height="6" rx="1"/><path d="M5.4 7.2V5a2.6 2.6 0 0 1 5.2 0v2.2"/>'),
  search: wrap('<circle cx="7" cy="7" r="4.4"/><path d="M10.2 10.2l3.2 3.2"/>'),
  close: wrap('<path d="M3.8 3.8l8.4 8.4M12.2 3.8l-8.4 8.4"/>'),
  'chevron-down': wrap('<path d="M4 6l4 4 4-4"/>'),
  lines: wrap('<path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11"/>'),
  'arrow-up': wrap('<path d="M8 13.2V3.8M4.4 7.4L8 3.8l3.6 3.6"/>'),
  funnel: wrap('<path d="M1.8 2.8h12.4l-4.8 5.6v4.2l-2.8 1.6V8.4z"/>'),
  play: wrap('<path d="M5.2 3.2l7.2 4.8-7.2 4.8z" fill="currentColor" stroke-width="1"/>'),
  stop: wrap('<rect x="4" y="4" width="8" height="8" rx="0.5" fill="currentColor" stroke-width="1"/>'),
} as const;

export type IconName = keyof typeof icons;

/** Renders one toolbar icon by name. Unknown names render empty (caller bug). */
export function icon(name: IconName): string {
  return icons[name];
}
