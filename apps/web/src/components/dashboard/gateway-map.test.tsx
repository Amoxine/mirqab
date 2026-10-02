// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import analytics from '@/messages/en/analytics.json';
import common from '@/messages/en/common.json';
import dashboard from '@/messages/en/dashboard.json';
import arAnalytics from '@/messages/ar/analytics.json';
import arCommon from '@/messages/ar/common.json';
import arDashboard from '@/messages/ar/dashboard.json';
import { GatewayMap } from './gateway-map';

afterEach(cleanup);

// What the API sends: each node's admin URL, internal host name and port included.
const up = { reachable: true, version: '5.8.0', latencyMs: 12, redis: 'pass' as const, error: null };
const down = { reachable: false, version: null, latencyMs: null, redis: 'unknown' as const, error: 'Gateway unreachable' };
const DEFAULT_NODES = [
  { nodeUrl: 'http://tyk-gateway:8081/tyk', health: up },
  { nodeUrl: 'http://tyk-gateway-2:8081/tyk', health: down },
];
let nodes = DEFAULT_NODES;
afterEach(() => {
  nodes = DEFAULT_NODES;
});
vi.mock('@/hooks/use-settings', () => ({
  useNodeHealth: () => ({ data: nodes, isLoading: false, error: null, refetch: vi.fn() }),
}));
// Only `tyk-gateway` and `tyk-gateway-3` have a configured location, and it is the same city.
vi.mock('@/lib/gateway-locations', () => ({
  locationOf: (host: string) =>
    ['tyk-gateway:8081', 'tyk-gateway-3:8081'].includes(host)
      ? { city: 'Casablanca', code: 'CMN', lat: 33.57, lon: -7.59 }
      : null,
}));
// The real map paints a canvas; what matters here is the label card each node is handed.
vi.mock('@open-gateway/ui', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  WorldMap: ({ nodes }: { nodes: { id: string; code?: string; title: string; detail?: string; up: boolean }[] }) => (
    <ul data-testid="map">
      {nodes.map((node) => (
        <li key={node.id}>{[node.code, node.title, node.detail, node.up ? '' : 'DOWN'].filter(Boolean).join(' | ')}</li>
      ))}
    </ul>
  ),
}));

const MESSAGES = {
  en: { analytics, common, dashboard },
  ar: { analytics: arAnalytics, common: arCommon, dashboard: arDashboard },
};
const renderMap = (locale: keyof typeof MESSAGES = 'en') =>
  render(
    <NextIntlClientProvider locale={locale} messages={MESSAGES[locale]}>
      <GatewayMap />
    </NextIntlClientProvider>,
  );

describe('GatewayMap', () => {
  it('draws nodes in one city as one pin, so their label cards cannot stack', () => {
    nodes = [
      { nodeUrl: 'http://tyk-gateway:8081/tyk', health: up },
      { nodeUrl: 'http://tyk-gateway-3:8081/tyk', health: up },
    ];
    renderMap();

    expect(screen.getByTestId('map').textContent).toBe('CMN | Casablanca | 2 of 2 reachable');
  });

  it('draws a shared pin as down when any of its nodes is', () => {
    nodes = [
      { nodeUrl: 'http://tyk-gateway:8081/tyk', health: up },
      { nodeUrl: 'http://tyk-gateway-3:8081/tyk', health: down },
    ];
    renderMap();

    expect(screen.getByTestId('map').textContent).toBe('CMN | Casablanca | 1 of 2 reachable | DOWN');
  });

  it('never prints the gateway\'s own error text, only a translated reason', () => {
    nodes = [
      { nodeUrl: 'http://tyk-gateway:8081/tyk', health: { ...down, error: 'Gateway unreachable' } },
      { nodeUrl: 'http://tyk-gateway-2:8081/tyk', health: { ...down, error: 'Gateway health check timed out' } },
      { nodeUrl: 'http://tyk-gateway-4:8081/tyk', health: { ...down, error: 'Something odd from upstream (HTTP 502)' } },
    ];
    renderMap('ar');

    const text = document.body.textContent;
    expect(text).not.toMatch(/gateway|upstream|odd|http/i);
    expect(text).toContain(arDashboard.topology.noResponse);
    expect(text).toContain(arDashboard.topology.timedOut);
    // The located node's pin card says the same, translated.
    expect(screen.getByTestId('map').textContent).toContain(arDashboard.topology.noResponse);
  });

  it('tells nodes in the same city apart, and keeps "Node N" for an unlocated one', () => {
    nodes = [
      { nodeUrl: 'http://tyk-gateway:8081/tyk', health: up },
      { nodeUrl: 'http://tyk-gateway-3:8081/tyk', health: up },
      { nodeUrl: 'http://tyk-gateway-2:8081/tyk', health: down },
    ];
    renderMap();

    expect(screen.getByText('Casablanca · Node 1')).toBeDefined();
    expect(screen.getByText('Casablanca · Node 2')).toBeDefined();
    expect(screen.getByText('Node 3')).toBeDefined();
    expect(document.body.textContent).not.toMatch(/tyk|8081/i);
  });

  it('names each node by its city, or by position, and never prints a host name', () => {
    renderMap();

    // Pills under the map: the located node by city, the other by its position in the node list
    // (the same numbering Settings uses).
    expect(screen.getByText('Casablanca', { selector: 'span' })).toBeDefined();
    expect(screen.getByText('Node 2')).toBeDefined();
    // The pin's label card carries the location code alone, no `CMN · host`.
    expect(screen.getByTestId('map').textContent).toBe('CMN | Casablanca | 5.8.0 · 12 ms');

    expect(document.body.textContent).not.toMatch(/tyk|8081/i);
  });
});
