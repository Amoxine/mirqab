// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { TreeContextProvider } from 'fumadocs-ui/contexts/tree';
import arDocs from '@/messages/ar/docs.json';
import enDocs from '@/messages/en/docs.json';
import frDocs from '@/messages/fr/docs.json';
import { docsI18nUI } from '@/lib/docs/ui-translations';
import { DocsDrawer } from './docs-drawer';
import { DocsProvider } from './docs-provider';
import { DocsNavbar, DocsSidebar } from './docs-sidebar';

afterEach(cleanup);

vi.mock('next/navigation', () => ({
  usePathname: () => '/docs/getting-started',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  useParams: () => ({}),
  useSearchParams: () => new URLSearchParams(),
}));
// The app's own theme and language controls have their own tests and need unrelated providers.
vi.mock('./docs-footer-actions', () => ({
  DocsFooterActions: () => (
    <button type="button" data-testid="footer-actions">
      {'a switch that comes first in the drawer'}
    </button>
  ),
}));
vi.mock('fumadocs-core/search/client', () => ({
  useDocsSearch: () => ({ search: '', setSearch: vi.fn(), query: { isLoading: false, data: 'empty' } }),
}));

const DOCS = { en: enDocs, fr: frDocs, ar: arDocs };
const TREE = {
  name: 'Documentation',
  children: [{ type: 'page' as const, name: 'Getting started', url: '/docs/getting-started' }],
};
/** Fumadocs' own English button names, which its i18n table cannot change. */
const FUMADOCS_ENGLISH = ['Open Sidebar', 'Collapse Sidebar', 'Open Search', 'Copy Text', 'Copied Text'];

/** The top bar's menu button: the drawer carries a second one, which is only visible while it is open. */
const barButton = (name: string) => {
  const bar = document.getElementById('nd-subnav');
  if (!bar) throw new Error('the top bar did not render');
  return within(bar).getByRole('button', { name });
};

/** The shell as the docs layout composes it, with a page beside it. */
function renderShell(locale: keyof typeof DOCS, { mobile }: { mobile: boolean }) {
  // Fumadocs switches between the desktop sidebar and the drawer on a media query.
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: mobile,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
  }));
  return render(
    <NextIntlClientProvider locale={locale} messages={{ docs: DOCS[locale] }}>
      <DocsProvider dir={locale === 'ar' ? 'rtl' : 'ltr'} i18n={docsI18nUI.provider(locale)}>
        <TreeContextProvider tree={TREE}>
          <DocsNavbar title={<span>{'MIRQAB'}</span>} url="/" brand="MIRQAB" />
          <main id="nd-docs-layout">
            <DocsSidebar title={<span>{'MIRQAB'}</span>} url="/" brand="MIRQAB" />
            <div id="nd-page">
              <button type="button">{'a control in the page'}</button>
            </div>
          </main>
          <DocsDrawer />
        </TreeContextProvider>
      </DocsProvider>
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe.each(['en', 'fr', 'ar'] as const)('docs shell in %s', (locale) => {
  const shell = DOCS[locale].shell;

  it('names every control in the reader\'s language, and none in Fumadocs\' English', () => {
    renderShell(locale, { mobile: false });

    expect(screen.getByRole('button', { name: shell.collapseSidebar })).toBeDefined();
    const names = [...document.body.querySelectorAll('[aria-label]')].map((element) => element.getAttribute('aria-label'));
    for (const english of FUMADOCS_ENGLISH) expect(names).not.toContain(english);
  });

  it('says the brand link goes back to the dashboard', () => {
    renderShell(locale, { mobile: false });

    // The sidebar's and the top bar's: one of them is hidden by CSS at any width.
    const links = screen.getAllByRole('link', { name: shell.backToDashboard.replace('{brand}', 'MIRQAB') });
    expect(links.map((link) => link.getAttribute('href'))).toEqual(['/', '/']);
  });

  it('names the mobile bar\'s buttons, with the menu button\'s name and state following the drawer', () => {
    renderShell(locale, { mobile: true });

    expect(barButton(shell.openSearch)).toBeDefined();
    const toggle = barButton(shell.openMenu);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.getAttribute('aria-controls')).toBe('nd-sidebar-mobile');

    fireEvent.click(toggle);
    const opened = screen.getAllByRole('button', { name: shell.closeMenu });
    expect(opened).toHaveLength(2);
    expect(opened.every((button) => button.getAttribute('aria-expanded') === 'true')).toBe(true);
    expect(screen.queryByRole('button', { name: shell.openMenu })).toBeNull();
  });
});

describe('the mobile docs menu', () => {
  const shell = DOCS.en.shell;
  const open = () => {
    renderShell('en', { mobile: true });
    const toggle = barButton(shell.openMenu);
    toggle.focus();
    fireEvent.click(toggle);
    return toggle;
  };

  it('is a dialog with a name, and holds focus while the page behind it is inert', async () => {
    open();

    const drawer = document.getElementById('nd-sidebar-mobile');
    expect(drawer?.getAttribute('role')).toBe('dialog');
    expect(drawer?.getAttribute('aria-modal')).toBe('true');
    expect(drawer?.getAttribute('aria-label')).toBe(shell.menu);
    // Focus lands on the drawer's close button, not on the switch that precedes it.
    await waitFor(() => {
      expect(drawer?.contains(document.activeElement)).toBe(true);
    });
    expect(document.activeElement?.getAttribute('aria-label')).toBe(shell.closeMenu);
    expect(document.getElementById('nd-page')?.hasAttribute('inert')).toBe(true);
    expect(document.getElementById('nd-subnav')?.hasAttribute('inert')).toBe(true);
  });

  it('closes on Escape, frees the page and gives focus back to the button that opened it', () => {
    const toggle = open();

    act(() => {
      fireEvent.keyDown(document, { key: 'Escape' });
    });

    expect(document.getElementById('nd-sidebar-mobile')?.getAttribute('data-state')).toBe('closed');
    expect(document.getElementById('nd-page')?.hasAttribute('inert')).toBe(false);
    expect(document.getElementById('nd-subnav')?.hasAttribute('inert')).toBe(false);
    expect(barButton(shell.openMenu)).toBe(toggle);
    expect(document.activeElement).toBe(toggle);
  });

  it('leaves other keys alone', () => {
    open();

    act(() => {
      fireEvent.keyDown(document, { key: 'a' });
    });

    expect(document.getElementById('nd-sidebar-mobile')?.getAttribute('data-state')).toBe('open');
  });
});
