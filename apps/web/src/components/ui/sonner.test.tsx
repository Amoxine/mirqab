// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import arDashboard from '@/messages/ar/dashboard.json';
import enDashboard from '@/messages/en/dashboard.json';
import frDashboard from '@/messages/fr/dashboard.json';
import { Toaster } from './sonner';

vi.mock('next-themes', () => ({ useTheme: () => ({ theme: 'light' }) }));

afterEach(cleanup);

const DASHBOARD = { en: enDashboard, fr: frDashboard, ar: arDashboard };

describe('Toaster', () => {
  it.each(['en', 'fr', 'ar'] as const)('names its notification region in %s', (locale) => {
    const { container } = render(
      <NextIntlClientProvider locale={locale} messages={{ dashboard: DASHBOARD[locale] }}>
        <Toaster />
      </NextIntlClientProvider>,
    );

    const region = container.ownerDocument.querySelector('section[aria-live="polite"]');
    // Sonner appends the key combination that focuses the region ("alt+T"); the words come from the messages.
    expect(region?.getAttribute('aria-label')).toBe(`${DASHBOARD[locale].notifications.label} alt+T`);
  });

  it('does not leave Sonner\'s English "Notifications" on an Arabic page', () => {
    const { container } = render(
      <NextIntlClientProvider locale="ar" messages={{ dashboard: arDashboard }}>
        <Toaster />
      </NextIntlClientProvider>,
    );

    expect(container.ownerDocument.querySelector('section[aria-live="polite"]')?.getAttribute('aria-label')).not.toContain(
      'Notifications',
    );
  });
});
