// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import arDocs from '@/messages/ar/docs.json';
import enDocs from '@/messages/en/docs.json';
import frDocs from '@/messages/fr/docs.json';
import Page from './page';

afterEach(cleanup);

const DOCS = { en: enDocs, fr: frDocs, ar: arDocs };
let locale: keyof typeof DOCS = 'fr';
let pagePath = 'fr/getting-started.mdx';

vi.mock('@/lib/docs/source', () => ({
  source: {
    getPage: () => ({
      path: pagePath,
      data: { title: 'A title', description: 'A description', toc: [], body: () => <p>{'the body'}</p> },
    }),
  },
}));
vi.mock('fumadocs-ui/page', () => ({
  DocsPage: ({ children }: { children: React.ReactNode }) => <article>{children}</article>,
  DocsTitle: ({ children }: { children: React.ReactNode }) => <h1>{children}</h1>,
  DocsDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DocsBody: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));
vi.mock('@/components/docs/mdx-components', () => ({ getMDXComponents: () => ({}) }));
vi.mock('next-intl/server', () => ({
  getLocale: () => Promise.resolve(locale),
  getTranslations: (namespace: 'docs') =>
    Promise.resolve(createTranslator({ locale, messages: { docs: DOCS[locale] }, namespace })),
}));

const renderPage = async () => render(await Page({ params: Promise.resolve({ slug: ['getting-started'] }) }));

describe('docs page', () => {
  it.each(['fr', 'ar'] as const)(
    'marks a page served from the English fallback as English, left to right, in %s',
    async (lang) => {
      locale = lang;
      pagePath = 'en/getting-started.mdx';
      await renderPage();

      const english = [...document.querySelectorAll('[lang="en"]')];
      expect(english.length).toBeGreaterThan(0);
      expect(english.every((element) => element.getAttribute('dir') === 'ltr')).toBe(true);
      // The title, description and body are the English text, so all of them sit inside...
      const text = english.map((element) => element.textContent).join(' ');
      for (const part of ['A title', 'A description', 'the body']) expect(text).toContain(part);
      // ...but the notice that says so is in the reader's language, outside.
      const notice = screen.getByTestId('docs-not-translated');
      expect(notice.textContent).toBe(DOCS[lang].notTranslated);
      expect(english.some((element) => element.contains(notice))).toBe(false);
    },
  );

  it('adds no English wrapper to a page that has been translated', async () => {
    locale = 'fr';
    pagePath = 'fr/getting-started.mdx';
    await renderPage();

    expect(document.querySelector('[lang="en"]')).toBeNull();
    expect(screen.queryByTestId('docs-not-translated')).toBeNull();
  });
});
