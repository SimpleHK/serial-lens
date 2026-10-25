import { isValidTag, nextFreeColor, Tag } from '../shared/tag';

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
 * from a selected pattern, toggle enable state, persist on every change.
 * Filtering is a separate display-layer concern (ADR-0004) — the store only
 * holds the rules.
 */
export class TagStore {
  private tags: Tag[];
  private readonly listeners = new Set<Listener>();

  constructor(private readonly storage: TagStorage) {
    this.tags = (storage.get() ?? []).filter(isValidTag);
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
      name,
      pattern: trimmed,
      isRegex: false,
      color: nextFreeColor(this.tags),
      enabled: true,
    };
    this.tags = [...this.tags, tag];
    await this.persist();
    return tag;
  }

  async toggle(name: string): Promise<void> {
    if (!this.tags.some((t) => t.name === name)) {
      return; // unknown name: clean no-op
    }
    this.tags = this.tags.map((t) => (t.name === name ? { ...t, enabled: !t.enabled } : t));
    await this.persist();
  }

  /** Re-reads storage after external edits (e.g. settings.json changed). */
  reload(): void {
    this.tags = (this.storage.get() ?? []).filter(isValidTag);
    for (const listener of this.listeners) {
      listener(this.tags);
    }
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

  private async persist(): Promise<void> {
    await this.storage.update(this.tags);
    for (const listener of this.listeners) {
      listener(this.tags);
    }
  }
}
