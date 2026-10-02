// @vitest-environment jsdom
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import arDashboard from '@/messages/ar/dashboard.json';
import enDashboard from '@/messages/en/dashboard.json';
import frDashboard from '@/messages/fr/dashboard.json';
import { Breadcrumb, SEGMENT_KEYS } from './breadcrumb';

afterEach(cleanup);

const DASHBOARD = { en: enDashboard, fr: frDashboard, ar: arDashboard };
let pathname = '/';
vi.mock('next/navigation', () => ({ usePathname: () => pathname }));

function renderAt(path: string, locale: keyof typeof DASHBOARD) {
  pathname = path;
  return render(
    <NextIntlClientProvider locale={locale} messages={{ dashboard: DASHBOARD[locale] }}>
      <Breadcrumb />
    </NextIntlClientProvider>,
  );
}

/** The static segments of every route under `app/(dashboard)`, i.e. of each directory that holds a `page.tsx`; `[id]` params are not segments. */
function dashboardSegments(dir = join(process.cwd(), 'src/app/(dashboard)'), path: string[] = []): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isFile()) return entry.name === 'page.tsx' ? path : [];
    if (!entry.isDirectory()) return [];
    return dashboardSegments(join(dir, entry.name), entry.name.startsWith('[') ? path : [...path, entry.name]);
  });
}

describe('Breadcrumb labels', () => {
  it('knows every route segment of the dashboard, with a translation in all three locales', () => {
    const segments = [...new Set(dashboardSegments())];
    expect(segments.length).toBeGreaterThanOrEqual(10);
    for (const segment of segments) {
      const key = SEGMENT_KEYS[segment];
      expect(key, `no breadcrumb key for the "${segment}" route`).toBeDefined();
      for (const [locale, messages] of Object.entries(DASHBOARD)) {
        const label = (messages.breadcrumb as Record<string, string>)[key ?? ''];
        expect(label, `no ${locale} breadcrumb label for "${segment}"`).toBeTruthy();
      }
    }
  });

  it.each([
    ['en', ['Analytics', 'Traffic']],
    ['fr', ['Analytique', 'Trafic']],
    ['ar', ['التحليلات', 'الحركة']],
  ] as const)('translates /analytics/traffic in %s', (locale, labels) => {
    renderAt('/analytics/traffic', locale);
    const text = screen.getByRole('navigation').textContent;
    for (const label of labels) expect(text).toContain(label);
    if (locale !== 'en') expect(text).not.toContain('Traffic');
  });

  it.each([
    ['en', 'Request search'],
    ['fr', 'Recherche de requêtes'],
    ['ar', 'البحث في الطلبات'],
  ] as const)('translates /analytics/search in %s', (locale, label) => {
    renderAt('/analytics/search', locale);
    expect(screen.getByRole('navigation').textContent).toContain(label);
    if (locale !== 'en') expect(screen.getByRole('navigation').textContent).not.toContain('Search');
  });

  it.each(['en', 'fr', 'ar'] as const)(
    'never prints a raw URL segment: an id or an unmapped segment reads as "Details" in %s',
    (locale) => {
      renderAt('/tenants/tenant-001/zzz-unknown', locale);
      const text = screen.getByRole('navigation').textContent;
      expect(text).not.toMatch(/001|zzz|unknown/i);
      expect(text).toContain(DASHBOARD[locale].breadcrumb.details);
    },
  );
});
