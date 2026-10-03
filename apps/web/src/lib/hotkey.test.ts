import { describe, expect, it } from 'vitest';
import { isKKey } from './hotkey';

describe('isKKey', () => {
  it.each([
    ['k', 'KeyK', 'a Latin layout'],
    ['K', 'KeyK', 'with Shift or Caps Lock'],
    ['ل', 'KeyK', 'an Arabic layout, where the K key types "ل"'],
    ['k', 'KeyV', 'Dvorak, where "k" sits on another physical key'],
  ])('accepts %s on %s (%s)', (key, code) => {
    expect(isKKey({ key, code })).toBe(true);
  });

  it.each([
    ['j', 'KeyJ', 'another letter'],
    ['t', 'KeyK', 'Dvorak, where the physical K key types "t"'],
    ['ن', 'KeyB', 'another key on an Arabic layout'],
    ['Enter', 'Enter', 'a named key'],
  ])('rejects %s on %s (%s)', (key, code) => {
    expect(isKKey({ key, code })).toBe(false);
  });
});
