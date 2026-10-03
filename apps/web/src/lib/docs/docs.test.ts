import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_LOCALE, LOCALES } from '@/i18n/locales';
import enDocs from '@/messages/en/docs.json';
import frDocs from '@/messages/fr/docs.json';
import arDocs from '@/messages/ar/docs.json';
import { docsI18n } from './i18n';
import { remarkMermaid } from './remark-mermaid';
import { renderedHeadingIds } from './test-utils';

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

describe('internal links', () => {
  const slugsOf = (locale: string) => new Set(pagesOf(locale).map((f) => f.replace(/\.mdx$/, '')));
  const linksOf = (locale: string, file: string): string[] =>
    [...readFileSync(join(CONTENT, locale, file), 'utf8').matchAll(/\]\((\/docs[^)\s]*)\)/g)].map((m) => String(m[1]));

  it.each(LOCALES.flatMap((locale) => pagesOf(locale).map((file) => [locale, file] as const)))(
    '%s/%s links only to pages that exist',
    (locale, file) => {
      const known = slugsOf(DEFAULT_LOCALE); // a link may point at any English page: a missing translation falls back to it
      for (const link of linksOf(locale, file)) {
        const path = link.split('#')[0] ?? '';
        if (path === '/docs') continue;
        expect(path.startsWith('/docs/'), `${link} is not under /docs/`).toBe(true);
        expect(known.has(path.slice('/docs/'.length)), `${locale}/${file} links to ${link}, which has no page`).toBe(true);
      }
    },
  );

  it('every page is reachable: listed in the sidebar of each language', () => {
    for (const locale of LOCALES) {
      const listed = new Set(metaOf(locale).pages);
      for (const slug of slugsOf(locale)) expect(listed.has(slug), `${locale}/${slug} is not in meta.json`).toBe(true);
    }
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

const PAGES = LOCALES.flatMap((locale) => pagesOf(locale).map((file) => [locale, file] as const));
const textOf = (locale: string, file: string) => readFileSync(join(CONTENT, locale, file), 'utf8');

describe('front matter and sidebar', () => {
  it.each(LOCALES)('%s: every sidebar entry is a page that exists', (locale) => {
    for (const entry of metaOf(locale).pages) {
      expect(existsSync(join(CONTENT, DEFAULT_LOCALE, `${entry}.mdx`)), `${locale}/meta.json lists "${entry}", which has no page`).toBe(true);
    }
  });

  it.each(PAGES)('%s/%s has a title and a description that are not just quotes', (locale, file) => {
    const fm = frontMatter(locale, file);
    for (const field of ['title', 'description']) {
      const value = new RegExp(`^${field}:(.*)$`, 'm').exec(fm)?.[1] ?? '';
      expect(value.replace(/["'\s]/g, ''), `${locale}/${file}: empty ${field}`).not.toBe('');
    }
  });
});

describe('links to a heading', () => {
  const FRAGMENT_LINK = /\]\((\/docs\/[^)#\s]*)?#([^)\s]+)\)/g;

  it.each(PAGES)('%s/%s: every #fragment link names a heading that page has, in this language', async (locale, file) => {
    for (const [, path, fragment] of textOf(locale, file).matchAll(FRAGMENT_LINK)) {
      const slug = path ? path.slice('/docs/'.length) : file.replace(/\.mdx$/, '');
      const inLocale = existsSync(join(CONTENT, locale, `${slug}.mdx`)) ? locale : DEFAULT_LOCALE;
      expect(await renderedHeadingIds(inLocale, slug), `${locale}/${file} links to ${path ?? ''}#${String(fragment)}, which has no such heading in ${inLocale}`).toContain(fragment);
    }
  });
});

/** Each page ends with the commit its text was checked against, in the page's language. */
describe('verified-against line', () => {
  const VERIFIED: Record<(typeof LOCALES)[number], RegExp> = {
    en: /^Verified against commit ([0-9a-f]{7,40})\.$/,
    fr: /^Vérifié par rapport au commit ([0-9a-f]{7,40})\.$/,
    ar: /^تم التحقق منه مقابل الإيداع ([0-9a-f]{7,40})\.$/,
  };
  const checked = PAGES;

  it.each(checked)('%s/%s ends with it', (locale, file) => {
    const last = textOf(locale, file).trimEnd().split('\n').at(-1) ?? '';
    expect(last, `${locale}/${file}: last line`).toMatch(VERIFIED[locale]);
  });

  it('names one commit across every page and language', () => {
    const commits = new Set(
      checked.map(([locale, file]) => VERIFIED[locale].exec(textOf(locale, file).trimEnd().split('\n').at(-1) ?? '')?.[1]),
    );
    expect([...commits]).toHaveLength(1);
  });
});

/** The text outside front matter and code fences, with line numbers. */
function proseLines(text: string): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  let fenced = false;
  let front = text.startsWith('---');
  text.split('\n').forEach((raw, index) => {
    if (front) {
      if (index > 0 && raw === '---') front = false;
      return;
    }
    if (raw.startsWith('```')) fenced = !fenced;
    else if (!fenced && raw.trim() !== '' && !/^\|[-| :]+\|$/.test(raw.trim())) out.push({ line: index + 1, text: raw });
  });
  return out;
}

/** What a translation must keep from the English page: headings per level, link targets, code blocks. */
function skeleton(text: string) {
  const headings: Record<string, number> = {};
  for (const { text: line } of proseLines(text)) {
    const level = /^(#{1,6}) /.exec(line)?.[1];
    if (level) headings[level] = (headings[level] ?? 0) + 1;
  }
  const links = [...text.matchAll(/\]\(([^)\s]+)\)/g)].map((match) => String(match[1])).sort();
  const fences = [...text.matchAll(/^```(\S*)\n([\s\S]*?)^```/gm)].map((match) => ({
    lang: match[1],
    // A diagram's labels are translated; every other block (commands, search syntax) is the same in every language.
    body: match[1] === 'mermaid' ? '' : match[2],
  }));
  return { headings, links, fences };
}

describe('translations follow the English page', () => {
  const TRANSLATED = PAGES.filter(([locale]) => locale !== DEFAULT_LOCALE);

  it.each(TRANSLATED)('%s/%s has the English page\'s headings, links and code blocks', (locale, file) => {
    expect(skeleton(textOf(locale, file)), `${locale}/${file}`).toEqual(skeleton(textOf(DEFAULT_LOCALE, file)));
  });

  // Words that are English and nothing else in French or Arabic prose.
  const ENGLISH = new Set('the and with your you is are of to in for that this it not from when which will can has have by at be'.split(' '));
  /** Lines that may stay English on purpose: `locale/file:line-text-prefix`. Empty by default; every entry needs a reason. */
  const ALLOWED = new Set<string>([]);
  // Code, link targets and URLs are the same in every language, and so are all-capitals words (GET, JWT, HTTP).
  const withoutCode = (line: string) =>
    line.replace(/`[^`]*`/g, ' ').replace(/\]\([^)]*\)/g, ']').replace(/https?:\/\/\S+/g, ' ').replace(/\b[A-Z][A-Z0-9]+\b/g, ' ');

  it.each(TRANSLATED)('%s/%s has no paragraph left in English', (locale, file) => {
    const left = proseLines(textOf(locale, file)).filter(({ text }) => {
      const plain = withoutCode(text);
      if (ALLOWED.has(`${locale}/${file}:${text.slice(0, 40)}`)) return false;
      if (locale === 'ar') {
        const latin = (plain.match(/[A-Za-z]/g) ?? []).length;
        const arabic = (plain.match(/[\u0600-\u06FF]/g) ?? []).length;
        return latin + arabic >= 12 && latin / (latin + arabic) > 0.5;
      }
      return plain.toLowerCase().split(/[^a-z']+/).filter((word) => ENGLISH.has(word)).length >= 3;
    });
    expect(left.map(({ line, text }) => `${locale}/${file}:${String(line)} ${text.slice(0, 60)}`)).toEqual([]);
  });
});

describe('diagram direction', () => {
  const FENCE = /```mermaid\nflowchart (\w+)\n/g;
  const directions = (locale: string, file: string) => [...textOf(locale, file).matchAll(FENCE)].map((match) => match[1]);

  it.each(PAGES)('%s/%s flows the way its language reads', (locale, file) => {
    const expected = locale === 'ar' ? 'RL' : 'LR';
    expect(directions(locale, file)).toEqual(directions(DEFAULT_LOCALE, file).map(() => expected));
  });
});

describe('text that stays English in every language', () => {
  // The gateway answers in English whatever the dashboard's language, and keycaps are printed in English.
  const LITERALS: [string, string][] = [
    ['keys-and-plans.mdx', '**Quota exceeded**'],
    ['troubleshooting.mdx', '**Quota exceeded**'],
    ['searching-traffic.mdx', '**Backspace**'],
    ['roles-audit-tenants.mdx', '`QUOTA_UPDATED`'],
  ];

  it.each(LOCALES.flatMap((locale) => LITERALS.map(([file, literal]) => [locale, file, literal] as const)))(
    '%s/%s keeps %s',
    (locale, file, literal) => {
      expect(textOf(locale, file)).toContain(literal);
    },
  );
});

