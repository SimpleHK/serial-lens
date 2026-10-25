import { randomUUID } from 'node:crypto';

import { isValidTag, nextFreeColor, normalizeTag, Tag } from '../shared/tag';

/**
 * Persistence boundary so the store stays vscode-free and testable. The
 * production adapter maps this onto workspace settings (`serialMonitor.tags`).
 */
export interface TagStorage {
  get(): Tag[] | undefined;
  update(tags: Tag[]): Promise<void>;
}

type Listener = (tags: readonly Tag[]) => void;

/**
 * Owns the workspace's tag vocabulary: load with sanitization, create tags
 * from a selected pattern, toggle enable state, edit, delete, persist on
 * every change. Tags are addressed by their stable `id` — names are display
 * only and may be deduplicated or renamed at any time. Filtering is a
 * separate display-layer concern (ADR-0004); the store only holds the rules.
 */
export class TagStore {
  private tags: Tag[];
  private readonly listeners = new Set<Listener>();

  constructor(private readonly storage: TagStorage) {
    // Legacy entries (pre-id) get an id assigned on load and persist with it
    // on the next change.
    this.tags = (storage.get() ?? []).filter(isValidTag).map((t) => ({ ...normalizeTag(t), id: t.id ?? randomUUID() }));
  }

  getTags(): readonly Tag[] {
    return this.tags;
  }

  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Creates an enabled substring tag prefilled from the selection. */
  async add(pattern: string): Promise<Tag> {
    const trimmed = pattern.trim();
    const name = this.uniqueName(trimmed.length > 0 ? trimmed : 'Tag');
    const tag: Tag = {
      id: randomUUID(),
      name,
      pattern: trimmed,
      isRegex: false,
      color: nextFreeColor(this.tags),
      highlight: true,
      filter: true,
    };
    this.tags = [...this.tags, tag];
    await this.persist();
    return tag;
  }

  /** Applies a validated field patch; renaming dedupes against other tags. */
  async update(id: string, patch: Partial<Omit<Tag, 'id'>>): Promise<void> {
    const current = this.tags.find((t) => t.id === id);
    if (!current) {
      return;
    }
    const merged: Tag = { ...current };
    if (patch.name !== undefined && typeof patch.name === 'string' && patch.name.trim()) {
      merged.name = this.uniqueNameFor(patch.name.trim(), id);
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
    if (typeof patch.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(patch.color)) {
      merged.color = patch.color;
    }
    this.tags = this.tags.map((t) => (t.id === id ? merged : t));
    await this.persist();
  }

  /** Removes every tag at once (one-click clear). */
  async clearAll(): Promise<void> {
    if (this.tags.length === 0) {
      return;
    }
    this.tags = [];
    await this.persist();
  }

  async remove(id: string): Promise<void> {
    if (!this.tags.some((t) => t.id === id)) {
      return;
    }
    this.tags = this.tags.filter((t) => t.id !== id);
    await this.persist();
  }

  /** Re-reads storage after external edits (e.g. settings.json changed). */
  reload(): void {
    this.tags = this.loadTags();
    for (const listener of this.listeners) {
      listener(this.tags);
    }
  }

  private loadTags(): Tag[] {
    // One load path for both constructor and reload: legacy enabled ->
    // highlight/filter migration must not depend on which one ran.
    return (this.storage.get() ?? [])
      .filter(isValidTag)
      .map((t) => ({ ...normalizeTag(t), id: t.id ?? randomUUID() }));
  }

  private uniqueName(base: string): string {
    const maxBaseLength = 24;
    const truncated = base.length > maxBaseLength ? `${base.slice(0, maxBaseLength)}…` : base;
    if (!this.tags.some((t) => t.name === truncated)) {
      return truncated;
    }
    let n = 2;
    while (this.tags.some((t) => t.name === `${truncated} ${n}`)) {
      n++;
    }
    return `${truncated} ${n}`;
  }

  /** Like uniqueName, but the tag being renamed may keep its own name. */
  private uniqueNameFor(base: string, selfId: string): string {
    if (!this.tags.some((t) => t.name === base && t.id !== selfId)) {
      return base;
    }
    let n = 2;
    while (this.tags.some((t) => t.name === `${base} ${n}` && t.id !== selfId)) {
      n++;
    }
    return `${base} ${n}`;
  }

  private async persist(): Promise<void> {
    await this.storage.update(this.tags);
    for (const listener of this.listeners) {
      listener(this.tags);
    }
  }
}
