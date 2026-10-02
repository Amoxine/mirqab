// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { mockFetch, ok } from '@/components/apis/endpoints/test-utils';
import { over, ratio, rgb, tokenValues } from './contrast';
import { RecentActivityCard } from './recent-activity-card';
import { renderApp } from './test-render';

/**
 * The ink surface is dark in both themes, and its text colours are tokens plus an alpha. This reads the
 * real token values from globals.css and the colour classes the card actually renders, and checks every
 * pair against WCAG AA (4.5:1 for text), so lowering an alpha or reaching for the brand colour fails here.
 */

const entries = [
  { id: '1', action: 'UPDATED', resource: 'apis', createdAt: '2026-09-29T10:00:00.000Z', user: { name: 'Ada', email: 'a@x.io' } },
  { id: '2', action: 'DELETED', resource: 'keys', createdAt: '2026-09-29T09:00:00.000Z', user: null },
];

describe('RecentActivityCard text contrast on the ink surface', () => {
  it('reads two inks and two foregrounds from the stylesheet (one per theme)', () => {
    expect(tokenValues('--color-ink')).toHaveLength(2);
    expect(tokenValues('--color-secondary-foreground')).toHaveLength(2);
  });

  it('every text colour it uses reaches 4.5:1 in both themes, also behind a hovered row', async () => {
    mockFetch(() =>
      ok({ data: entries, meta: { page: 1, pageSize: 10, totalCount: 2, totalPages: 1 } }),
    );
    const { container } = renderApp(<RecentActivityCard />);
    await screen.findByText('Ada', { exact: false }, { timeout: 8000 });

    const inks = tokenValues('--color-ink');
    const foregrounds = tokenValues('--color-secondary-foreground');
    const used = new Set<string>();
    for (const el of container.querySelectorAll('[class]')) {
      // Text that is read; the decorative separator glyph is hidden from assistive technology.
      if (!el.textContent.trim() || el.closest('[aria-hidden="true"]')) continue;
      for (const cls of el.classList) {
        if (/^text-(secondary-foreground\/\d+|\[#[0-9a-f]{6}\]|primary|muted-foreground)$/i.test(cls)) used.add(cls);
      }
    }
    expect(used.size).toBeGreaterThan(0);
    // The brand colour changes with the brand picker and falls below 4.5:1 on the dark theme's ink for most
    // brands, so no text may use it.
    expect([...used].filter((cls) => cls === 'text-primary')).toEqual([]);

    for (const [theme, ink] of inks.entries()) {
      const bg = rgb(ink);
      const hovered = over([255, 255, 255], bg, 0.05);
      const fg = rgb(foregrounds[theme] ?? '#ffffff');
      for (const cls of used) {
        const alpha = /\/(\d+)$/.exec(cls)?.[1];
        const colour = cls.startsWith('text-[#')
          ? rgb(cls.slice(6, 13))
          : cls === 'text-muted-foreground'
            ? over(fg, bg, 0.7) // `.surface-ink` defines it as 70% of the foreground
            : over(fg, bg, Number(alpha) / 100);
        expect(ratio(colour, bg), `${cls} on the ${theme === 0 ? 'light' : 'dark'} theme's ink`).toBeGreaterThanOrEqual(4.5);
        expect(ratio(colour, hovered), `${cls} on a hovered row, ${theme === 0 ? 'light' : 'dark'} theme`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('titles the card with a heading that is not inside the log', async () => {
    mockFetch(() =>
      ok({ data: entries, meta: { page: 1, pageSize: 10, totalCount: 2, totalPages: 1 } }),
    );
    renderApp(<RecentActivityCard />);
    const heading = await screen.findByRole('heading', { name: 'Recent activity', level: 2 }, { timeout: 8000 });
    expect(heading.closest('[role="log"]')).toBeNull();
  });
});
