import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_LOCALE, LOCALES } from '@/i18n/locales';
import enDocs from '@/messages/en/docs.json';
import frDocs from '@/messages/fr/docs.json';
import arDocs from '@/messages/ar/docs.json';
import { docsI18n } from './i18n';
import { remarkMermaid } from './remark-mermaid';

const CONTENT = join(__dirname, '../../../content/docs');
const pagesOf = (locale: string) => readdirSync(join(CONTENT, locale)).filter((f) => f.endsWith('.mdx'));
const metaOf = (locale: string) => JSON.parse(readFileSync(join(CONTENT, locale, 'meta.json'), 'utf8')) as { title: string; pages: string[] };
const frontMatter = (locale: string, file: string) => /^---\n([\s\S]*?)\n---/.exec(readFileSync(join(CONTENT, locale, file), 'utf8'))?.[1] ?? '';

describe('docs content and locales', () => {
  it('serves the same locales as the app, in the app default language first', () => {
    expect(docsI18n.languages).toEqual([...LOCALES]);
    expect(docsI18n.defaultLanguage).toBe(DEFAULT_LOCALE);
    expect(docsI18n.fallbackLanguage).toBe(DEFAULT_LOCALE);
  });

  it.each(LOCALES)('%s has a landing page and a sidebar that lists it', (locale) => {
    expect(pagesOf(locale)).toContain('index.mdx');
    expect(metaOf(locale).pages).toContain('index');
    expect(metaOf(locale).title).not.toBe('');
  });

  it('English is the complete set: every other language only translates pages English has', () => {
    const en = pagesOf(DEFAULT_LOCALE);
    for (const locale of LOCALES) for (const page of pagesOf(locale)) expect(en).toContain(page);
  });

  it('every language lists the same pages in the sidebar, so a missing translation falls back instead of vanishing', () => {
    for (const locale of LOCALES) expect(metaOf(locale).pages).toEqual(metaOf(DEFAULT_LOCALE).pages);
  });

  it.each(LOCALES.flatMap((locale) => pagesOf(locale).map((file) => [locale, file] as const)))('%s/%s has a title and a description', (locale, file) => {
    const fm = frontMatter(locale, file);
    expect(fm).toMatch(/^title: \S/m);
    expect(fm).toMatch(/^description: \S/m);
  });

  it('the docs messages have the same keys in every locale', () => {
    const keys = (o: object) => Object.keys(o).sort();
    expect(keys(frDocs)).toEqual(keys(enDocs));
    expect(keys(arDocs)).toEqual(keys(enDocs));
    for (const v of [...Object.values(enDocs), ...Object.values(frDocs), ...Object.values(arDocs)]) expect(v).not.toBe('');
  });
});

describe('remarkMermaid', () => {
  const run = (children: unknown[]) => {
    const tree = { type: 'root', children };
    remarkMermaid()(tree as never);
    return tree.children;
  };

  it('turns a mermaid fence into a Mermaid element carrying the diagram text', () => {
    const [node] = run([{ type: 'code', lang: 'mermaid', value: 'flowchart LR\n A-->B' }]);
    expect(node).toEqual({
      type: 'mdxJsxFlowElement',
      name: 'Mermaid',
      attributes: [{ type: 'mdxJsxAttribute', name: 'chart', value: 'flowchart LR\n A-->B' }],
      children: [],
    });
  });

  it('leaves other code fences alone, and finds a fence nested inside another node', () => {
    const other = { type: 'code', lang: 'ts', value: 'const x = 1' };
    const out = run([other, { type: 'blockquote', children: [{ type: 'code', lang: 'mermaid', value: 'x' }] }]);
    expect(out[0]).toBe(other);
    expect((out[1] as { children: { name: string }[] }).children[0]?.name).toBe('Mermaid');
  });
});
