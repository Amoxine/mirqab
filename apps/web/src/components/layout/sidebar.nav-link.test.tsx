// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { navLinkClass } from './sidebar';

describe('navLinkClass', () => {
  it('active expanded link is a tinted pill in the accent colour', () => {
    for (const cls of [navLinkClass(true), navLinkClass(true, { collapsed: false })]) {
      expect(cls).toContain('bg-primary/10');
      expect(cls).toContain('text-primary');
      expect(cls).toContain('rounded-full');
    }
  });

  it('active collapsed link is a filled accent circle', () => {
    const cls = navLinkClass(true, { collapsed: true });
    expect(cls).toContain('bg-primary');
    expect(cls).toContain('text-primary-foreground');
    expect(cls).toContain('size-11');
    expect(cls).not.toContain('bg-primary/10');
  });

  it('inactive links carry no accent fill in either mode', () => {
    for (const cls of [navLinkClass(false), navLinkClass(false, { collapsed: true })]) {
      expect(cls).not.toContain('bg-primary/10');
      expect(cls).not.toMatch(/(^|\s)bg-primary(\s|$)/);
      expect(cls).not.toContain('text-primary-foreground');
    }
  });
});
