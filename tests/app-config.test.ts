import { describe, expect, it } from 'vitest';
import { CONFIG_END, CONFIG_START, deepMerge, injectConfig, normalizeProxyEntry } from '../scripts/app-config.mjs';

describe('deepMerge', () => {
  it('merges nested objects', () => {
    expect(deepMerge({ a: { b: 1, c: 2 } }, { a: { c: 3 } })).toEqual({
      a: { b: 1, c: 3 },
    });
  });

  it('replaces arrays rather than merging them', () => {
    expect(deepMerge({ a: [1, 2] }, { a: [3] })).toEqual({ a: [3] });
  });

  it('adds keys missing from the base', () => {
    expect(deepMerge({ a: 1 }, { b: 2 })).toEqual({ a: 1, b: 2 });
  });
});

describe('injectConfig', () => {
  const html = `<head>${CONFIG_START}<script>old</script>${CONFIG_END}</head>`;

  it('replaces the config block', () => {
    const out = injectConfig(html, { title: 'x' });

    expect(out).toContain('window.__APP_CONFIG__ = {"title":"x"}');
    expect(out).not.toContain('old');
  });

  it('leaves the rest of the page intact', () => {
    const out = injectConfig(html, {});

    expect(out.startsWith('<head>')).toBe(true);
    expect(out.endsWith('</head>')).toBe(true);
  });
});

describe('normalizeProxyEntry', () => {
  it('expands a bare url', () => {
    expect(normalizeProxyEntry('https://up')).toEqual({
      url: 'https://up',
      headers: {},
      query: '',
    });
  });

  it('keeps headers and query from an object', () => {
    expect(
      normalizeProxyEntry({
        url: 'https://up',
        headers: { a: 'b' },
        query: 'x=1',
      })
    ).toEqual({
      url: 'https://up',
      headers: { a: 'b' },
      query: 'x=1',
    });
  });
});
