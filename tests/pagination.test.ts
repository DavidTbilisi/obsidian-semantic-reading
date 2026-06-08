import { describe, it, expect } from 'vitest';
import { decodeCursor, paginate } from '../src/mcp/pagination';

describe('decodeCursor', () => {
  it('treats missing / malformed cursors as offset 0', () => {
    expect(decodeCursor(undefined)).toBe(0);
    expect(decodeCursor('')).toBe(0);
    expect(decodeCursor('abc')).toBe(0);
    expect(decodeCursor('-5')).toBe(0);
  });
  it('decodes a numeric cursor', () => {
    expect(decodeCursor('7')).toBe(7);
  });
});

describe('paginate', () => {
  const items = Array.from({ length: 250 }, (_, i) => i);

  it('returns the first page and a next cursor', () => {
    const p = paginate(items, undefined, 100);
    expect(p.items).toHaveLength(100);
    expect(p.items[0]).toBe(0);
    expect(p.nextCursor).toBe('100');
  });

  it('follows the cursor to the middle page', () => {
    const p = paginate(items, '100', 100);
    expect(p.items[0]).toBe(100);
    expect(p.nextCursor).toBe('200');
  });

  it('omits nextCursor on the final page', () => {
    const p = paginate(items, '200', 100);
    expect(p.items).toHaveLength(50);
    expect(p.nextCursor).toBeUndefined();
  });
});
