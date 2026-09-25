// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import M from '@/messages/en/openapi.json';
import S from '@/messages/en/specSource.json';
import { baseApi } from '@/components/apis/designer/test-utils';
import { fail, mockFetch, ok, renderUi } from '@/components/apis/endpoints/test-utils';
import type { ImportPreview } from '@/lib/api/openapi';
import { ImportWizardSheet } from './import-wizard-sheet';

const router = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }));
vi.mock('@/components/ui/sonner', () => ({ toast }));

const SECRET_URL = 'https://specs.example.com/openapi.yaml?token=S3CRET';
const PREVIEW: ImportPreview = {
  valid: true,
  canImport: true,
  findings: [],
  problems: {},
  openapiVersion: '3.0.3',
  contentHash: 'h',
  format: 'yaml',
  derived: { name: 'Orders', slug: 'orders', listenPath: '/orders/', proxyUrl: 'https://orders.example.com' },
  servers: [],
  conflicts: { slug: false, listenPath: false },
  endpointCount: 1,
  endpoints: [{ key: 'a', method: 'GET', path: '/orders', operationId: 'a', summary: null, tags: [], deprecated: false, securitySchemes: [] }],
};
const allToasts = () => Object.values(toast).flatMap((fn) => fn.mock.calls.map((c) => JSON.stringify(c)));

/** Radix Tabs switch on mousedown (pointer) or focus + arrow keys; a plain click is not enough in jsdom. */
function openUrlTab() {
  renderUi(<ImportWizardSheet open onOpenChange={vi.fn()} />);
  const tab = screen.getByRole('tab', { name: S.import.tabUrl });
  act(() => {
    fireEvent.mouseDown(tab, { button: 0, ctrlKey: false });
  });
  return screen.findByLabelText(S.sheet.urlLabel);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ImportWizardSheet — From URL', () => {
  it('the document tab stays the default', () => {
    mockFetch(() => ok(PREVIEW));
    renderUi(<ImportWizardSheet open onOpenChange={vi.fn()} />);
    expect(screen.getByRole('tab', { name: S.import.tabDocument }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByLabelText(M.source.label)).toBeDefined();
  });

  it('refuses a URL with a user name before any request, and says why', async () => {
    const calls = mockFetch(() => ok(PREVIEW));
    const url = await openUrlTab();
    fireEvent.change(url, { target: { value: 'https://me:pw@specs.example.com/spec' } });
    fireEvent.click(screen.getByRole('button', { name: M.import.check }));
    expect(await screen.findByText(S.url.userinfo)).toBeDefined();
    expect(calls).toHaveLength(0);
    expect(screen.getByText(S.import.urlHelp)).toBeDefined();
    // The import fetches the URL again (no content hash comes back from the preview): said up front.
    expect(screen.getByText(S.import.refetchNote)).toBeDefined();
  });

  it('URL -> server-side preview (JSON body) -> the same review -> import with watch + interval, then the Endpoints tab', async () => {
    const calls = mockFetch((c) =>
      c.path === '/apis/import/url/preview'
        ? ok(PREVIEW)
        : ok({ api: { ...baseApi, syncStatus: 'PENDING' }, findings: [], spec: { versionNo: 1, contentHash: 'h', endpointCount: 1 } }, 201),
    );
    const url = await openUrlTab();
    fireEvent.change(url, { target: { value: SECRET_URL } });
    fireEvent.click(screen.getByRole('button', { name: M.import.check }));
    expect(await screen.findByText(M.import.canImport)).toBeDefined();
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/apis/import/url/preview', contentType: 'application/json' });
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({ url: SECRET_URL });

    fireEvent.click(screen.getByRole('button', { name: M.import.import }));
    await waitFor(() => {
      expect(router.push).toHaveBeenCalledWith('/apis/api-1?tab=endpoints');
    });
    expect(calls[1]).toMatchObject({ method: 'POST', path: '/apis/import/url' });
    expect(JSON.parse(calls[1]?.body ?? '{}')).toEqual({ url: SECRET_URL, watch: true, intervalMinutes: 60 });
    // The URL (and its token) is never in a path or a toast.
    expect(calls.every((c) => !c.path.includes('S3CRET'))).toBe(true);
    expect(allToasts().join()).not.toContain('S3CRET');
  });

  it('with "keep checking" off, no watch is sent', async () => {
    const calls = mockFetch((c) =>
      c.path === '/apis/import/url/preview' ? ok(PREVIEW) : ok({ api: baseApi, findings: [], spec: { versionNo: 1, contentHash: 'h', endpointCount: 1 } }, 201),
    );
    const url = await openUrlTab();
    fireEvent.change(url, { target: { value: SECRET_URL } });
    fireEvent.click(screen.getByRole('switch', { name: S.import.watch }));
    expect(screen.queryByText(S.sheet.intervalLabel)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: M.import.check }));
    await screen.findByText(M.import.canImport);
    fireEvent.click(screen.getByRole('button', { name: M.import.import }));
    await waitFor(() => {
      expect(calls).toHaveLength(2);
    });
    expect(JSON.parse(calls[1]?.body ?? '{}')).toEqual({ url: SECRET_URL });
  });

  it.each([
    ['SPEC_FETCH_TIMEOUT', S.errors.TIMEOUT],
    ['SPEC_FETCH_BLOCKED_TARGET', S.errors.BLOCKED_TARGET],
    ['SPEC_FETCH_TOO_LARGE', S.errors.TOO_LARGE],
    ['SPEC_FETCH_TOO_MANY_REDIRECTS', S.errors.TOO_MANY_REDIRECTS],
    ['SPEC_FETCH_UNREACHABLE', S.errors.UNREACHABLE],
    ['SPEC_FETCH_BAD_URL', S.errors.BAD_URL],
    ['SPEC_FETCH_HTTP_404', 'The URL answered with HTTP status 404.'],
  ])('a refused fetch (422 %s) is shown in place, translated, without the server text', async (code, message) => {
    mockFetch(() => fail(422, `could not fetch ${SECRET_URL}`, code));
    const url = await openUrlTab();
    fireEvent.change(url, { target: { value: SECRET_URL } });
    fireEvent.click(screen.getByRole('button', { name: M.import.check }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(message);
    expect(screen.queryByText(/S3CRET/)).toBeNull();
  });

  it.each([
    [422, 'OAS_LINT_FAILED', S.errors.OAS_LINT_FAILED],
    [422, 'SPEC_FETCH_TIMEOUT', S.errors.TIMEOUT],
    [409, 'CONFLICT', M.httpErrors['409']],
  ])('an import from the URL refused with %s %s is one translated toast, no server text as detail', async (status, code, message) => {
    mockFetch((c) => (c.path === '/apis/import/url/preview' ? ok(PREVIEW) : fail(status, `refused ${SECRET_URL}`, code)));
    const url = await openUrlTab();
    fireEvent.change(url, { target: { value: SECRET_URL } });
    fireEvent.click(screen.getByRole('button', { name: M.import.check }));
    await screen.findByText(M.import.canImport);
    fireEvent.click(screen.getByRole('button', { name: M.import.import }));
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(message);
    });
    expect(allToasts().join()).not.toContain('S3CRET');
  });

  it('a preview refused by a document gate (422 OAS_IMPORT_UNSUPPORTED_VERSION) is translated in place, no server text', async () => {
    mockFetch(() => fail(422, `Swagger 2.0 at ${SECRET_URL}`, 'OAS_IMPORT_UNSUPPORTED_VERSION'));
    const url = await openUrlTab();
    fireEvent.change(url, { target: { value: SECRET_URL } });
    fireEvent.click(screen.getByRole('button', { name: M.import.check }));
    expect((await screen.findByRole('alert')).textContent).toBe(S.errors.OAS_IMPORT_UNSUPPORTED_VERSION);
  });

  it('switching back to the document tab drops the URL preview', async () => {
    mockFetch(() => ok(PREVIEW));
    const url = await openUrlTab();
    fireEvent.change(url, { target: { value: SECRET_URL } });
    fireEvent.click(screen.getByRole('button', { name: M.import.check }));
    await screen.findByText(M.import.canImport);
    act(() => {
      fireEvent.mouseDown(screen.getByRole('tab', { name: S.import.tabDocument }), { button: 0, ctrlKey: false });
    });
    expect(screen.queryByText(M.import.canImport)).toBeNull();
    expect(screen.getByRole('button', { name: M.import.check })).toBeDefined();
  });
});
