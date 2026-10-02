import { describe, expect, it, vi } from 'vitest';

vi.mock('next/font/google', () => ({
  Inter: () => ({ variable: 'font-inter' }),
  IBM_Plex_Mono: () => ({ variable: 'font-plex-mono' }),
}));
let locale = 'en';
vi.mock('next-intl/server', () => ({
  getLocale: () => Promise.resolve(locale),
  // Echo `namespace.key` so the assertions prove which message each field is read from.
  getTranslations: (namespace: string) => Promise.resolve((key: string) => `${namespace}.${key}`),
}));
vi.mock('next/headers', () => ({ cookies: () => Promise.resolve({ get: () => undefined }) }));
vi.mock('@/components/providers', () => ({ Providers: () => null }));

import { generateMetadata } from './layout';

describe('root layout metadata', () => {
  it('reads title and description from the nav messages, in every share surface', async () => {
    const meta = await generateMetadata();
    const title = 'nav.brand - nav.brandCaption';
    const description = 'nav.brandDescription';

    expect(meta.title).toEqual({ default: title, template: '%s | nav.brand' });
    expect(meta.description).toBe(description);
    // No English "<brand> Team" byline: it would be untranslated on the French and Arabic pages.
    expect(meta.authors).toBeUndefined();
    expect(meta.openGraph).toMatchObject({ title, description });
    expect(meta.twitter).toMatchObject({ title, description });
  });

  it.each([
    ['en', 'en_US'],
    ['fr', 'fr_FR'],
    ['ar', 'ar_AR'],
  ])('advertises %s pages as %s to link previews', async (active, ogLocale) => {
    locale = active;
    expect((await generateMetadata()).openGraph).toMatchObject({ locale: ogLocale });
  });
});
