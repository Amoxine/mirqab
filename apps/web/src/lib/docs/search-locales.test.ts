import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createFromSource, type SearchAPI } from 'fumadocs-core/search/server';
import { loader } from 'fumadocs-core/source';
import { describe, expect, it } from 'vitest';
import { createArabicTokenizer } from './arabic';
import { docsI18n } from './i18n';
import { docsSearchLocaleMap } from './search-locales';

/**
 * The docs search index, built the way `app/docs/search-index/route.ts` builds it (`createFromSource` with the
 * locale map), over a few pages in memory: the real pages are MDX modules that only Next compiles, but the part
 * that broke is the index's configuration, not the pages. The route's `GET` answers `?query=&locale=` from the
 * same `search` function.
 */

interface Page {
  title: string;
  description: string;
  text: string;
}

const PAGES: Record<string, Record<string, Page>> = {
  en: { 'index.mdx': { title: 'Searching traffic', description: 'Find requests', text: 'The documentation explains how a request is found by its status.' } },
  fr: { 'index.mdx': { title: 'Recherche de trafic', description: 'Retrouver des requêtes', text: 'La documentation explique comment une requête est retrouvée par son statut.' } },
  ar: {
    // `وثائق` and `طلب` are written without the article here; people search for `الوثائق` and `الطلب`.
    'index.mdx': { title: 'البحث في الطلبات', description: 'ابحث عن طلب', text: 'وثائق المنصة تشرح مسار طلب واحد عبر البوابة.' },
    'keys.mdx': { title: 'المفاتيح', description: 'إدارة', text: 'المِفْتَاح الجديد للتطبيق' },
  },
};

function fakeSource() {
  const files = Object.entries(PAGES).flatMap(([locale, pages]) =>
    Object.entries(pages).map(([file, page]) => ({
      type: 'page' as const,
      path: `${locale}/${file}`,
      data: {
        title: page.title,
        description: page.description,
        structuredData: { headings: [], contents: [{ heading: undefined, content: page.text }] },
      },
    })),
  );
  return loader({ baseUrl: '/docs', i18n: docsI18n, source: { files } });
}

const hits = async (api: SearchAPI, locale: string, query: string) => {
  const response = await api.GET(new Request(`http://localhost/docs/search-index?locale=${locale}&query=${encodeURIComponent(query)}`));
  expect(response.status).toBe(200);
  return (await response.json()) as { id: string; url: string; content: string }[];
};

describe('the docs search index, as the route builds it', () => {
  const api = createFromSource(fakeSource(), { localeMap: docsSearchLocaleMap });

  it.each([
    ['الوثائق', 'the page says وثائق, the person types the article too'],
    ['الطلب', 'the page says طلب'],
    ['طلب', 'without the article'],
    ['المفتاح', 'the page has diacritics: المِفْتَاح'],
  ])('Arabic finds %s (%s)', async (query) => {
    expect((await hits(api, 'ar', query)).length).toBeGreaterThan(0);
  });

  it('English and French still find their pages, and each language sees only its own', async () => {
    expect((await hits(api, 'en', 'documentation')).length).toBeGreaterThan(0);
    expect((await hits(api, 'fr', 'documentation')).length).toBeGreaterThan(0);
    expect((await hits(api, 'ar', 'documentation')).length).toBe(0);
    expect((await hits(api, 'en', 'الوثائق')).length).toBe(0);
  });

  it('serves a hit as a page address without a locale prefix', async () => {
    const [first] = await hits(api, 'ar', 'الطلب');
    expect(first?.url).toMatch(/^\/docs(\/|$)/);
    expect(first?.url).not.toMatch(/\/ar(\/|$)/);
  });

  it('is the map the route uses: the route does not carry a locale map of its own', () => {
    const route = readFileSync(join(__dirname, '../../app/docs/search-index/route.ts'), 'utf8');
    expect(route).toContain('localeMap: docsSearchLocaleMap');
    expect(route).not.toMatch(/language:\s*'/);
  });

  it('gives Arabic a tokenizer and NO language: the pair is what made the index fail to build', () => {
    expect(docsSearchLocaleMap.ar).toHaveProperty('tokenizer');
    expect(docsSearchLocaleMap.ar).not.toHaveProperty('language');
    expect(docsSearchLocaleMap.en).toEqual({ language: 'english' });
    expect(docsSearchLocaleMap.fr).toEqual({ language: 'french' });
  });
});

describe('what the locale map must never become again', () => {
  it('a language next to the custom tokenizer does not build: Orama refuses the pair, in Arabic only', async () => {
    const broken = createFromSource(fakeSource(), {
      localeMap: { ...docsSearchLocaleMap, ar: { language: 'arabic', tokenizer: createArabicTokenizer() } },
    });
    // English still works: the failure is the Arabic index, which is why it went unnoticed.
    expect((await hits(broken, 'en', 'documentation')).length).toBeGreaterThan(0);
    await expect(
      broken.GET(new Request('http://localhost/docs/search-index?locale=ar&query=%D8%A7%D9%84%D9%88%D8%AB%D8%A7%D8%A6%D9%82')),
    ).rejects.toThrow(/NO_LANGUAGE_WITH_CUSTOM_TOKENIZER|custom tokenizer/i);
  });

  it('Orama\'s stock Arabic (no tokenizer of ours) does not find a word typed with its article', async () => {
    const stock = createFromSource(fakeSource(), { localeMap: { ...docsSearchLocaleMap, ar: { language: 'arabic' } } });
    expect((await hits(stock, 'ar', 'الوثائق')).length).toBe(0);
  });
});
