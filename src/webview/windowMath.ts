/**
 * Pure half of the virtualized-render contract (the row-height integer
 * contract lives in rowHeight.ts). Given the scroll state and the buffer
 * size, computes which row window to render and the spacer heights that pin
 * it to the real layout — the math must stay in one place so CSS and JS can
 * never disagree.
 */

export interface RenderWindow {
  first: number;
  last: number;
  topPx: number;
  bottomPx: number;
}

export function computeRenderWindow(
  scrollTop: number,
  clientHeight: number,
  rowHeightPx: number,
  total: number,
  overscan: number,
): RenderWindow {
  if (total <= 0 || rowHeightPx <= 0) {
    return { first: 0, last: 0, topPx: 0, bottomPx: 0 };
  }
  const first = Math.max(0, Math.floor(scrollTop / rowHeightPx) - overscan);
  const last = Math.min(total, Math.ceil((scrollTop + clientHeight) / rowHeightPx) + overscan);
  return { first, last, topPx: first * rowHeightPx, bottomPx: (total - last) * rowHeightPx };
}
