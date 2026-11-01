/**
 * The virtualized renderer needs every row to occupy EXACTLY rowHeightPx
 * pixels, so the height must be an integer the CSS agrees on: 1.5em of the
 * 13px editor font is 19.5 real pixels, and offsetHeight's rounding made the
 * spacer math drift 0.5px per row (scrollbars jumping, find jumps landing
 * outside the rendered window). The measured font size is rounded once here,
 * written to the --sm-row-h CSS variable, and both sides consume it.
 */
export function rowHeightFor(fontSizePx: number): number {
  return Math.max(16, Math.round(fontSizePx * 1.5));
}
