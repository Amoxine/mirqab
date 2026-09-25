// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import S from '@/messages/en/specSource.json';
import { fail, mockFetch, ok, renderUi } from '@/components/apis/endpoints/test-utils';
import type { SpecSourceStatus } from '@/lib/api/spec-source';
import { SpecSourceSheet } from './spec-source-sheet';

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }));
vi.mock('@/components/ui/sonner', () => ({ toast }));

const STORED: Extract<SpecSourceStatus, { configured: true }> = {
  configured: true,
  url: 'https://specs.example.com/…',
  enabled: false,
  intervalMinutes: 360,
  lastCheckedAt: null,
  lastSuccessAt: null,
  nextCheckAt: null,
  lastResult: null,
  lastErrorCode: null,
  consecutiveFailures: 0,
};
const SECRET_URL = 'https://specs.example.com/openapi.yaml?token=S3CRET';

const formOf = (el: HTMLElement): HTMLFormElement => {
  const form = el.closest('form');
  if (!form) throw new Error('not inside a form');
  return form;
};

const allToasts = () => Object.values(toast).flatMap((fn) => fn.mock.calls.map((c) => JSON.stringify(c)));

function open(source: typeof STORED | null = null) {
  const onOpenChange = vi.fn();
  renderUi(<SpecSourceSheet apiId="api-1" source={source} open onOpenChange={onOpenChange} />);
  return { onOpenChange, url: screen.getByLabelText(S.sheet.urlLabel) };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('SpecSourceSheet', () => {
  it('create: the URL is required', async () => {
    const calls = mockFetch(() => ok(STORED));
    open();
    fireEvent.click(screen.getByRole('button', { name: S.sheet.save }));
    expect(await screen.findByText(S.url.required)).toBeDefined();
    expect(calls).toHaveLength(0);
  });

  it.each([
    ['https://user:pass@specs.example.com/spec', S.url.userinfo],
    ['ftp://specs.example.com/spec', S.url.scheme],
    ['specs.example.com/spec', S.url.invalid],
  ])('refuses %s before any request', async (value, message) => {
    const calls = mockFetch(() => ok(STORED));
    const { url } = open();
    fireEvent.change(url, { target: { value } });
    fireEvent.click(screen.getByRole('button', { name: S.sheet.save }));
    expect(await screen.findByText(message)).toBeDefined();
    expect(calls).toHaveLength(0);
  });

  it('the URL field never offers autofill or spell check', () => {
    mockFetch(() => ok(STORED));
    const { url } = open();
    expect(url.getAttribute('autocomplete')).toBe('off');
    expect(url.getAttribute('spellcheck')).toBe('false');
    expect(url.getAttribute('dir')).toBe('ltr');
    expect(screen.getByText(S.sheet.urlHelp)).toBeDefined();
  });

  it('create: PUTs the URL in the JSON body (never the path), default hourly and enabled; the toast has no URL', async () => {
    const calls = mockFetch(() => ok(STORED));
    const { url, onOpenChange } = open();
    fireEvent.change(url, { target: { value: `  ${SECRET_URL}  ` } });
    fireEvent.click(screen.getByRole('button', { name: S.sheet.save }));
    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
    expect(calls[0]).toMatchObject({ method: 'PUT', path: '/apis/api-1/spec-source' });
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({ url: SECRET_URL, intervalMinutes: 60, enabled: true });
    expect(toast.success).toHaveBeenCalledWith(S.sheet.savedToast);
    expect(allToasts().join()).not.toContain('S3CRET');
  });

  it('edit: an empty URL keeps the stored one (omitted from the body); schedule and switch come from the source', async () => {
    const calls = mockFetch(() => ok(STORED));
    open(STORED);
    expect(screen.getByText('Stored URL: https://specs.example.com/…. Leave empty to keep it.')).toBeDefined();
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false');
    fireEvent.click(screen.getByRole('switch'));
    fireEvent.click(screen.getByRole('button', { name: S.sheet.save }));
    await waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({ intervalMinutes: 360, enabled: true });
  });

  it('a URL the server refuses (422 SPEC_FETCH_BLOCKED_TARGET) is explained on the field, with no toast', async () => {
    mockFetch(() => fail(422, `refused ${SECRET_URL}`, 'SPEC_FETCH_BLOCKED_TARGET'));
    const { url, onOpenChange } = open();
    fireEvent.change(url, { target: { value: SECRET_URL } });
    fireEvent.click(screen.getByRole('button', { name: S.sheet.save }));
    expect(await screen.findByText(S.errors.BLOCKED_TARGET)).toBeDefined();
    expect(allToasts()).toHaveLength(0);
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.queryByText(/S3CRET/)).toBeNull();
  });

  it('any other failure is a translated toast without the server text', async () => {
    mockFetch(() => fail(400, `too many sources ${SECRET_URL}`, 'BAD_REQUEST'));
    const { url } = open();
    fireEvent.change(url, { target: { value: SECRET_URL } });
    fireEvent.click(screen.getByRole('button', { name: S.sheet.save }));
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(S.errors.saveFailed);
    });
    expect(allToasts().join()).not.toContain('S3CRET');
  });

  it('the 50-sources cap (400 SPEC_SOURCE_LIMIT) has its own text', async () => {
    mockFetch(() => fail(400, 'limit', 'SPEC_SOURCE_LIMIT'));
    const { url } = open();
    fireEvent.change(url, { target: { value: SECRET_URL } });
    fireEvent.click(screen.getByRole('button', { name: S.sheet.save }));
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(S.errors.SPEC_SOURCE_LIMIT);
    });
  });

  it('an edit without a stored URL (400 SPEC_SOURCE_URL_REQUIRED) is explained on the field', async () => {
    mockFetch(() => fail(400, 'url required', 'SPEC_SOURCE_URL_REQUIRED'));
    open(STORED);
    fireEvent.click(screen.getByRole('button', { name: S.sheet.save }));
    expect(await screen.findByText(S.errors.SPEC_SOURCE_URL_REQUIRED)).toBeDefined();
    expect(allToasts()).toHaveLength(0);
  });

  it('keyboard only: every control is focusable in order and Enter in the URL field submits', async () => {
    const calls = mockFetch(() => ok(STORED));
    const { url, onOpenChange } = open();
    const order = [url, screen.getByRole('combobox'), screen.getByRole('switch'), screen.getByRole('button', { name: S.sheet.save })];
    for (const el of order) {
      el.focus();
      expect(document.activeElement).toBe(el);
      expect(el.getAttribute('tabindex')).not.toBe('-1');
    }
    fireEvent.change(url, { target: { value: SECRET_URL } });
    url.focus();
    // Enter in a text field submits its form: that is what the browser does, dispatched here as `submit`.
    fireEvent.submit(formOf(url));
    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
    expect(calls).toHaveLength(1);
  });

  it('cancel resets and closes without a request', () => {
    const calls = mockFetch(() => ok(STORED));
    const { url, onOpenChange } = open();
    fireEvent.change(url, { target: { value: SECRET_URL } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(calls).toHaveLength(0);
  });
});
