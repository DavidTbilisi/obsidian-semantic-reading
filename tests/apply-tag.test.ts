import { describe, it, expect } from 'vitest';
import { applyTagInBody } from '../src/edit/apply-tag';

describe('applyTagInBody', () => {
  it('wraps a span and appends the canonical block id', () => {
    const r = applyTagInBody('The cat sat on the mat.', { paraIndex: 0, span: 'cat', tag: 'Def' });
    expect(r.body).toBe('The {{Def|cat}} sat on the mat. ^p1-sr');
    expect(r.blockId).toBe('p1-sr');
    expect(r.paragraph).toBe('The {{Def|cat}} sat on the mat.');
  });

  it('attaches a note= annotation when provided', () => {
    const r = applyTagInBody('The cat sat.', { paraIndex: 0, span: 'cat', tag: 'Def', note: 'feline' });
    expect(r.paragraph).toBe('The {{Def|cat|note=feline}} sat.');
  });

  it('preserves an existing user block id', () => {
    const r = applyTagInBody('Hello world ^myid', { paraIndex: 0, span: 'world', tag: 'Def' });
    expect(r.body).toBe('Hello {{Def|world}} ^myid');
    expect(r.blockId).toBe('myid');
  });

  it('tags the right paragraph and leaves others untouched', () => {
    const r = applyTagInBody('Para one here.\n\nPara two with word.', { paraIndex: 1, span: 'word', tag: 'Def' });
    expect(r.body).toBe('Para one here.\n\nPara two with {{Def|word}}. ^p2-sr');
  });

  it('throws when the span is absent', () => {
    expect(() => applyTagInBody('no match here', { paraIndex: 0, span: 'cat', tag: 'Def' }))
      .toThrow(/not found verbatim/);
  });

  it('throws when paraIndex is out of range', () => {
    expect(() => applyTagInBody('only one para', { paraIndex: 3, span: 'one', tag: 'Def' }))
      .toThrow(/out of range/);
  });
});
