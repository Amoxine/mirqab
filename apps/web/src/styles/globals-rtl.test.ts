import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(__dirname, 'globals.css'), 'utf8');
/** Every `[dir='rtl'] ...` rule: its selector and its declarations. */
const rtlRules = [...css.matchAll(/(\[dir='rtl'\][^{}]*)\{([^}]*)\}/g)].map((m) => ({
  selector: String(m[1]).trim(),
  body: String(m[2]),
}));
const matchesPre = (selector: string) => /\bpre\b/.test(selector);

describe('code blocks in an RTL page', () => {
  it('keep their own left-to-right direction, isolated from the Arabic around them', () => {
    const rule = rtlRules.find((r) => matchesPre(r.selector) && r.body.includes('direction: ltr'));
    expect(rule?.body).toContain('unicode-bidi: isolate');
  });

  // `text-align: end` in an RTL page puts every line of a left-to-right block against the right edge,
  // so a multi-line command no longer lines up with its own continuation indent.
  it('are aligned to their start (the left), not the end', () => {
    const aligned = rtlRules.filter((r) => matchesPre(r.selector) && /text-align:\s*(start|end)/.test(r.body));
    expect(aligned.length).toBeGreaterThan(0);
    for (const rule of aligned) expect(rule.body, rule.selector).toMatch(/text-align:\s*start/);
  });

  // The lines live in the `code` inside the `pre`, and the identifier rule would align that `code` itself.
  it('have the `code` inside them aligned the same way', () => {
    const rule = rtlRules.find((r) => /pre\s+code/.test(r.selector) && /text-align:\s*start/.test(r.body));
    expect(rule).toBeDefined();
  });
});
