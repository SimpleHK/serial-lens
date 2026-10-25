import { describe, expect, it, vi } from 'vitest';

import { TagStorage, TagStore } from '../src/host/tagStore';
import { Tag } from '../src/shared/tag';

const memoryStorage = (initial?: Tag[]): TagStorage & { saved: Tag[][] } => {
  let value = initial;
  const saved: Tag[][] = [];
  return {
    saved,
    get: () => value,
    update: async (tags: Tag[]) => {
      value = tags;
      saved.push(tags);
    },
  };
};

describe('TagStore', () => {
  it('loads existing tags from storage', () => {
    const existing: Tag[] = [{ name: 'ERR', pattern: 'ERROR', isRegex: false, color: '#112233', enabled: true }];
    const store = new TagStore(memoryStorage(existing));
    expect(store.getTags()).toEqual(existing);
  });

  it('drops malformed entries when loading', () => {
    const store = new TagStore(memoryStorage([
      { name: 'ok', pattern: 'p', isRegex: false, color: '#112233', enabled: true },
      null,
      { name: 'noPattern' },
      'garbage',
      { name: 'noColor', pattern: 'p', isRegex: false, enabled: true },
    ] as unknown as Tag[]));
    expect(store.getTags()).toEqual([
      { name: 'ok', pattern: 'p', isRegex: false, color: '#112233', enabled: true },
    ]);
  });

  it('add creates an enabled substring tag prefilled from the pattern', async () => {
    const store = new TagStore(memoryStorage());
    const t = await store.add('ERROR boom');
    expect(t.pattern).toBe('ERROR boom');
    expect(t.enabled).toBe(true);
    expect(t.isRegex).toBe(false);
    expect(t.name.length).toBeGreaterThan(0);
  });

  it('add auto-assigns the first unused palette color', async () => {
    const store = new TagStore(memoryStorage());
    const first = await store.add('a');
    const second = await store.add('b');
    expect(first.color).not.toBe(second.color);
    expect(store.getTags().map((t) => t.color)).toEqual([first.color, second.color]);
  });

  it('keeps assigning colors when the palette is exhausted', async () => {
    const store = new TagStore(memoryStorage());
    const first = await store.add('a');
    // More adds than palette entries — every tag still gets a color, cycling.
    for (let i = 0; i < 12; i++) {
      await store.add(`t${i}`);
    }
    const all = store.getTags();
    expect(all).toHaveLength(13);
    expect(all.every((t) => typeof t.color === 'string' && t.color.length > 0)).toBe(true);
    expect(all[0].color).toBe(first.color); // cycle restarts from the palette head
  });

  it('add dedupes default names', async () => {
    const store = new TagStore(memoryStorage());
    const a = await store.add('same');
    const b = await store.add('same');
    expect(a.name).not.toBe(b.name);
  });

  it('toggle flips enabled and persists through storage', async () => {
    const storage = memoryStorage();
    const store = new TagStore(storage);
    const t = await store.add('ERROR');
    await store.toggle(t.name);
    expect(store.getTags()[0].enabled).toBe(false);
    expect(storage.saved.at(-1)).toEqual(store.getTags());
    await store.toggle(t.name);
    expect(store.getTags()[0].enabled).toBe(true);
  });

  it('toggle of an unknown name is a no-op', async () => {
    const storage = memoryStorage();
    const store = new TagStore(storage);
    await store.add('x');
    await store.toggle('nope');
    expect(store.getTags()).toHaveLength(1);
  });

  it('reload picks up external storage changes and notifies listeners', async () => {
    let value: Tag[] | undefined = [];
    const listener = vi.fn();
    const store = new TagStore({ get: () => value, update: async (tags) => { value = tags; } });
    store.onChange(listener);

    value = [{ name: 'external', pattern: 'E', isRegex: true, color: '#abcdef', enabled: false }];
    store.reload();

    expect(store.getTags()).toEqual(value);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('update applies field patches and persists', async () => {
    const storage = memoryStorage();
    const store = new TagStore(storage);
    const t = await store.add('old');

    await store.update(t.name, { name: 'renamed', pattern: 'NEW', isRegex: true, color: '#123456', enabled: false });

    expect(store.getTags()).toEqual([
      { name: 'renamed', pattern: 'NEW', isRegex: true, color: '#123456', enabled: false },
    ]);
    expect(storage.saved.at(-1)).toEqual(store.getTags());
  });

  it('update rename dedupes against other tag names but keeps its own', async () => {
    const store = new TagStore(memoryStorage());
    const a = await store.add('alpha');
    const b = await store.add('beta');

    await store.update(a.name, { name: 'beta' }); // collide with the other tag
    expect(store.getTags()[0].name).toBe('beta 2');

    await store.update(b.name, { name: 'beta' }); // its own name is fine
    expect(store.getTags()[1].name).toBe('beta');
  });

  it('update ignores invalid field values and unknown names', async () => {
    const store = new TagStore(memoryStorage());
    const t = await store.add('keep');
    const before = store.getTags();

    await store.update('ghost', { pattern: 'x' });
    await store.update(t.name, { color: 'not-a-color', pattern: '' } as Partial<Tag>);

    expect(store.getTags()).toEqual(before);
  });

  it('remove deletes the tag and persists', async () => {
    const storage = memoryStorage();
    const store = new TagStore(storage);
    const a = await store.add('a');
    await store.add('b');

    await store.remove(a.name);

    expect(store.getTags().map((t) => t.name)).toEqual(['b']);
    expect(storage.saved.at(-1)).toEqual(store.getTags());
  });

  it('remove of an unknown name is a no-op', async () => {
    const store = new TagStore(memoryStorage());
    await store.add('a');
    const before = store.getTags();

    await store.remove('ghost');

    expect(store.getTags()).toEqual(before);
  });

  it('notifies listeners on every change', async () => {
    const store = new TagStore(memoryStorage());
    const listener = vi.fn();
    store.onChange(listener);
    const t = await store.add('x');
    await store.toggle(t.name);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
