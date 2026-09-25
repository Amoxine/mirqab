// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import C from '@/messages/en/common.json';
import S from '@/messages/en/specSource.json';
import { fail, mockFetch, never, ok, renderUi } from '@/components/apis/endpoints/test-utils';
import type { SpecSourceStatus } from '@/lib/api/spec-source';
import { SpecSourceCard } from './spec-source-card';

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }));
vi.mock('@/components/ui/sonner', () => ({ toast }));

const SOURCE: SpecSourceStatus = {
  configured: true,
  url: 'https://specs.example.com/…',
  enabled: true,
  intervalMinutes: 60,
  lastCheckedAt: '2026-09-25T10:00:00.000Z',
  lastSuccessAt: '2026-09-25T10:00:00.000Z',
  nextCheckAt: '2026-09-25T11:00:00.000Z',
  lastResult: 'ERROR',
  lastErrorCode: 'HTTP_503',
  consecutiveFailures: 3,
};

beforeEach(() => {
  vi.clearAllMocks();
});

const allToasts = () => Object.values(toast).flatMap((fn) => fn.mock.calls.map((c) => JSON.stringify(c)));

describe('SpecSourceCard', () => {
  it('shows a skeleton while loading', () => {
    mockFetch(() => never());
    const { container } = renderUi(<SpecSourceCard apiId="api-1" canUpdate />);
    expect(container.querySelector('.animate-pulse')).not.toBeNull();
    expect(screen.queryByText(S.card.title)).toBeNull();
  });

  it('not configured: an api:update user can set one up; a read-only user only reads why', async () => {
    mockFetch(() => ok({ configured: false }));
    const { rerenderUi } = renderUi(<SpecSourceCard apiId="api-1" canUpdate />);
    fireEvent.click(await screen.findByRole('button', { name: S.card.setUp }));
    expect(await screen.findByText(S.sheet.createTitle)).toBeDefined();
    rerenderUi(<SpecSourceCard apiId="api-1" canUpdate={false} />);
    expect(screen.queryByRole('button', { name: S.card.setUp })).toBeNull();
    expect(screen.getByText(S.card.notConfigured)).toBeDefined();
  });

  it('shows the redacted URL left-to-right, the schedule and the translated last error with the HTTP status', async () => {
    mockFetch(() => ok(SOURCE));
    renderUi(<SpecSourceCard apiId="api-1" canUpdate />);
    const url = await screen.findByText('https://specs.example.com/…');
    expect(url.getAttribute('dir')).toBe('ltr');
    expect(screen.getByText(S.intervals['60'])).toBeDefined();
    expect(screen.getByText('Failed: The URL answered with HTTP status 503.')).toBeDefined();
    expect(screen.getByText('3 failed checks in a row')).toBeDefined();
    expect(screen.getByText(S.card.gatewayNote)).toBeDefined();
  });

  it('read-only: no Check now / Edit / Remove', async () => {
    mockFetch(() => ok(SOURCE));
    renderUi(<SpecSourceCard apiId="api-1" canUpdate={false} />);
    await screen.findByText('https://specs.example.com/…');
    for (const name of [S.card.checkNow, S.card.edit, S.card.remove]) expect(screen.queryByRole('button', { name })).toBeNull();
  });

  it.each([
    [{ result: 'UNCHANGED' }, 'success', S.check.unchangedToast],
    [{ result: 'CHANGED', candidate: { id: 'c1' } }, 'info', S.check.changedToast],
    [{ result: 'ERROR', errorCode: 'TIMEOUT' }, 'error', `The check failed: ${S.errors.TIMEOUT}`],
    [{ result: 'ERROR', errorCode: 'NOT_A_SPEC' }, 'error', `The check failed: ${S.errors.NOT_A_SPEC}`],
  ] as const)('Check now answers %j with a translated %s toast, then reloads the source', async (outcome, kind, text) => {
    const calls = mockFetch((c) => (c.method === 'POST' ? ok(outcome) : ok(SOURCE)));
    renderUi(<SpecSourceCard apiId="api-1" canUpdate />);
    fireEvent.click(await screen.findByRole('button', { name: S.card.checkNow }));
    await waitFor(() => {
      expect(toast[kind]).toHaveBeenCalledWith(text);
    });
    expect(calls.find((c) => c.method === 'POST')?.path).toBe('/apis/api-1/spec-source/check');
    await waitFor(() => {
      expect(calls.filter((c) => c.method === 'GET' && c.path === '/apis/api-1/spec-source').length).toBeGreaterThan(1);
    });
  });

  it('Check now within 30 s (429 SPEC_CHECK_COOLDOWN) says so, not the server text', async () => {
    mockFetch((c) => (c.method === 'POST' ? fail(429, 'cooldown for https://specs.example.com/x?token=S3CRET', 'SPEC_CHECK_COOLDOWN') : ok(SOURCE)));
    renderUi(<SpecSourceCard apiId="api-1" canUpdate />);
    fireEvent.click(await screen.findByRole('button', { name: S.card.checkNow }));
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(S.errors.SPEC_CHECK_COOLDOWN);
    });
    expect(allToasts().join()).not.toContain('S3CRET');
  });

  it('Remove is confirmed first, then DELETEs', async () => {
    const calls = mockFetch((c) => (c.method === 'DELETE' ? ok({ removed: true }) : ok(SOURCE)));
    renderUi(<SpecSourceCard apiId="api-1" canUpdate />);
    fireEvent.click(await screen.findByRole('button', { name: S.card.remove }));
    expect(await screen.findByText(S.remove.confirmTitle)).toBeDefined();
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: S.remove.confirm }));
    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith(S.remove.removedToast);
    });
    expect(calls.find((c) => c.method === 'DELETE')?.path).toBe('/apis/api-1/spec-source');
  });

  it('a load error offers a retry', async () => {
    const calls = mockFetch(() => fail(500, 'boom'));
    renderUi(<SpecSourceCard apiId="api-1" canUpdate />);
    fireEvent.click(await screen.findByRole('button', { name: C.retry }, { timeout: 10_000 }));
    await waitFor(() => {
      expect(calls.length).toBeGreaterThan(1);
    });
    expect(screen.getByText(S.card.loadError)).toBeDefined();
  });

  it('renders right-to-left in Arabic with the URL kept left-to-right', async () => {
    mockFetch(() => ok(SOURCE));
    const { container } = renderUi(<SpecSourceCard apiId="api-1" canUpdate />, 'ar');
    const url = await screen.findByText('https://specs.example.com/…');
    expect(container.firstElementChild?.getAttribute('dir')).toBe('rtl');
    expect(url.getAttribute('dir')).toBe('ltr');
    expect(screen.getByRole('button', { name: 'تحقّق الآن' })).toBeDefined();
  });
});
