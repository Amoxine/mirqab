// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { navLinkClass } from './sidebar';

describe('navLinkClass', () => {
  it('active expanded includes active colors and start border', () => {
    for (const cls of [navLinkClass(true), navLinkClass(true, { collapsed: false })]) {
      expect(cls).toContain('bg-primary/10');
      expect(cls).toContain('text-primary');
      expect(cls).toContain('border-s-2');
      expect(cls).toContain('border-primary');
    }
  });

  it('active collapsed keeps active colors without start border', () => {
    const cls = navLinkClass(true, { collapsed: true });
    expect(cls).toContain('bg-primary/10');
    expect(cls).toContain('text-primary');
    expect(cls).not.toContain('border-s-2');
  });

  it('inactive links omit active background and start border', () => {
    for (const cls of [navLinkClass(false), navLinkClass(false, { collapsed: true })]) {
      expect(cls).not.toContain('bg-primary/10');
      expect(cls).not.toContain('border-s-2');
    }
  });
});
