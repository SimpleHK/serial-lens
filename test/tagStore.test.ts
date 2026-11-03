import { describe, expect, it } from 'vitest';

import { PortTagStorage, PortTagStore } from '../src/host/tagStore';
import { Tag } from '../src/shared/tag';
import { makeTag, patchedTag, sanitizeTags, withoutTag } from '../src/shared/tagList';

const memoryStorage = (initial?: Record<string, Tag[]>): PortTagStorage & { saved: Record<string, Tag[]>[] } => {
  let value = initial;
  const saved: Record<string, Tag[]>[] = [];
  return {
    saved,
    get: () => value,
    update: async (map: Record<string, Tag[]>) => {
      value = map;
      saved.push(map);
    },
  };
};

const tag = (over: Partial<Tag>): Tag => ({
  id: over.id ?? 't1',
  name: over.name ?? 'ERR',
  pattern: over.pattern ?? 'ERROR',
  isRegex: false,
  color: over.color ?? '#112233',
  highlight: over.highlight ?? true,
  filter: over.filter ?? true,
});

describe('PortTagStore (per-port persistence, ADR-0006)', () => {
  it('loads a port\'s tags from the map', () => {
    const store = new PortTagStore(memoryStorage({ COM10: [tag({})] }));
    expect(store.load('COM10')).toHaveLength(1);
    expect(store.load('COM12')).toEqual([]); // other ports independent
  });

  it('drops malformed entries and assigns ids on load', () => {
    const store = new PortTagStore(memoryStorage({
      COM10: [
        { name: 'ok', pattern: 'p', isRegex: false, color: '#112233', highlight: true, filter: true },
        null,
        { name: 'noPattern' },
        'garbage',
        { name: 'legacy', pattern: 'p', isRegex: false, color: '#445566', enabled: true },
      ] as unknown as Tag[],
    }));
    const kept = store.load('COM10');
    expect(kept).toHaveLength(2);
    expect(kept[0].name).toBe('ok');
    expect(kept[1]).toMatchObject({ name: 'legacy', highlight: true, filter: true }); // legacy enabled -> both flags
    expect(typeof kept[0].id).toBe('string');
  });

  it('save keys by port and persists the whole map', async () => {
    const storage = memoryStorage();
    const store = new PortTagStore(storage);
    await store.save('COM10', [tag({ id: 'a' })]);
    await store.save('COM12', [tag({ id: 'b', name: 'WARN' })]);
    expect(Object.keys(storage.saved.at(-1)!).sort()).toEqual(['COM10', 'COM12']);
    expect(store.load('COM10').map((t) => t.id)).toEqual(['a']);
  });

  it('saving an empty list removes the port key entirely', async () => {
    const storage = memoryStorage({ COM10: [tag({})] });
    const store = new PortTagStore(storage);
    await store.save('COM10', []);
    expect(storage.saved.at(-1)).toEqual({});
    expect(store.load('COM10')).toEqual([]);
  });

  it('saving sanitizes: malformed entries never reach storage', async () => {
    const storage = memoryStorage();
    const store = new PortTagStore(storage);
    await store.save('COM10', [tag({ id: 'a' }), { name: 'junk' } as unknown as Tag]);
    expect(storage.saved.at(-1)!.COM10).toHaveLength(1);
  });

  it('ignores an empty path (a never-connected pane cannot persist)', async () => {
    const storage = memoryStorage();
    const store = new PortTagStore(storage);
    await store.save('', [tag({})]);
    expect(storage.saved).toHaveLength(0);
  });
});

describe('shared/tagList (pure pane-side operations)', () => {
  it('makeTag creates a highlighting+filtering substring tag with a unique name and free color', () => {
    const a = makeTag([], 'ERROR boom');
    const b = makeTag([a], 'ERROR boom');
    expect(b.pattern).toBe('ERROR boom');
    expect(b.highlight).toBe(true);
    expect(b.filter).toBe(true);
    expect(b.isRegex).toBe(false);
    expect(b.name).not.toBe(a.name); // deduped
    expect(b.color).not.toBe(a.color); // next free palette slot
  });

  it('patchedTag flips flags independently and validates fields', () => {
    const t = makeTag([], 'ERROR');
    let list = patchedTag([t], t.id, { highlight: false });
    expect(list[0]).toMatchObject({ highlight: false, filter: true });
    list = patchedTag(list, t.id, { color: 'not-a-color', pattern: '' });
    expect(list[0].color).toBe(t.color); // invalid patch ignored
    expect(patchedTag(list, 'ghost', { highlight: false })).toEqual(list); // unknown id no-op
  });

  it('patchedTag rename dedupes against other tags but keeps its own', () => {
    const a = makeTag([], 'alpha');
    const b = makeTag([a], 'beta');
    let list = patchedTag([a, b], a.id, { name: 'beta' });
    expect(list[0].name).toBe('beta 2');
    list = patchedTag(list, b.id, { name: 'beta' });
    expect(list[1].name).toBe('beta');
  });

  it('withoutTag removes only the addressed tag', () => {
    const a = makeTag([], 'a');
    const b = makeTag([a], 'b');
    expect(withoutTag([a, b], a.id).map((t) => t.id)).toEqual([b.id]);
    expect(withoutTag([a, b], 'ghost')).toHaveLength(2);
  });

  it('sanitizeTags guarantees ids and normalizes legacy entries', () => {
    const out = sanitizeTags([{ name: 'old', pattern: 'p', isRegex: false, color: '#112233', enabled: true }]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ highlight: true, filter: true });
    expect(typeof out[0].id).toBe('string');
    expect(sanitizeTags('garbage')).toEqual([]);
  });
});
