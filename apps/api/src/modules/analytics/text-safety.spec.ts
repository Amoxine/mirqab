import { isStorable, isWellFormed, storable } from './text-safety';

const HIGH = '\uD83D'; // the first half of 😀
const LOW = '\uDE00'; // the second half

describe('text safety for Postgres', () => {
  it('knows a lone surrogate from a pair, at the start, the middle and the end', () => {
    expect(isWellFormed('plain 😀 text')).toBe(true);
    expect(isWellFormed('')).toBe(true);
    for (const bad of [HIGH, LOW, `a${HIGH}`, `${LOW}a`, `${HIGH}${HIGH}${LOW}`, `${LOW}${HIGH}`, `x${HIGH}y`]) {
      expect(isWellFormed(bad)).toBe(false);
    }
  });

  it('can be called twice on the same text: the regex keeps no state between calls', () => {
    expect(isWellFormed(`a${HIGH}`)).toBe(false);
    expect(isWellFormed(`a${HIGH}`)).toBe(false);
    expect(isWellFormed('ok')).toBe(true);
  });

  it('replaces each unpaired surrogate with U+FFFD and keeps a real pair', () => {
    expect(storable(`a${HIGH}`)).toBe('a�');
    expect(storable(`${LOW}b`)).toBe('�b');
    expect(storable('keep 😀 pair')).toBe('keep 😀 pair');
    expect(isWellFormed(storable(`${HIGH}${HIGH}${LOW}${LOW}${LOW}`))).toBe(true);
  });

  it('drops NUL, which a text column refuses', () => {
    expect(storable('a\u0000b\u0000')).toBe('ab');
    expect(isStorable('a\u0000b')).toBe(false);
    expect(isStorable('ab')).toBe(true);
    expect(isStorable(`ab${HIGH}`)).toBe(false);
  });

  it('what storable returns is always storable, and what is already storable is returned as it was', () => {
    const samples = ['', 'abc', `x${HIGH}`, `${LOW}\u0000${HIGH}`, '😀😀', 'مرحبا'];
    for (const s of samples) {
      expect(isStorable(storable(s))).toBe(true);
      if (isStorable(s)) expect(storable(s)).toBe(s);
    }
  });

  it('a value that JSON.stringify writes as an escape for a lone surrogate is the poison; storable removes it', () => {
    expect(JSON.stringify({ v: `a${HIGH}` })).toContain('\\ud83d');
    expect(JSON.stringify({ v: storable(`a${HIGH}`) })).not.toMatch(/\\ud[89ab]/i);
  });
});
