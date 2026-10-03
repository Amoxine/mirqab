import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LOCALES } from '@/i18n/locales';
import arDocs from '@/messages/ar/docs.json';
import enDocs from '@/messages/en/docs.json';
import frDocs from '@/messages/fr/docs.json';
import { DOCS_ROUTES, DOCS_TARGETS, docsHelpFor, docsHref, TROUBLESHOOTING_ANALYTICS } from './contextual';
import { CONTENT, renderedHeadingIds, ROOT } from './test-utils';

const DOCS_MESSAGES = { en: enDocs, fr: frDocs, ar: arDocs };

describe('docsHelpFor', () => {
  it.each([
    ['/apis', 'apis-and-openapi-import'],
    ['/apis/3f1f7a7e-0a53-4a43-9d7e-2b0c1a4c9e11', 'apis-and-openapi-import'],
    ['/keys', 'keys-and-plans'],
    ['/keys/key-001', 'keys-and-plans'],
    ['/plans', 'keys-and-plans'],
    ['/products', 'keys-and-plans'],
    ['/analytics', 'analytics-and-traffic'],
    ['/analytics/traffic', 'analytics-and-traffic'],
    ['/analytics/search', 'searching-traffic'],
    ['/audit-logs', 'roles-audit-tenants'],
    ['/tenants', 'roles-audit-tenants'],
    ['/tenants/t-1', 'roles-audit-tenants'],
    ['/settings/roles', 'roles-audit-tenants'],
    ['/keys/', 'keys-and-plans'],
  ])('maps %s to the %s page', (pathname, slug) => {
    expect(docsHelpFor(pathname)).toEqual({ slug });
  });

  // `/portal` is a separate sign-in domain and `/docs` needs the dashboard's session, so a portal
  // developer who followed a help link would be sent into the dashboard's sign-in flow: no help link there.
  it.each([
    '/',
    '/settings',
    '/settings/certificates',
    '/auth/login',
    '/portal',
    '/portal/applications',
    '/portal/products/p-1',
    '/docs/getting-started',
    '/keys/key-001/rotate',
    '/apis/1/endpoints/2',
    '/nope',
    '',
  ])('has no help for %j', (pathname) => {
    expect(docsHelpFor(pathname)).toBeUndefined();
  });

  it('has none when the router has no pathname yet', () => {
    expect(docsHelpFor(null)).toBeUndefined();
  });
});

describe('docsHref', () => {
  it('points at the docs page, with the heading id when there is one', () => {
    expect(docsHref({ slug: 'keys-and-plans' })).toBe('/docs/keys-and-plans');
    expect(docsHref(TROUBLESHOOTING_ANALYTICS)).toBe('/docs/troubleshooting#analytics');
  });
});

describe('every target exists in every language', () => {
  it('lists each mapped page and the troubleshooting anchor', () => {
    expect(DOCS_TARGETS.length).toBeGreaterThanOrEqual(6);
    expect(DOCS_TARGETS).toContainEqual(TROUBLESHOOTING_ANALYTICS);
  });

  it.each(DOCS_TARGETS.flatMap((target) => LOCALES.map((locale) => [target.slug, locale] as const)))(
    '%s has a page in %s',
    (slug, locale) => {
      expect(existsSync(join(CONTENT, locale, `${slug}.mdx`)), `content/docs/${locale}/${slug}.mdx`).toBe(true);
    },
  );

  it.each(LOCALES)('every mapped page has its topic name in %s', (locale) => {
    const topics = DOCS_MESSAGES[locale].help.topics as Record<string, string>;
    for (const { slug } of DOCS_ROUTES.map((route) => route.help)) {
      expect(topics[slug], `${locale} docs.help.topics.${slug}`).toBeTruthy();
    }
  });

  it('every mapped route is a page of the dashboard', () => {
    for (const { route } of DOCS_ROUTES) {
      expect(existsSync(join(ROOT, 'src/app/(dashboard)', route, 'page.tsx')), `app/(dashboard)${route}/page.tsx`).toBe(true);
    }
  });

  it.each(LOCALES)('the troubleshooting anchor is a heading id in %s', async (locale) => {
    const anchors = DOCS_TARGETS.filter((target) => target.anchor).map((target) => [target.slug, target.anchor] as const);
    expect(anchors.length).toBeGreaterThanOrEqual(1);
    for (const [slug, anchor] of anchors) {
      expect(await renderedHeadingIds(locale, slug), `${locale}/${slug} has no heading #${String(anchor)}`).toContain(anchor);
    }
  });
});
