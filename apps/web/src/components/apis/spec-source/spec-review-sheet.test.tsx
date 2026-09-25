// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import M from '@/messages/en/openapi.json';
import S from '@/messages/en/specSource.json';
import { at } from '@/components/apis/designer/test-utils';
import { fail, LIST, mockFetch, never, ok, renderUi, type Call } from '@/components/apis/endpoints/test-utils';
import type { SpecUpdateResult } from '@/lib/api/openapi';
import { SpecReviewSheet } from './spec-review-sheet';

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }));
vi.mock('@/components/ui/sonner', () => ({ toast }));

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
const REMOVING: SpecUpdateResult = {
  ...DIFF,
  diff: { ...DIFF.diff, removed: [GET_EP] },
  governanceImpact: { removedGoverned: [{ key: 'listOrders', governance: { enabled: false } }], changedGoverned: [] },
};

const formOf = (el: HTMLElement): HTMLFormElement => {
  const form = el.closest('form');
  if (!form) throw new Error('not inside a form');
  return form;
};

const DIFF_PATH = '/apis/api-1/spec-candidates/c1/diff';
const isApply = (c: Call) => c.path.startsWith('/apis/api-1/spec-candidates/c1/apply');

function open(canUpdate = true) {
  const onOpenChange = vi.fn();
  const { client } = renderUi(<SpecReviewSheet apiId="api-1" candidateId="c1" canUpdate={canUpdate} onOpenChange={onOpenChange} />);
  return { onOpenChange, client };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('SpecReviewSheet', () => {
  it('shows a busy state while the diff is recomputed', () => {
    mockFetch(() => never());
    open();
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
  });

  it('reuses the OAS-04 diff view and applies with the versionNo it reviewed', async () => {
    const calls = mockFetch((c) => (isApply(c) ? ok({ ...DIFF, dryRun: false, applied: true, versionNo: 4 }) : ok(DIFF)));
    const { onOpenChange } = open();
    expect(await screen.findByText('1 added, 0 removed, 1 changed')).toBeDefined();
    expect(screen.getByText('/invoices')).toBeDefined();
    expect(screen.getByText(M.specUpdate.changedGoverned)).toBeDefined();
    expect(screen.getByText('Compared with the current specification (version 3). Using it creates the next version and resyncs the API with the gateway.')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: S.review.apply }));
    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
    expect(calls[0]?.path).toBe(DIFF_PATH);
    expect(calls.find(isApply)).toMatchObject({ method: 'POST', path: '/apis/api-1/spec-candidates/c1/apply?expectedVersion=3' });
    // Saved, the resync is pending: never a gateway success.
    expect(toast.warning).toHaveBeenCalledWith(expect.stringContaining('Specification version 4 saved'));
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('removing governed endpoints needs the acknowledgement, which is then sent', async () => {
    const calls = mockFetch((c) => (isApply(c) ? ok({ ...REMOVING, applied: true, versionNo: 4 }) : ok(REMOVING)));
    open();
    await screen.findByText(M.specUpdate.acknowledge);
    const apply = screen.getByRole('button', { name: S.review.apply });
    expect(apply.hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: M.specUpdate.acknowledge }));
    expect(apply.hasAttribute('disabled')).toBe(false);
    fireEvent.click(apply);
    await waitFor(() => {
      expect(calls.find(isApply)?.path).toBe('/apis/api-1/spec-candidates/c1/apply?expectedVersion=3&acknowledgeRemoved=true');
    });
  });

  it.each([
    ['SPEC_VERSION_STALE', S.errors.SPEC_VERSION_STALE],
    ['SPEC_REMOVES_GOVERNED_ENDPOINTS', S.errors.SPEC_REMOVES_GOVERNED_ENDPOINTS],
    ['SPEC_GOVERNANCE_CHANGED', S.errors.SPEC_GOVERNANCE_CHANGED],
    ['CANDIDATE_STALE', S.errors.CANDIDATE_STALE],
  ])('409 %s re-fetches the diff, says why, and the next apply uses the new versionNo', async (code, message) => {
    let diffs = 0;
    let applies = 0;
    const calls = mockFetch((c) => {
      if (isApply(c)) return applies++ === 0 ? fail(409, 'stale', code) : ok({ ...DIFF, applied: true, versionNo: 5 });
      diffs += 1;
      return ok(diffs === 1 ? DIFF : { ...DIFF, versionNo: 4 });
    });
    open();
    await screen.findByText('1 added, 0 removed, 1 changed');
    fireEvent.click(screen.getByRole('button', { name: S.review.apply }));
    expect((await screen.findByRole('alert')).textContent).toBe(message);
    await screen.findByText(/version 4\)/);
    expect(calls.filter((c) => c.path === DIFF_PATH).length).toBeGreaterThanOrEqual(2);
    fireEvent.click(screen.getByRole('button', { name: S.review.apply }));
    await waitFor(() => {
      expect(calls.filter(isApply).at(-1)?.path).toBe('/apis/api-1/spec-candidates/c1/apply?expectedVersion=4');
    });
  });

  it('a stale acknowledgement is cleared with the re-diff', async () => {
    let applies = 0;
    mockFetch((c) => (isApply(c) && applies++ === 0 ? fail(409, 'x', 'SPEC_REMOVES_GOVERNED_ENDPOINTS') : ok(REMOVING)));
    open();
    fireEvent.click(await screen.findByRole('checkbox', { name: M.specUpdate.acknowledge }));
    fireEvent.click(screen.getByRole('button', { name: S.review.apply }));
    await screen.findByRole('alert');
    await waitFor(() => {
      expect(screen.getByRole('checkbox', { name: M.specUpdate.acknowledge }).getAttribute('aria-checked')).toBe('false');
    });
    expect(screen.getByRole('button', { name: S.review.apply }).hasAttribute('disabled')).toBe(true);
  });

  it('an apply that finds the content already current says so, without claiming a resync', async () => {
    mockFetch((c) => (isApply(c) ? ok({ ...DIFF, dryRun: false, applied: false, unchanged: true, versionNo: 3 }) : ok(DIFF)));
    const { onOpenChange } = open();
    await screen.findByText('1 added, 0 removed, 1 changed');
    fireEvent.click(screen.getByRole('button', { name: S.review.apply }));
    await waitFor(() => {
      expect(toast.info).toHaveBeenCalledWith(S.review.alreadyCurrent);
    });
    expect(toast.warning).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('a refetch that changes the removed endpoints un-ticks the acknowledgement', async () => {
    let diffs = 0;
    const calls = mockFetch((c) => {
      if (isApply(c)) return ok({ ...REMOVING, applied: true, versionNo: 4 });
      diffs += 1;
      return ok(
        diffs === 1
          ? REMOVING
          : { ...REMOVING, governanceImpact: { removedGoverned: [{ key: 'listOrders', governance: { enabled: false } }, { key: 'createOrder', governance: { auth: 'public' } }], changedGoverned: [] } },
      );
    });
    const { client } = open();
    const box = await screen.findByRole('checkbox', { name: M.specUpdate.acknowledge });
    fireEvent.click(box);
    expect(box.getAttribute('aria-checked')).toBe('true');
    await act(async () => {
      await client.invalidateQueries();
    });
    await screen.findByText('createOrder');
    expect(screen.getByRole('checkbox', { name: M.specUpdate.acknowledge }).getAttribute('aria-checked')).toBe('false');
    expect(screen.getByRole('button', { name: S.review.apply }).hasAttribute('disabled')).toBe(true);
    expect(calls.some(isApply)).toBe(false);
  });

  it('a gate refusal of the served document (422 OAS_LINT_FAILED) is translated', async () => {
    mockFetch(() => fail(422, 'Lint failed on https://h/x?token=S3CRET', 'OAS_LINT_FAILED'));
    open();
    expect(await screen.findByText(S.errors.OAS_LINT_FAILED)).toBeDefined();
    expect(screen.queryByText(/S3CRET/)).toBeNull();
  });

  it('Dismiss posts to dismiss and closes', async () => {
    const calls = mockFetch((c) => (c.path.endsWith('/dismiss') ? ok({ state: 'DISMISSED' }) : ok(DIFF)));
    const { onOpenChange } = open();
    fireEvent.click(await screen.findByRole('button', { name: S.review.dismiss }));
    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
    expect(calls.find((c) => c.method === 'POST')?.path).toBe('/apis/api-1/spec-candidates/c1/dismiss');
    expect(toast.success).toHaveBeenCalledWith(S.review.dismissedToast);
  });

  it('read-only (api:read): the diff without Use / Dismiss or the acknowledgement', async () => {
    mockFetch(() => ok(REMOVING));
    open(false);
    await screen.findByText(/1 removed/);
    expect(screen.queryByRole('button', { name: S.review.apply })).toBeNull();
    expect(screen.queryByRole('button', { name: S.review.dismiss })).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.getByText(S.review.readOnly)).toBeDefined();
  });

  it('an identical document has nothing to use; only dismiss', async () => {
    mockFetch(() => ok({ ...DIFF, unchanged: true, diff: { added: [], removed: [], changed: [] } }));
    open();
    await screen.findByText(M.specUpdate.unchanged);
    expect(screen.getByRole('button', { name: S.review.apply }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: S.review.dismiss }).hasAttribute('disabled')).toBe(false);
  });

  it('lint errors block the use', async () => {
    mockFetch(() => ok({ ...DIFF, findings: [{ code: 'x', message: 'bad', severity: 'error', path: 'info', line: 2 }] }));
    open();
    await screen.findByText('1 error blocks the import');
    expect(screen.getByRole('button', { name: S.review.apply }).hasAttribute('disabled')).toBe(true);
  });

  it.each([
    [404, 'NOT_FOUND'],
    [409, 'CANDIDATE_STALE'],
  ])('a candidate that is gone (%s %s) says so and offers nothing to apply', async (status, code) => {
    mockFetch(() => fail(status, 'not pending', code));
    open();
    expect(await screen.findByText(S.review.gone)).toBeDefined();
    expect(screen.queryByRole('button', { name: S.review.apply })).toBeNull();
  });

  it('keyboard only: acknowledge and apply are native focusable controls; Enter/Space activate them', async () => {
    const calls = mockFetch((c) => (isApply(c) ? ok({ ...REMOVING, applied: true, versionNo: 4 }) : ok(REMOVING)));
    const { onOpenChange } = open();
    const box = await screen.findByRole('checkbox', { name: M.specUpdate.acknowledge });
    const apply = screen.getByRole('button', { name: S.review.apply });
    expect(box.tagName).toBe('BUTTON');
    box.focus();
    expect(document.activeElement).toBe(box);
    // A <button> turns Space/Enter into `click`; dispatched as such here (jsdom has no key activation).
    fireEvent.click(box);
    // Apply is disabled (unfocusable) until the box is ticked, then reachable.
    expect(apply.tagName).toBe('BUTTON');
    apply.focus();
    expect(document.activeElement).toBe(apply);
    fireEvent.submit(formOf(apply));
    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
    expect(calls.find(isApply)?.path).toContain('acknowledgeRemoved=true');
  });
});
