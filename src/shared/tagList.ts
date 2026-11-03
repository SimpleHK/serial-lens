import { isValidTag, nextFreeColor, normalizeTag, Tag } from './tag';

/**
 * Pure operations over a pane's tag list (ADR-0006: tags are per-pane state,
 * owned by the webview session and persisted by the host). No DOM, no vscode,
 * no node imports — the same module runs in the webview bundle and the host.
 */

/** Browser-safe id (webviews are secure contexts; the fallback covers tests
 * and exotic embedders — ids only need uniqueness within one pane). */
let idCounter = 0;
export function newTagId(): string {
  const crypto = globalThis.crypto as Crypto | undefined;
  if (crypto?.randomUUID) {
    return crypto.randomUUID();
  }
  idCounter += 1;
  return `t-${Date.now().toString(36)}-${idCounter}`;
}

const MAX_NAME_LENGTH = 24;

/** Display names are unique within one pane; renamed tags keep their own. */
export function uniqueNameFor(list: readonly Tag[], base: string, selfId?: string): string {
  const truncated = base.length > MAX_NAME_LENGTH ? `${base.slice(0, MAX_NAME_LENGTH)}…` : base;
  const taken = (name: string) => list.some((t) => t.name === name && t.id !== selfId);
  if (!taken(truncated)) {
    return truncated;
  }
  let n = 2;
  while (taken(`${truncated} ${n}`)) {
    n++;
  }
  return `${truncated} ${n}`;
}

/** Creates an enabled substring tag prefilled from a pattern, colored from
 * the pane's free palette slots. */
export function makeTag(list: readonly Tag[], pattern: string): Tag {
  const trimmed = pattern.trim();
  return {
    id: newTagId(),
    name: uniqueNameFor(list, trimmed.length > 0 ? trimmed : 'Tag'),
    pattern: trimmed,
    isRegex: false,
    color: nextFreeColor(list),
    highlight: true,
    filter: true,
  };
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/** Applies a validated field patch to one tag (dedupe against the pane's
 * other tags); unknown fields and empty values are ignored. */
export function patchedTag(list: readonly Tag[], id: string, patch: Partial<Omit<Tag, 'id'>>): Tag[] {
  const current = list.find((t) => t.id === id);
  if (!current) {
    return [...list];
  }
  const merged: Tag = { ...current };
  if (typeof patch.name === 'string' && patch.name.trim()) {
    merged.name = uniqueNameFor(list, patch.name.trim(), id);
  }
  if (typeof patch.pattern === 'string' && patch.pattern.trim()) {
    merged.pattern = patch.pattern;
  }
  if (typeof patch.isRegex === 'boolean') {
    merged.isRegex = patch.isRegex;
  }
  if (typeof patch.highlight === 'boolean') {
    merged.highlight = patch.highlight;
  }
  if (typeof patch.filter === 'boolean') {
    merged.filter = patch.filter;
  }
  if (typeof patch.color === 'string' && HEX_COLOR.test(patch.color)) {
    merged.color = patch.color;
  }
  return list.map((t) => (t.id === id ? merged : t));
}

export function withoutTag(list: readonly Tag[], id: string): Tag[] {
  return list.filter((t) => t.id !== id);
}

/** Persistence boundary sanitizer: drops malformed entries, normalizes legacy
 * ones, guarantees ids. */
export function sanitizeTags(raw: unknown): Tag[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return (raw as unknown[])
    .filter(isValidTag)
    .map((t) => ({ ...normalizeTag(t), id: t.id || newTagId() }));
}
