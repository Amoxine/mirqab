// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import M from '@/messages/en/openapi.json';
import C from '@/messages/en/common.json';
import type { EndpointGovernanceList, GovernedEndpoint } from '@/lib/api/openapi';
import { EndpointGovernanceSheet } from './endpoint-governance-sheet';
import { at } from '@/components/apis/designer/test-utils';
import { CAPABILITIES, fail, LIST, mockFetch, ok, pendingList, renderUi, REVISION } from './test-utils';

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }));
vi.mock('@/components/ui/sonner', () => ({ toast }));

const GET_EP = at(LIST.endpoints, 0);
const POST_EP = at(LIST.endpoints, 1);

function open(endpoint: GovernedEndpoint, opts: { readOnly?: boolean; list?: EndpointGovernanceList; apiWideCache?: boolean } = {}) {
  const onOpenChange = vi.fn();
  const sheet = (list: EndpointGovernanceList) => (
    <EndpointGovernanceSheet
      apiId="api-1"
      endpoint={endpoint}
      list={list}
      apiWideCache={opts.apiWideCache ?? false}
      readOnly={opts.readOnly ?? false}
      onOpenChange={onOpenChange}
    />
  );
  const { rerenderUi } = renderUi(sheet(opts.list ?? LIST));
  return {
    onOpenChange,
    dialog: screen.getByRole('dialog'),
    rerenderWith: (list: EndpointGovernanceList) => {
      rerenderUi(sheet(list));
    },
  };
}

const switchFor = (label: string) => screen.getByRole('switch', { name: label });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('EndpointGovernanceSheet', () => {
  it('moves focus into the sheet when it opens (keyboard users land inside it)', () => {
    mockFetch(() => ok(LIST));
    const { dialog } = open(GET_EP);
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it('saves only what changed: block + a new rate limit, as set/clear for this one key', async () => {
    const calls = mockFetch(() => ok(pendingList()));
    const { onOpenChange } = open(GET_EP);
    fireEvent.click(switchFor(M.governance.enabled));
    fireEvent.change(screen.getByLabelText(M.governance.rate), { target: { value: '5' } });
    fireEvent.change(screen.getByLabelText(M.governance.perSeconds), { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: C.save }));
    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
    const patch = calls.find((c) => c.method === 'PATCH');
    expect(JSON.parse(patch?.body ?? '{}')).toEqual({
      expectedRevision: REVISION,
      keys: ['listOrders'],
      set: { enabled: false, rateLimit: { rate: 5, per: 10 } },
    });
    expect(toast.warning).toHaveBeenCalled(); // PENDING: saved, not "synced"
  });

  it('clears a stored control when its switch is turned off', async () => {
    const calls = mockFetch(() => ok(pendingList()));
    open(GET_EP);
    fireEvent.click(switchFor(M.governance.rateLimit));
    fireEvent.click(screen.getByRole('button', { name: C.save }));
    await waitFor(() => {
      expect(calls.some((c) => c.method === 'PATCH')).toBe(true);
    });
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({ expectedRevision: REVISION, keys: ['listOrders'], clear: ['rateLimit'] });
  });

  it('shows the shared-counter warning with the rate limit', () => {
    mockFetch(() => ok(LIST));
    open(GET_EP);
    expect(screen.getByText(M.governance.rateLimitShared)).toBeDefined();
  });

  it('rejects out-of-range values and sends nothing', async () => {
    const calls = mockFetch(() => ok(LIST));
    open(GET_EP);
    fireEvent.change(screen.getByLabelText(M.governance.rate), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: C.save }));
    expect(await screen.findByText('Enter a whole number from 1 to 1000000000')).toBeDefined();
    expect(calls).toHaveLength(0);
  });

  it('refuses a request schema that contains a $ref', async () => {
    const calls = mockFetch(() => ok(LIST));
    open(POST_EP);
    fireEvent.click(switchFor(M.governance.validate));
    fireEvent.change(screen.getByLabelText(M.governance.schema), {
      target: { value: '{"type":"object","properties":{"a":{"$ref":"#/x"}}}' },
    });
    fireEvent.click(screen.getByRole('button', { name: C.save }));
    expect(await screen.findByText(M.errors.schemaHasRef)).toBeDefined();
    expect(calls).toHaveLength(0);
  });

  it('never offers a control the API did not report as enforced, and explains method limits', () => {
    mockFetch(() => ok(LIST));
    const list = { ...LIST, capabilities: CAPABILITIES.map((c) => (c.control === 'mock' ? { ...c, status: 'unverified' as const } : c)) };
    open(POST_EP, { list });
    expect(switchFor(M.governance.mock).hasAttribute('disabled')).toBe(true);
    expect(screen.getByText(M.governance.notProven)).toBeDefined();
    // cache is GET-only; POST_EP is a POST.
    expect(switchFor(M.governance.cache).hasAttribute('disabled')).toBe(true);
    expect(screen.getByText(M.governance.methodOnly.cache)).toBeDefined();
    // Unverified gateway controls are listed, never offered, with a TRANSLATED description: the
    // API's English `behaviour` text never reaches the page.
    expect(screen.getByText(M.unverifiedControls.circuitBreaker)).toBeDefined();
    expect(screen.queryByText('proven on the catch-all only')).toBeNull();
  });

  it('says why cache is unavailable while the API has an API-wide cache', () => {
    mockFetch(() => ok(LIST));
    open(GET_EP, { apiWideCache: true });
    expect(switchFor(M.governance.cache).hasAttribute('disabled')).toBe(true);
    expect(screen.getByText(M.governance.cacheApiWide)).toBeDefined();
  });

  it('on 409 explains the stale revision and closes so the next edit starts from fresh data', async () => {
    mockFetch(() => fail(409, 'stale', 'ENDPOINT_REVISION_STALE'));
    const { onOpenChange } = open(GET_EP);
    fireEvent.click(switchFor(M.governance.public));
    fireEvent.click(screen.getByRole('button', { name: C.save }));
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(M.staleRevision);
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('keeps the sheet open on a 403 and toasts TRANSLATED text, the server detail only as a secondary line', async () => {
    mockFetch(() => fail(403, 'Missing permission api:update'));
    const { onOpenChange } = open(GET_EP);
    fireEvent.click(switchFor(M.governance.public));
    fireEvent.click(screen.getByRole('button', { name: C.save }));
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalled();
    });
    const call: unknown[] = toast.error.mock.calls[0] ?? [];
    expect(call[0]).toBe(M.httpErrors['403']);
    expect(call[1]).toHaveProperty('description');
    expect(toast.error).not.toHaveBeenCalledWith('Missing permission api:update');
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('saves against the revision it was OPENED with, even after the list refetched a newer one', async () => {
    const calls = mockFetch(() => fail(409, 'stale', 'ENDPOINT_REVISION_STALE'));
    const { rerenderWith } = open(GET_EP);
    rerenderWith({ ...LIST, revision: 'c'.repeat(64) }); // another user saved meanwhile
    fireEvent.click(switchFor(M.governance.public));
    fireEvent.click(screen.getByRole('button', { name: C.save }));
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(M.staleRevision);
    });
    expect(JSON.parse(calls[0]?.body ?? '{}')).toMatchObject({ expectedRevision: REVISION });
  });

  it('a stored control that is no longer offered can still be removed (never set)', async () => {
    const calls = mockFetch(() => ok(pendingList()));
    const stored = { ...GET_EP, governance: { mock: { code: 503, body: 'down' } } };
    const list = { ...LIST, capabilities: CAPABILITIES.map((c) => (c.control === 'mock' ? { ...c, status: 'unverified' as const } : c)) };
    open(stored, { list });
    const mockSwitch = switchFor(M.governance.mock);
    expect(mockSwitch.hasAttribute('disabled')).toBe(false);
    expect(screen.getAllByText(M.governance.removeOnly).length).toBeGreaterThan(0);
    fireEvent.click(mockSwitch);
    expect(mockSwitch.hasAttribute('disabled')).toBe(true); // off now: cannot be turned back on
    fireEvent.click(screen.getByRole('button', { name: C.save }));
    await waitFor(() => {
      expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({ expectedRevision: REVISION, keys: ['listOrders'], clear: ['mock'] });
    });
  });

  it('read-only: every control disabled and no save button', () => {
    mockFetch(() => ok(LIST));
    const { dialog } = open(GET_EP, { readOnly: true });
    expect(within(dialog).getByText(M.readOnly)).toBeDefined();
    expect(within(dialog).queryByRole('button', { name: C.save })).toBeNull();
    for (const s of within(dialog).getAllByRole('switch')) expect(s.hasAttribute('disabled')).toBe(true);
  });
});
