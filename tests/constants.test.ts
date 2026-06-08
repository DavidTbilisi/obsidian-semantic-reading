import { afterEach, describe, expect, it } from 'vitest';
import {
  BUILTIN_KEY_TO_TAG,
  KEY_TO_TAG,
  TAGS,
  applyKeyBindingOverrides,
  resetRegistries,
  tagForKey,
  tagOrder,
} from '../src/constants';

afterEach(() => {
  // Tests mutate globals — reset to baseline so each test is independent.
  resetRegistries();
});

describe('applyKeyBindingOverrides', () => {
  it('is a no-op for empty overrides', () => {
    const before = { ...KEY_TO_TAG };
    applyKeyBindingOverrides({});
    expect(KEY_TO_TAG).toEqual(before);
  });

  it('handles null/undefined safely', () => {
    const before = { ...KEY_TO_TAG };
    // @ts-expect-error — testing defensive guard
    applyKeyBindingOverrides(undefined);
    // @ts-expect-error — testing defensive guard
    applyKeyBindingOverrides(null);
    expect(KEY_TO_TAG).toEqual(before);
  });

  it('overrides a built-in binding', () => {
    expect(KEY_TO_TAG['d']).toBe('Def');
    applyKeyBindingOverrides({ d: 'Q' });
    expect(KEY_TO_TAG['d']).toBe('Q');
    expect(tagForKey('d')).toBe('Q');
  });

  it('adds a new binding for a free letter', () => {
    expect(KEY_TO_TAG['z']).toBeUndefined();
    // 'Def' is a valid sigil; binding 'z' to it should succeed.
    applyKeyBindingOverrides({ z: 'Def' });
    expect(KEY_TO_TAG['z']).toBe('Def');
  });

  it('clears a built-in binding when the sigil is empty string', () => {
    expect(KEY_TO_TAG['d']).toBe('Def');
    applyKeyBindingOverrides({ d: '' });
    expect(KEY_TO_TAG['d']).toBeUndefined();
    expect(tagForKey('d')).toBeNull();
  });

  it('lowercases the override key', () => {
    applyKeyBindingOverrides({ Z: 'Def' });
    expect(KEY_TO_TAG['z']).toBe('Def');
    expect(KEY_TO_TAG['Z']).toBeUndefined();
  });

  it('skips multi-character keys', () => {
    const before = { ...KEY_TO_TAG };
    applyKeyBindingOverrides({ ab: 'Def' });
    expect(KEY_TO_TAG).toEqual(before);
  });

  it('skips empty-string keys', () => {
    const before = { ...KEY_TO_TAG };
    applyKeyBindingOverrides({ '': 'Def' });
    expect(KEY_TO_TAG).toEqual(before);
  });

  it('skips overrides pointing at a non-existent sigil', () => {
    const before = { ...KEY_TO_TAG };
    applyKeyBindingOverrides({ d: 'NoSuchTag' });
    expect(KEY_TO_TAG).toEqual(before);
  });

  it('applies multiple overrides at once', () => {
    applyKeyBindingOverrides({ d: 'Q', q: 'Def', z: 'M' });
    expect(KEY_TO_TAG['d']).toBe('Q');
    expect(KEY_TO_TAG['q']).toBe('Def');
    expect(KEY_TO_TAG['z']).toBe('M');
  });

  it('combines clear-and-rebind: clear "d", then bind "x" to Def', () => {
    applyKeyBindingOverrides({ d: '', x: 'Def' });
    expect(KEY_TO_TAG['d']).toBeUndefined();
    expect(KEY_TO_TAG['x']).toBe('Def');
  });
});

describe('tagForKey', () => {
  it('returns null for an unbound key', () => {
    expect(tagForKey('z')).toBeNull();
  });

  it('returns the tag for a built-in key', () => {
    expect(tagForKey('d')).toBe('Def');
  });

  it('is case-insensitive', () => {
    expect(tagForKey('D')).toBe('Def');
  });
});

describe('tagOrder', () => {
  it('returns every TAGS key when no filter is given', () => {
    const order = tagOrder();
    expect(order.length).toBe(Object.keys(TAGS).length);
  });

  it('honors a filter function', () => {
    const order = tagOrder(k => k === 'Def');
    expect(order).toEqual(['Def']);
  });

  it('places parents before children', () => {
    const order = tagOrder();
    // Verify every entry: if it has a parent that is also in the result, the
    // parent's index must come before the child's.
    const index = new Map(order.map((k, i) => [k, i]));
    for (const k of order) {
      const parent = TAGS[k].parent;
      if (parent && index.has(parent)) {
        expect(index.get(parent)! < index.get(k)!).toBe(true);
      }
    }
  });
});

describe('resetRegistries', () => {
  it('restores KEY_TO_TAG after overrides', () => {
    applyKeyBindingOverrides({ d: '', z: 'Def' });
    expect(KEY_TO_TAG['d']).toBeUndefined();
    expect(KEY_TO_TAG['z']).toBe('Def');
    resetRegistries();
    expect(KEY_TO_TAG['d']).toBe(BUILTIN_KEY_TO_TAG['d']);
    expect(KEY_TO_TAG['z']).toBeUndefined();
  });

  it('restores TAGS after mutation', () => {
    const sigils = Object.keys(TAGS).sort();
    delete (TAGS as Record<string, unknown>)['Def'];
    resetRegistries();
    expect(Object.keys(TAGS).sort()).toEqual(sigils);
  });
});
