// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { mockFetch, ok } from '@/components/apis/endpoints/test-utils';
import { ApiTrafficTable } from './api-traffic-table';
import { over, ratio, rgb, tokenValues } from './contrast';
import { EndpointTrafficTable } from './endpoint-traffic-table';
import { renderApp } from './test-render';

vi.mock('@/hooks/use-permissions', () => ({
  usePermissions: () => ({ can: () => true, isLoading: false }),
}));

/**
 * A flagged error rate is text on the ink card, which is dark in both themes. This reads the real tokens
 * and the colour class the cell actually renders, and holds the pair to WCAG AA (4.5:1) on the ink, on the
 * ink with the card's corner gradient (7% of the foreground) and with a hovered row's fill on top of that
 * (8% of the foreground): the worst the text ever sits on.
 */
const ui = readFileSync(join(process.cwd(), '../../packages/ui/src/styles.css'), 'utf8');
/** `.surface-ink` re-points the destructive token to one value for both themes. */
const inkDestructive = /--color-destructive:\s*(#[0-9a-fA-F]{6})/.exec(ui)?.[1] ?? '';

const WAIT = { timeout: 8000 };
const apiRow = { apiDefId: 'a1', name: 'Orders', slug: 'orders', status: 'ACTIVE', requests: 1_000, errors: 100, errorRate: 10, avgLatencyMs: 120 };
const traffic = {
  range: '24h',
  summary: { requests: 1_000, errors: 100, errorRate: 10, uniqueKeys: 1 },
  statusCodes: [],
  topEndpoints: [{ method: 'GET', path: '/v1/orders', requests: 1_000, errors: 100, errorRate: 10, avgLatencyMs: 90, p95LatencyMs: 200 }],
};

/** The colour class on the cell that carries the flag (the `▲` marker). */
function flaggedColour(container: HTMLElement): string {
  const marker = Array.from(container.querySelectorAll('td span[aria-hidden="true"]')).find((el) => el.textContent.includes('▲'));
  const cell = marker?.closest('td');
  const colour = Array.from(cell?.classList ?? []).find((cls) => cls === 'text-destructive' || /^text-\[#[0-9a-f]{6}\]$/i.test(cls));
  if (!colour) throw new Error('no flagged cell with a text colour');
  return colour;
}

function check(colourClass: string) {
  const hex = colourClass === 'text-destructive' ? inkDestructive : colourClass.slice(6, 13);
  const inks = tokenValues('--color-ink');
  const foregrounds = tokenValues('--color-secondary-foreground');
  expect(inks).toHaveLength(2);
  for (const [theme, ink] of inks.entries()) {
    const fg = rgb(foregrounds[theme] ?? '#ffffff');
    const plain = rgb(ink);
    const gradient = over(fg, plain, 0.07);
    const hovered = over(fg, gradient, 0.08);
    const name = theme === 0 ? 'light' : 'dark';
    for (const [what, bg] of [['the ink', plain], ['the ink with its corner gradient', gradient], ['a hovered row', hovered]] as const) {
      expect(ratio(rgb(hex), bg), `${colourClass} (${hex}) on ${what}, ${name} theme`).toBeGreaterThanOrEqual(4.5);
    }
  }
}

beforeEach(() => {
  mockFetch((call) => (call.path.startsWith('/analytics/traffic') ? ok(traffic) : ok([apiRow])));
});

describe('flagged error rates on the ink card', () => {
  it('reads the destructive token and two inks from the stylesheets', () => {
    expect(inkDestructive).toMatch(/^#[0-9a-f]{6}$/i);
    expect(tokenValues('--color-ink')).toHaveLength(2);
  });

  it('reach 4.5:1 in both themes in the per-API table', async () => {
    const { container } = renderApp(<ApiTrafficTable range="24h" />);
    await screen.findByText('Orders', undefined, WAIT);
    check(flaggedColour(container));
  });

  it('reach 4.5:1 in both themes in the per-endpoint table', async () => {
    const { container } = renderApp(<EndpointTrafficTable range="24h" scope={{ id: 'a1', name: 'Orders' }} />);
    await screen.findAllByText('/v1/orders', undefined, WAIT);
    check(flaggedColour(container));
  });
});
