// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, screen, waitFor } from '@testing-library/react';
import type * as Ui from '@open-gateway/ui';
import type { FilterField } from '@open-gateway/ui';
import analytics from '@/messages/en/analytics.json';
import { fail, mockFetch, ok } from '@/components/apis/endpoints/test-utils';
import { renderApp } from '@/components/dashboard/test-render';
import type { TrafficFilters } from '@/types';
import { TrafficFilterBar } from './traffic-filter-bar';

let granted: string[] = [];
vi.mock('@/hooks/use-permissions', () => ({
  usePermissions: () => ({ can: (p: string) => granted.includes(p), isLoading: false }),
}));
/** The fields the bar hands to the shared filter control: what it offers is what the test reads. */
let fields: FilterField[] = [];
vi.mock('@open-gateway/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof Ui>();
  return {
    ...actual,
    PageFilter: (props: { fields: FilterField[] }) => {
      fields = props.fields;
      return null;
    },
  };
});

const T = analytics.traffic.filters;
const WAIT = { timeout: 8000 };
const ORDERS = '6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f';
const BILLING = '7a2d3e4f-5b6c-4d7e-9f80-1b2c3d4e5f60';
const K_WEB = '5f1b5e0e-0d3c-4d7e-9a61-0b9d2f6a7c11';
const K_APP = '9c1b5e0e-0d3c-4d7e-9a61-0b9d2f6a7c22';
const apiRow = (apiDefId: string, name: string) => ({ apiDefId, name, slug: name.toLowerCase(), status: 'ACTIVE', requests: 1, errors: 0, errorRate: 0, avgLatencyMs: 1 });
const keyRow = (apiKeyId: string, name: string, apiDefName: string | null) => ({ apiKeyId, name, status: 'ACTIVE', apiDefName, requests: 1, errors: 0, errorRate: 0, avgLatencyMs: 1 });
const APIS = [apiRow(ORDERS, 'Orders API'), apiRow(BILLING, 'Billing API')];
const KEYS = [keyRow(K_WEB, 'qbus-web', 'Orders API'), keyRow(K_APP, 'mobile-app', 'Billing API')];

const optionsOf = (key: string) => {
  const field = fields.find((f) => f.key === key);
  if (field?.type !== 'select') throw new Error(`no select field ${key}`);
  return field.options;
};
const render = (filters: Partial<TrafficFilters> = {}) =>
  renderApp(<TrafficFilterBar filters={{ range: '24h', ...filters }} onChange={vi.fn()} onReset={vi.fn()} />);
/** One turn of the event loop inside `act`: whatever the bar was going to ask for on mount has been asked. */
const settled = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
/** Every path requested, by `mockFetch`. */
let paths: () => string[] = () => [];
const serve = (apis: () => unknown = () => ok(APIS), keys: () => unknown = () => ok(KEYS)) => {
  const calls = mockFetch((call) => {
    if (call.path.startsWith('/analytics/apis')) return apis() as ReturnType<typeof ok>;
    if (call.path.startsWith('/analytics/keys')) return keys() as ReturnType<typeof ok>;
    return ok([]);
  });
  paths = () => calls.map((call) => call.path);
};

beforeEach(() => {
  fields = [];
  granted = ['analytics:read', 'api:update', 'api:read', 'key:read'];
  serve();
});
afterEach(cleanup);

describe('TrafficFilterBar option lists', () => {
  it('offers the APIs and the keys from the analytics lists', async () => {
    render();
    await waitFor(() => {
      expect(optionsOf('apiId')).toEqual([
        { value: ORDERS, label: 'Orders API' },
        { value: BILLING, label: 'Billing API' },
      ]);
      expect(optionsOf('keyId')).toEqual([
        { value: K_WEB, label: 'qbus-web' },
        { value: K_APP, label: 'mobile-app' },
      ]);
    }, WAIT);
  });

  it('narrows the keys to those of the chosen API', async () => {
    render({ apiId: BILLING });
    await waitFor(() => {
      expect(optionsOf('keyId')).toEqual([{ value: K_APP, label: 'mobile-app' }]);
    }, WAIT);
  });

  it('still offers a selection that is not in the lists (a shared link), saying only what it is', async () => {
    const GONE_API = '00000000-0000-4000-8000-000000000001';
    const GONE_KEY = '00000000-0000-4000-8000-000000000002';
    render({ apiId: GONE_API, keyId: GONE_KEY });
    await waitFor(() => {
      expect(optionsOf('apiId')).toContainEqual({ value: GONE_API, label: T.selectedApi });
      expect(optionsOf('keyId')).toContainEqual({ value: GONE_KEY, label: T.selectedKey });
    }, WAIT);
  });

  it('keeps a chosen key that is filtered out by the chosen API, under its own name', async () => {
    render({ apiId: BILLING, keyId: K_WEB });
    await waitFor(() => {
      expect(optionsOf('keyId')).toEqual([
        { value: K_APP, label: 'mobile-app' },
        { value: K_WEB, label: 'qbus-web' },
      ]);
    }, WAIT);
  });

  it('says the lists are cut when they are as long as the lists are', async () => {
    const many = Array.from({ length: 50 }, (_, i) => apiRow(`id-${String(i)}`, `API ${String(i)}`));
    serve(() => ok(many));
    render();
    expect(await screen.findByText(T.listTruncated.replace('{count}', '50'), undefined, WAIT)).toBeDefined();
  });

  it('says nothing about the lists when they are complete', async () => {
    render();
    await waitFor(() => {
      expect(optionsOf('apiId')).toHaveLength(2);
    }, WAIT);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('says which list could not be loaded, instead of leaving an empty select', async () => {
    serve(() => fail(500, 'down'));
    render();
    expect(await screen.findByText(T.apisUnavailable, { exact: false }, WAIT)).toBeDefined();
    expect(screen.getByRole('status').textContent).not.toContain(T.keysUnavailable);
    cleanup();
    serve(undefined, () => fail(500, 'down'));
    render();
    expect(await screen.findByText(T.keysUnavailable, { exact: false }, WAIT)).toBeDefined();
  });
});

describe('TrafficFilterBar for someone who may only read analytics', () => {
  it('requests nothing that analytics:read does not allow, and still has its lists', async () => {
    granted = ['analytics:read'];
    render();
    await waitFor(() => {
      expect(optionsOf('apiId')).toHaveLength(2);
      expect(optionsOf('keyId')).toHaveLength(2);
    }, WAIT);
    await settled();
    expect(paths().length).toBeGreaterThan(0);
    expect(paths().filter((path) => !path.startsWith('/analytics/'))).toEqual([]);
  });
});
