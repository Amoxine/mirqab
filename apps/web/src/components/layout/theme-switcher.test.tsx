// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enCommon from '@/messages/en/common.json';
import frCommon from '@/messages/fr/common.json';
import arCommon from '@/messages/ar/common.json';
import { ThemeSwitcher } from './theme-switcher';

const setTheme = vi.fn();
vi.mock('next-themes', () => ({ useTheme: () => ({ theme: 'system', setTheme }) }));

function renderIn(locale: 'en' | 'ar', common: typeof enCommon) {
  render(
    <NextIntlClientProvider locale={locale} messages={{ common }}>
      <div dir={locale === 'ar' ? 'rtl' : 'ltr'}>
        <ThemeSwitcher />
      </div>
    </NextIntlClientProvider>,
  );
}

describe('ThemeSwitcher', () => {
  it('offers light / dark / system, marks the current pick, and applies a new one', async () => {
    renderIn('en', enCommon);
    fireEvent.keyDown(screen.getByRole('button', { name: 'Theme' }), { key: 'Enter' });

    const options = await screen.findAllByRole('menuitemradio');
    expect(options.map((o) => o.textContent)).toEqual(['Light', 'Dark', 'System']);
    expect(screen.getByRole('menuitemradio', { name: 'System' }).getAttribute('aria-checked')).toBe('true');

    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Dark' }));
    expect(setTheme).toHaveBeenCalledWith('dark');
  });

  it('is labelled in Arabic under RTL', async () => {
    renderIn('ar', arCommon);
    fireEvent.keyDown(screen.getByRole('button', { name: arCommon.themeSwitcher.label }), { key: 'Enter' });
    expect(await screen.findByRole('menuitemradio', { name: arCommon.themeSwitcher.dark })).toBeTruthy();
  });

  it('has the same keys in every locale', () => {
    const keys = Object.keys(enCommon.themeSwitcher);
    expect(Object.keys(frCommon.themeSwitcher)).toEqual(keys);
    expect(Object.keys(arCommon.themeSwitcher)).toEqual(keys);
  });
});
