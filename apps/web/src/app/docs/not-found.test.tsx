// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import arDocs from '@/messages/ar/docs.json';
import enDocs from '@/messages/en/docs.json';
import frDocs from '@/messages/fr/docs.json';
import DocsNotFound from './not-found';

afterEach(cleanup);

const DOCS = { en: enDocs, fr: frDocs, ar: arDocs };
let locale: keyof typeof DOCS = 'en';
vi.mock('next-intl/server', () => ({
  getTranslations: (namespace: 'docs.notFound') =>
    Promise.resolve(createTranslator({ locale, messages: { docs: DOCS[locale] }, namespace })),
}));

describe('docs not-found page', () => {
  it.each(['en', 'fr', 'ar'] as const)('says so in %s and links back to the docs home', async (lang) => {
    locale = lang;
    render(await DocsNotFound());

    const text = DOCS[lang].notFound;
    expect(screen.getByRole('heading', { level: 1, name: text.title })).toBeDefined();
    expect(screen.getByText(text.description)).toBeDefined();
    expect(screen.getByRole('link', { name: text.home }).getAttribute('href')).toBe('/docs');
  });
});
