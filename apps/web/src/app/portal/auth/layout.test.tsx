// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import arNav from '@/messages/ar/nav.json';
import arPortal from '@/messages/ar/portal.json';
import enNav from '@/messages/en/nav.json';
import enPortal from '@/messages/en/portal.json';
import frNav from '@/messages/fr/nav.json';
import frPortal from '@/messages/fr/portal.json';
import PortalAuthLayout from './layout';

afterEach(cleanup);

const LOCALES = {
  en: { nav: enNav, portal: enPortal },
  fr: { nav: frNav, portal: frPortal },
  ar: { nav: arNav, portal: arPortal },
};
let locale: keyof typeof LOCALES = 'en';
vi.mock('next-intl/server', () => ({
  getTranslations: (namespace: 'nav' | 'portal') =>
    Promise.resolve(createTranslator({ locale, messages: LOCALES[locale], namespace })),
}));

describe('PortalAuthLayout', () => {
  it.each([
    ['en', 'MIRQAB Developer Portal'],
    ['fr', 'Portail développeur MIRQAB'],
    ['ar', 'بوابة المطورين MIRQAB'],
  ] as const)('names the logo with the brand and the portal in %s, so the page still says which portal this is', async (lang, name) => {
    locale = lang;
    render(await PortalAuthLayout({ children: <p>{'sign-in form'}</p> }));

    expect(screen.getByRole('heading', { level: 1, name })).toBeDefined();
    expect(screen.getByRole('img', { name })).toBeDefined();
    expect(screen.getByText('sign-in form')).toBeDefined();
    // The header's "Developer Portal" text is what the logo replaces: no visible brand text here.
    expect(screen.queryByText(LOCALES[lang].portal.brand)).toBeNull();
  });
});
