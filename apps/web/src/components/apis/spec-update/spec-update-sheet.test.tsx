// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import M from '@/messages/en/openapi.json';
import { at } from '@/components/apis/designer/test-utils';
import { fail, LIST, mockFetch, ok, renderUi } from '@/components/apis/endpoints/test-utils';
import type { SpecUpdateResult } from '@/lib/api/openapi';
import { SpecUpdateSheet } from './spec-update-sheet';

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }));
vi.mock('@/components/ui/sonner', () => ({ toast }));

const DOC = 'openapi: 3.0.3\n';
const GET_EP = at(LIST.endpoints, 0);
const POST_EP = at(LIST.endpoints, 1);

const DIFF: SpecUpdateResult = {
  dryRun: true,
  applied: false,
  unchanged: false,
  versionNo: 3,
  findings: [],
  diff: {
    added: [{ ...POST_EP, key: 'new', path: '/invoices' }],
    removed: [],
    changed: [{ key: 'listOrders', before: GET_EP, after: { ...GET_EP, summary: 'All orders' }, fields: ['summary'] }],
  },
  governanceImpact: { removedGoverned: [], changedGoverned: ['listOrders'] },
};

function openSheet() {
  const onOpenChange = vi.fn();
  renderUi(<SpecUpdateSheet apiId="api-1" versionNo={3} open onOpenChange={onOpenChange} />);
  fireEvent.change(screen.getByLabelText(M.source.label), { target: { value: DOC } });
  return { onOpenChange };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('SpecUpdateSheet', () => {
  it('dry-runs against the version on screen, shows the diff, then applies', async () => {
    const calls = mockFetch((c) =>
      c.path.includes('/spec/preview') ? ok(DIFF) : ok({ ...DIFF, dryRun: false, applied: true, versionNo: 4 }),
    );
    const { onOpenChange } = openSheet();
    fireEvent.click(screen.getByRole('button', { name: M.specUpdate.compare }));
    expect(await screen.findByText('1 added, 0 removed, 1 changed')).toBeDefined();
    expect(screen.getByText('/invoices')).toBeDefined();
    expect(screen.getByText('changed: summary')).toBeDefined();
    expect(screen.getByText(M.specUpdate.changedGoverned)).toBeDefined();
    expect(calls[0]).toMatchObject({
      method: 'POST',
      path: '/apis/api-1/spec/preview?expectedVersion=3',
      body: DOC,
      contentType: 'text/plain; charset=utf-8',
    });

    fireEvent.click(screen.getByRole('button', { name: M.specUpdate.apply }));
    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
    expect(calls[1]?.path).toBe('/apis/api-1/spec?expectedVersion=3');
    expect(toast.warning).toHaveBeenCalledWith(expect.stringContaining('Specification version 4 saved'));
  });

  it('removing governed endpoints needs the acknowledgement, which is then sent', async () => {
    const removing = { ...DIFF, governanceImpact: { removedGoverned: [{ key: 'listOrders', governance: { enabled: false as const } }], changedGoverned: [] } };
    const calls = mockFetch(() => ok(removing));
    openSheet();
    fireEvent.click(screen.getByRole('button', { name: M.specUpdate.compare }));
    await screen.findByText(M.specUpdate.acknowledge);
    const apply = screen.getByRole('button', { name: M.specUpdate.apply });
    expect(apply.hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: M.specUpdate.acknowledge }));
    expect(apply.hasAttribute('disabled')).toBe(false);
    fireEvent.click(apply);
    await waitFor(() => {
      expect(calls[1]?.path).toBe('/apis/api-1/spec?expectedVersion=3&acknowledgeRemoved=true');
    });
  });

  it('an identical document has nothing to apply', async () => {
    mockFetch(() => ok({ ...DIFF, unchanged: true, diff: { added: [], removed: [], changed: [] } }));
    openSheet();
    fireEvent.click(screen.getByRole('button', { name: M.specUpdate.compare }));
    expect(await screen.findByText(M.specUpdate.unchanged)).toBeDefined();
    expect(screen.getByRole('button', { name: M.specUpdate.apply }).hasAttribute('disabled')).toBe(true);
  });

  it('lint errors block the apply', async () => {
    mockFetch(() => ok({ ...DIFF, findings: [{ code: 'oas3-schema', message: 'bad', severity: 'error', path: 'info', line: 2 }] }));
    openSheet();
    fireEvent.click(screen.getByRole('button', { name: M.specUpdate.compare }));
    await screen.findByText('1 error blocks the import');
    expect(screen.getByRole('button', { name: M.specUpdate.apply }).hasAttribute('disabled')).toBe(true);
  });

  it('a stale version (409) drops the diff and asks to compare again', async () => {
    mockFetch((c) => (c.path.includes('/spec/preview') ? ok(DIFF) : fail(409, 'stale', 'SPEC_VERSION_STALE')));
    openSheet();
    fireEvent.click(screen.getByRole('button', { name: M.specUpdate.compare }));
    await screen.findByText('1 added, 0 removed, 1 changed');
    fireEvent.click(screen.getByRole('button', { name: M.specUpdate.apply }));
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(M.specUpdate.stale);
    });
    expect(screen.getByRole('button', { name: M.specUpdate.compare })).toBeDefined();
  });

  it('with no stored spec (versionNo 0) previews and creates version 1 with expectedVersion=0', async () => {
    const allAdded = { ...DIFF, versionNo: 0, diff: { added: LIST.endpoints, removed: [], changed: [] }, governanceImpact: { removedGoverned: [], changedGoverned: [] } };
    const calls = mockFetch((c) => (c.path.includes('/spec/preview') ? ok(allAdded) : ok({ ...allAdded, dryRun: false, applied: true, versionNo: 1 })));
    const onOpenChange = vi.fn();
    renderUi(<SpecUpdateSheet apiId="api-1" versionNo={0} open onOpenChange={onOpenChange} />);
    expect(screen.getByText(M.specUpdate.firstDescription)).toBeDefined();
    fireEvent.change(screen.getByLabelText(M.source.label), { target: { value: DOC } });
    fireEvent.click(screen.getByRole('button', { name: M.specUpdate.compare }));
    expect(await screen.findByText('2 added, 0 removed, 0 changed')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: M.specUpdate.apply }));
    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
    expect(calls.map((c) => c.path)).toEqual(['/apis/api-1/spec/preview?expectedVersion=0', '/apis/api-1/spec?expectedVersion=0']);
    // The old single route with a `dryRun` flag is gone from every request.
    expect(calls.some((c) => c.path.includes('dryRun'))).toBe(false);
  });

  it('version 0: a spec that appeared meanwhile (409 SPEC_VERSION_STALE) drops the diff and asks to compare again', async () => {
    mockFetch((c) =>
      c.path.includes('/spec/preview') ? ok({ ...DIFF, versionNo: 0 }) : fail(409, 'The specification is at version 1, not 0.', 'SPEC_VERSION_STALE'),
    );
    renderUi(<SpecUpdateSheet apiId="api-1" versionNo={0} open onOpenChange={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(M.source.label), { target: { value: DOC } });
    fireEvent.click(screen.getByRole('button', { name: M.specUpdate.compare }));
    await screen.findByText('1 added, 0 removed, 1 changed');
    fireEvent.click(screen.getByRole('button', { name: M.specUpdate.apply }));
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(M.specUpdate.stale);
    });
    expect(screen.getByRole('button', { name: M.specUpdate.compare })).toBeDefined();
  });

  it('never sends a JSON document as application/json', async () => {
    const calls = mockFetch(() => ok(DIFF));
    renderUi(<SpecUpdateSheet apiId="api-1" versionNo={3} open onOpenChange={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(M.source.label), { target: { value: '{"openapi":"3.0.3"}' } });
    fireEvent.click(screen.getByRole('button', { name: M.specUpdate.compare }));
    await screen.findByText('1 added, 0 removed, 1 changed');
    expect(calls[0]?.contentType).not.toMatch(/json/);
  });

  it('409 SPEC_REMOVES_GOVERNED_ENDPOINTS has its own message and drops the diff', async () => {
    mockFetch((c) => (c.path.includes('/spec/preview') ? ok(DIFF) : fail(409, 'removes governed', 'SPEC_REMOVES_GOVERNED_ENDPOINTS')));
    openSheet();
    fireEvent.click(screen.getByRole('button', { name: M.specUpdate.compare }));
    await screen.findByText('1 added, 0 removed, 1 changed');
    fireEvent.click(screen.getByRole('button', { name: M.specUpdate.apply }));
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(M.specUpdate.removesGoverned);
    });
    expect(toast.error).not.toHaveBeenCalledWith(M.specUpdate.stale);
    expect(screen.queryByText('1 added, 0 removed, 1 changed')).toBeNull();
  });

  it('editing the document after a compare requires a new compare', async () => {
    mockFetch(() => ok(DIFF));
    openSheet();
    fireEvent.click(screen.getByRole('button', { name: M.specUpdate.compare }));
    await screen.findByText('1 added, 0 removed, 1 changed');
    fireEvent.change(screen.getByLabelText(M.source.label), { target: { value: `${DOC}# edited\n` } });
    expect(screen.getByText(M.specUpdate.recompare)).toBeDefined();
    expect(screen.getByRole('button', { name: M.specUpdate.compare })).toBeDefined();
  });
});
