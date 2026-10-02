// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { focusReturn } from './focus-return';

afterEach(() => {
  document.body.innerHTML = '';
});

function page() {
  document.body.innerHTML = `
    <main id="main-content" tabindex="-1"></main>
    <button data-focus-return="row:1">one</button>
    <button data-focus-return="row:2">two</button>`;
}

describe('focusReturn', () => {
  it('puts focus on the control that opened the thing, found by its key', () => {
    page();
    focusReturn('row:2');
    expect(document.activeElement?.textContent).toBe('two');
  });

  it('falls back to the page’s main content when that control is no longer there (the list changed)', () => {
    page();
    focusReturn('row:99');
    expect(document.activeElement?.id).toBe('main-content');
  });

  it('falls back to the main content when it is given no key at all', () => {
    page();
    focusReturn(null);
    expect(document.activeElement?.id).toBe('main-content');
  });

  it('does nothing, and does not throw, on a page with neither', () => {
    document.body.innerHTML = '<p>nothing focusable</p>';
    expect(() => {
      focusReturn('row:1');
    }).not.toThrow();
  });

  it('matches the key exactly, not as a part of another key, and needs no selector escaping', () => {
    document.body.innerHTML = `
      <main id="main-content" tabindex="-1"></main>
      <button data-focus-return='odd"key]'>odd</button>
      <button data-focus-return="row:12">twelve</button>`;
    focusReturn('row:1');
    expect(document.activeElement?.id).toBe('main-content');
    focusReturn('odd"key]');
    expect(document.activeElement?.textContent).toBe('odd');
  });
});
