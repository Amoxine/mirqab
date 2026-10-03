// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import arDocs from '@/messages/ar/docs.json';
import enDocs from '@/messages/en/docs.json';
import frDocs from '@/messages/fr/docs.json';
import { docsI18nUI } from '@/lib/docs/ui-translations';
import { DocsPre } from './docs-pre';
import { DocsProvider } from './docs-provider';

afterEach(cleanup);

vi.mock('next/navigation', () => ({
  usePathname: () => '/docs/getting-started',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  useParams: () => ({}),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('fumadocs-core/search/client', () => ({
  useDocsSearch: () => ({ search: '', setSearch: vi.fn(), query: { isLoading: false, data: 'empty' } }),
}));

const DOCS = { en: enDocs, fr: frDocs, ar: arDocs };

function renderDocs(locale: keyof typeof DOCS, children: React.ReactNode) {
  return render(
    <NextIntlClientProvider locale={locale} messages={{ docs: DOCS[locale] }}>
      <DocsProvider dir={locale === 'ar' ? 'rtl' : 'ltr'} i18n={docsI18nUI.provider(locale)}>
        {children}
      </DocsProvider>
    </NextIntlClientProvider>,
  );
}

describe.each(['en', 'fr', 'ar'] as const)('a code block in %s', (locale) => {
  const shell = DOCS[locale].shell;
  const writeText = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve());

  beforeEach(() => {
    writeText.mockClear();
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  });

  afterEach(() => {
    Reflect.deleteProperty(navigator, 'clipboard');
  });

  it('has a copy button named in the reader\'s language, which copies the code and says it did', async () => {
    renderDocs(
      locale,
      <DocsPre>
        <code>{'curl -i https://example.test/'}</code>
      </DocsPre>,
    );

    expect(screen.queryByRole('button', { name: 'Copy Text' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: shell.copyCode }));

    expect(writeText).toHaveBeenCalledExactlyOnceWith('curl -i https://example.test/');
    expect(await screen.findByRole('button', { name: shell.codeCopied })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Copied Text' })).toBeNull();
  });

  it('does not say "copied" when the clipboard refuses, and logs why', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    writeText.mockRejectedValueOnce(new Error('denied'));
    renderDocs(
      locale,
      <DocsPre>
        <code>{'curl -i https://example.test/'}</code>
      </DocsPre>,
    );

    fireEvent.click(screen.getByRole('button', { name: shell.copyCode }));

    await waitFor(() => {
      expect(error).toHaveBeenCalledOnce();
    });
    expect(screen.queryByRole('button', { name: shell.codeCopied })).toBeNull();
    error.mockRestore();
  });
});

describe.each(['en', 'fr', 'ar'] as const)('the docs search in %s', (locale) => {
  const shell = DOCS[locale].shell;
  const press = (init: KeyboardEventInit) => {
    act(() => {
      fireEvent.keyDown(window, init);
    });
  };

  it('opens on Ctrl+K by the physical key, so a non-Latin layout can use it', () => {
    renderDocs(locale, <p>{'page'}</p>);
    expect(screen.queryByRole('dialog')).toBeNull();

    // On an Arabic layout the K key types "ل": `key` is never "k", `code` is still "KeyK".
    press({ key: 'ل', code: 'KeyK', ctrlKey: true });

    expect(screen.getByRole('dialog')).toBeDefined();
  });

  it('ignores K alone and other shortcuts', () => {
    renderDocs(locale, <p>{'page'}</p>);

    press({ key: 'k', code: 'KeyK' });
    press({ key: 'j', code: 'KeyJ', ctrlKey: true });

    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes with a button in the reader\'s language, not Fumadocs\' "ESC"', () => {
    renderDocs(locale, <p>{'page'}</p>);
    press({ key: 'k', code: 'KeyK', metaKey: true });

    const close = screen.getByRole('button', { name: shell.closeSearch });
    expect(screen.queryByText('ESC')).toBeNull();

    fireEvent.click(close);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
