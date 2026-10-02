// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import M from '@/messages/en/openapi.json';
import C from '@/messages/en/common.json';
import { baseApi } from '@/components/apis/designer/test-utils';
import { fail, mockFetch, ok, renderUi } from '@/components/apis/endpoints/test-utils';
import type { ImportPreview } from '@/lib/api/openapi';
import { ImportWizardSheet } from './import-wizard-sheet';

const router = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }));
vi.mock('@/components/ui/sonner', () => ({ toast }));

const YAML = 'openapi: 3.0.3\ninfo:\n  title: Orders\n  version: "1"\n';

const PREVIEW: ImportPreview = {
  valid: true,
  canImport: true,
  findings: [{ code: 'operation-description', message: 'Operation "description" must be present', severity: 'warning', path: 'paths./orders.get', line: 12 }],
  problems: {},
  openapiVersion: '3.0.3',
  contentHash: 'h',
  format: 'yaml',
  derived: { name: 'Orders', slug: 'orders', listenPath: '/orders/', proxyUrl: 'https://orders.example.com' },
  servers: [
    { index: 0, url: 'https://orders.example.com', selected: true, denyReason: null },
    { index: 1, url: 'http://169.254.169.254', selected: false, denyReason: 'cloud metadata address' },
  ],
  conflicts: { slug: false, listenPath: false },
  endpointCount: 3,
  endpoints: [
    { key: 'a', method: 'GET', path: '/orders', operationId: 'a', summary: null, tags: ['orders'], deprecated: false, securitySchemes: [] },
    { key: 'b', method: 'POST', path: '/orders', operationId: 'b', summary: null, tags: ['orders'], deprecated: false, securitySchemes: [] },
    { key: 'c', method: 'GET', path: '/health', operationId: 'c', summary: null, tags: [], deprecated: false, securitySchemes: [] },
  ],
};

function openWizard() {
  const onOpenChange = vi.fn();
  renderUi(<ImportWizardSheet open onOpenChange={onOpenChange} />);
  return { onOpenChange };
}

const paste = (text: string) => {
  fireEvent.change(screen.getByLabelText(M.source.label), { target: { value: text } });
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ImportWizardSheet', () => {
  it('requires a document before checking', async () => {
    const calls = mockFetch(() => ok(PREVIEW));
    openWizard();
    fireEvent.click(screen.getByRole('button', { name: M.import.check }));
    expect(await screen.findByText(M.source.required)).toBeDefined();
    expect(calls).toHaveLength(0);
  });

  it('refuses a document over 5 MB without sending it', async () => {
    const calls = mockFetch(() => ok(PREVIEW));
    openWizard();
    paste('a'.repeat(5 * 1024 * 1024 + 1));
    fireEvent.click(screen.getByRole('button', { name: M.import.check }));
    expect(await screen.findByText('The document is larger than 5 MB')).toBeDefined();
    expect(calls).toHaveLength(0);
  });

  it('check -> review -> import in three steps, raw body as text/plain, then lands on the Endpoints tab', async () => {
    const calls = mockFetch((c) =>
      c.path.startsWith('/apis/import/preview') ? ok(PREVIEW) : ok({ api: { ...baseApi, syncStatus: 'PENDING' }, findings: [], spec: { versionNo: 1, contentHash: 'h', endpointCount: 3 } }, 201),
    );
    const { onOpenChange } = openWizard();
    paste(YAML);
    fireEvent.click(screen.getByRole('button', { name: M.import.check }));

    // Review: findings with their line, derived API, refused server with its reason, count by tag.
    expect(await screen.findByText(M.import.canImport)).toBeDefined();
    expect(screen.getByText('Line 12')).toBeDefined();
    expect(screen.getByText('https://orders.example.com', { selector: 'dd' })).toBeDefined();
    expect(screen.getByText('cloud metadata address')).toBeDefined();
    expect(screen.getByText('orders: 2')).toBeDefined();
    expect(screen.getByText('untagged: 1')).toBeDefined();
    // No serverIndex until the user picks one: the API chooses (and a document without servers gets none).
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/apis/import/preview', body: YAML, contentType: 'text/plain; charset=utf-8' });

    fireEvent.click(screen.getByRole('button', { name: M.import.import }));
    await waitFor(() => {
      expect(router.push).toHaveBeenCalledWith('/apis/api-1?tab=endpoints');
    });
    expect(calls[1]).toMatchObject({ method: 'POST', path: '/apis/import', body: YAML, contentType: 'text/plain; charset=utf-8' });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(toast.warning).toHaveBeenCalled(); // created, gateway sync PENDING — not claimed as synced
  });

  it('never sends a JSON document as application/json (Nest would JSON-parse it before the raw-text parser)', async () => {
    const calls = mockFetch(() => ok(PREVIEW));
    openWizard();
    paste('{"openapi":"3.0.3"}');
    fireEvent.click(screen.getByRole('button', { name: M.import.check }));
    await screen.findByText(M.import.canImport);
    expect(calls[0]?.contentType).not.toMatch(/json/);
    expect(calls[0]).toMatchObject({ body: '{"openapi":"3.0.3"}', contentType: 'text/plain; charset=utf-8' });
  });

  it('sends serverIndex only once the user picked a server (keyboard)', async () => {
    const two = {
      ...PREVIEW,
      servers: [
        { index: 0, url: 'https://a.example.com', selected: true, denyReason: null },
        { index: 1, url: 'https://b.example.com', selected: false, denyReason: null },
      ],
    };
    const calls = mockFetch(() => ok(two));
    openWizard();
    paste(YAML);
    fireEvent.click(screen.getByRole('button', { name: M.import.check }));
    await screen.findByText(M.import.canImport);
    fireEvent.keyDown(screen.getByRole('combobox', { name: M.import.upstream }), { key: 'ArrowDown' });
    fireEvent.keyDown(await screen.findByRole('option', { name: 'https://b.example.com' }), { key: 'Enter' });
    expect(await screen.findByText(M.import.recheck)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: M.import.check }));
    await waitFor(() => {
      expect(calls[1]?.path).toBe('/apis/import/preview?serverIndex=1');
    });
  });

  it('says so when the chosen file cannot be read', async () => {
    mockFetch(() => ok(PREVIEW));
    const { container } = renderUi(<ImportWizardSheet open onOpenChange={vi.fn()} />);
    const file = new File(['x'], 'spec.yaml');
    Object.defineProperty(file, 'text', { value: () => Promise.reject(new Error('unreadable')) });
    const input = document.querySelector('input[type="file"]') ?? container.querySelector('input[type="file"]');
    if (!input) throw new Error('no file input');
    fireEvent.change(input, { target: { files: [file] } });
    expect(await screen.findByText(M.source.readError)).toBeDefined();
  });

  it('a slug over 100 characters gets a translated message', async () => {
    mockFetch(() => ok({ ...PREVIEW, canImport: false, conflicts: { slug: true, listenPath: false } }));
    openWizard();
    paste(YAML);
    fireEvent.click(screen.getByRole('button', { name: M.import.check }));
    await screen.findByText(M.import.conflict);
    fireEvent.change(screen.getByLabelText(M.import.slugOverride), { target: { value: 'a'.repeat(101) } });
    fireEvent.click(screen.getByRole('button', { name: M.import.check }));
    expect(await screen.findByText(M.import.slugTooLong)).toBeDefined();
  });

  it('blocks the import while the document has lint errors', async () => {
    mockFetch(() =>
      ok({
        ...PREVIEW,
        valid: false,
        canImport: false,
        findings: [{ code: 'oas3-api-servers', message: 'OpenAPI "servers" must be present', severity: 'error', path: '', line: 1 }],
      }),
    );
    openWizard();
    paste(YAML);
    fireEvent.click(screen.getByRole('button', { name: M.import.check }));
    expect(await screen.findByText(M.import.cannotImport)).toBeDefined();
    expect(screen.getByText('1 error blocks the import')).toBeDefined();
    expect(screen.getByRole('button', { name: M.import.check }).hasAttribute('disabled')).toBe(true);
  });

  it('on a slug conflict asks for another slug, and the next check sends it', async () => {
    const calls = mockFetch((c) =>
      c.path.includes('slug=') ? ok(PREVIEW) : ok({ ...PREVIEW, canImport: false, conflicts: { slug: true, listenPath: true } }),
    );
    openWizard();
    paste(YAML);
    fireEvent.click(screen.getByRole('button', { name: M.import.check }));
    expect(await screen.findByText(M.import.conflict)).toBeDefined();
    fireEvent.change(screen.getByLabelText(M.import.slugOverride), { target: { value: 'orders-v2' } });
    fireEvent.click(screen.getByRole('button', { name: M.import.check }));
    await screen.findByText(M.import.canImport);
    expect(calls[1]?.path).toBe('/apis/import/preview?slug=orders-v2');
  });

  it.each([
    [403, 'Missing permission api:create'],
    [413, 'The OpenAPI document exceeds the 5 MB limit'],
    [415, 'Unsupported media type'],
    [422, 'OAS_IMPORT_UNSAFE_YAML'],
  ] as const)('shows a refused request (%i) inline in translated text, the server detail as a secondary LTR line', async (status, detail) => {
    mockFetch(() => fail(status, detail));
    openWizard();
    paste(YAML);
    fireEvent.click(screen.getByRole('button', { name: M.import.check }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(M.httpErrors[String(status) as keyof typeof M.httpErrors]);
    expect(screen.getByText(detail).getAttribute('dir')).toBe('ltr');
  });

  it('cancel closes and resets', () => {
    mockFetch(() => ok(PREVIEW));
    const { onOpenChange } = openWizard();
    paste(YAML);
    fireEvent.click(screen.getByRole('button', { name: C.cancel }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
