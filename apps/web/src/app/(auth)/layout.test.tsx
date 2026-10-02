// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import arNav from '@/messages/ar/nav.json';
import enNav from '@/messages/en/nav.json';
import frNav from '@/messages/fr/nav.json';
import AuthLayout from './layout';

afterEach(cleanup);

const LOCALES = { en: { nav: enNav }, fr: { nav: frNav }, ar: { nav: arNav } };
let locale: keyof typeof LOCALES = 'en';
vi.mock('next-intl/server', () => ({
  getTranslations: (namespace: 'nav') =>
    Promise.resolve(createTranslator({ locale, messages: LOCALES[locale], namespace })),
}));
// The language and theme switchers are client components with their own tests; they carry no brand.
vi.mock('@/components/layout/locale-switcher', () => ({ LocaleSwitcher: () => null }));
vi.mock('@/components/layout/theme-switcher', () => ({ ThemeSwitcher: () => null }));

describe('AuthLayout', () => {
  it.each(['en', 'fr', 'ar'] as const)(
    'puts the logo, named after the brand, in the one h1 above the form in %s',
    async (lang) => {
      locale = lang;
      render(await AuthLayout({ children: <p>{'sign-in form'}</p> }));

      const name = LOCALES[lang].nav.brand;
      expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
      const heading = screen.getByRole('heading', { level: 1, name });
      expect(heading.contains(screen.getByRole('img', { name }))).toBe(true);

      // The children are there, and are the only text on the page: the brand is not printed.
      expect(screen.getByText('sign-in form')).toBeDefined();
      expect(document.body.textContent).toBe('sign-in form');
    },
  );
});
