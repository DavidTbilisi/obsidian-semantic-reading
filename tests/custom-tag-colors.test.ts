import { afterEach, describe, expect, it } from 'vitest';
import {
  applyCustomTagColors,
  customTagColorVar,
  tintCustomTag,
  type CustomTagDef,
} from '../src/custom-tags';

function def(sigil: string, light: string, dark: string): CustomTagDef {
  return { sigil, name: `${sigil} tag`, family: 'Structure', desc: '', light, dark };
}

afterEach(() => {
  applyCustomTagColors([]); // clear all published color vars
  document.body.classList.remove('theme-dark');
  document.body.removeAttribute('style');
});

describe('custom-tag colors (no <style> injection)', () => {
  it('publishes a --t-<sigil> var on the body using the light value', () => {
    applyCustomTagColors([def('Foo', '#111111', '#eeeeee')]);
    expect(document.body.style.getPropertyValue('--t-Foo')).toBe('#111111');
    expect(customTagColorVar('Foo')).toBe('var(--t-Foo)');
  });

  it('uses the dark value when theme-dark is active', () => {
    document.body.classList.add('theme-dark');
    applyCustomTagColors([def('Foo', '#111111', '#eeeeee')]);
    expect(document.body.style.getPropertyValue('--t-Foo')).toBe('#eeeeee');
  });

  it('returns null for built-in and unknown sigils', () => {
    applyCustomTagColors([def('Foo', '#111111', '#eeeeee')]);
    expect(customTagColorVar('D')).toBeNull();   // built-in, colored by styles.css
    expect(customTagColorVar('Bar')).toBeNull(); // never registered
  });

  it('tintCustomTag colors custom tags and leaves built-ins untouched', () => {
    applyCustomTagColors([def('Foo', '#111111', '#eeeeee')]);

    const custom = document.createElement('span');
    tintCustomTag(custom, 'Foo');
    expect(custom.style.getPropertyValue('color')).toBe('var(--t-Foo)');

    const builtin = document.createElement('span');
    tintCustomTag(builtin, 'D');
    expect(builtin.style.getPropertyValue('color')).toBe('');
  });

  it('removes the var when a custom tag is dropped', () => {
    applyCustomTagColors([def('Foo', '#111111', '#eeeeee'), def('Bar', '#222222', '#dddddd')]);
    expect(document.body.style.getPropertyValue('--t-Bar')).toBe('#222222');

    applyCustomTagColors([def('Foo', '#111111', '#eeeeee')]); // Bar gone
    expect(document.body.style.getPropertyValue('--t-Bar')).toBe('');
    expect(customTagColorVar('Bar')).toBeNull();
  });
});
