// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import arDocs from '@/messages/ar/docs.json';
import enDocs from '@/messages/en/docs.json';
import frDocs from '@/messages/fr/docs.json';
import { PageHeader } from './page-header';

afterEach(cleanup);

let pathname: string | null = null;
vi.mock('next/navigation', () => ({ usePathname: () => pathname }));

const DOCS = { en: enDocs, fr: frDocs, ar: arDocs };

function renderHeader(
  path: string | null,
  props: Partial<React.ComponentProps<typeof PageHeader>> = {},
  locale: keyof typeof DOCS = 'en',
) {
  pathname = path;
  return render(
    <NextIntlClientProvider locale={locale} messages={{ docs: DOCS[locale] }}>
      <PageHeader title="Page title" {...props} />
    </NextIntlClientProvider>,
  );
}

describe('PageHeader help link', () => {
  it.each([
    ['en', 'Help: Keys and plans', 'Help'],
    ['fr', 'Aide : Clés et forfaits', 'Aide'],
    ['ar', 'مساعدة: المفاتيح والخطط', 'مساعدة'],
  ] as const)('links a documented page to its docs page in %s, named after the topic', (locale, name, label) => {
    renderHeader('/keys/key-001', {}, locale);

    const link = screen.getByRole('link', { name });
    expect(link.getAttribute('href')).toBe('/docs/keys-and-plans');
    // The visible word is the start of the accessible name (WCAG 2.5.3, label in name).
    expect(link.textContent).toBe(label);
    expect(name.startsWith(label)).toBe(true);
  });

  it('names each route by its own docs topic', () => {
    renderHeader('/analytics/search');
    expect(screen.getByRole('link', { name: 'Help: Searching traffic' }).getAttribute('href')).toBe(
      '/docs/searching-traffic',
    );
  });

  it.each(['/settings', '/settings/certificates', '/portal', '/docs/keys-and-plans', null])(
    'shows no help link on %s, where no docs page explains the page',
    (path) => {
      renderHeader(path, { actions: <button type="button">{'Create'}</button> });
      expect(screen.queryByRole('link')).toBeNull();
      expect(screen.getByRole('button', { name: 'Create' })).toBeDefined();
    },
  );

  it('lets a page opt out with help={false}', () => {
    renderHeader('/keys', { help: false });
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('keeps the page header as it was: title, description, back link and its own actions, help first', () => {
    renderHeader('/keys/key-001', {
      title: 'Partner key',
      description: 'All about it',
      back: { href: '/keys', label: 'Back to keys' },
      actions: <button type="button">{'Edit'}</button>,
    });

    expect(screen.getByRole('heading', { level: 1, name: 'Partner key' })).toBeDefined();
    expect(screen.getByText('All about it')).toBeDefined();
    expect(screen.getByRole('link', { name: 'Back to keys' }).getAttribute('href')).toBe('/keys');
    const actions = screen.getByRole('button', { name: 'Edit' }).parentElement;
    expect(actions?.contains(screen.getByRole('link', { name: 'Help: Keys and plans' }))).toBe(true);
    // The help link leads, so the page's own primary action stays at the end of the row.
    expect(actions?.firstElementChild?.textContent).toBe('Help');
  });

  it('puts the help link in the actions row, which wraps, and adds no fixed width', () => {
    renderHeader('/plans');
    const link = screen.getByRole('link', { name: 'Help: Keys and plans' });
    expect(link.parentElement?.className).toMatch(/(^|\s)flex-wrap(\s|$)/);
    expect(link.className).not.toMatch(/(^|\s)(w|min-w)-/);
  });
});
