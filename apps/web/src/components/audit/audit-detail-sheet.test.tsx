// @vitest-environment jsdom
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import analytics from '@/messages/en/analytics.json';
import { fail, mockFetch, never, ok } from '@/components/apis/endpoints/test-utils';
import { renderApp } from '@/components/dashboard/test-render';
import { AuditDetailSheet } from './audit-detail-sheet';

const A = analytics.auditLogs;
const WAIT = { timeout: 8000 };
const entry = {
  id: '17',
  action: 'UPDATED',
  resource: 'apis',
  createdAt: '2026-09-29T10:00:00.000Z',
  ipAddress: '10.0.0.7',
  corrId: 'corr-123',
  user: { name: 'Ada Lovelace', email: 'ada@example.com' },
  details: { resourceId: 'api-1', requestBody: { name: 'Orders', apiKey: '[REDACTED]' } },
};
const dialog = () => screen.findByRole('dialog', undefined, WAIT);

describe('AuditDetailSheet', () => {
  it('shows what happened, who did it, on what, when and from where', async () => {
    const calls = mockFetch(() => ok(entry));
    renderApp(<AuditDetailSheet id="17" onClose={vi.fn()} />);
    const d = await dialog();
    expect(await within(d).findByText('Ada Lovelace', undefined, WAIT)).toBeDefined();
    expect(within(d).getByText('ada@example.com')).toBeDefined();
    expect(within(d).getByText('Updated')).toBeDefined();
    expect(within(d).getByText('apis')).toBeDefined();
    expect(within(d).getByText('10.0.0.7')).toBeDefined();
    expect(within(d).getByText('corr-123')).toBeDefined();
    expect(within(d).getByRole('heading', { name: A.detail.title })).toBeDefined();
    expect(calls.map((c) => c.path)).toEqual(['/audit-logs/17']);
  });

  it('shows the recorded details as readable JSON, left to right whatever the language', async () => {
    mockFetch(() => ok(entry));
    renderApp(<AuditDetailSheet id="17" onClose={vi.fn()} />);
    const d = await dialog();
    const block = await within(d).findByText(/"resourceId": "api-1"/, undefined, WAIT);
    expect(block.tagName).toBe('PRE');
    expect(block.getAttribute('dir')).toBe('ltr');
    // Indented, not one line; and what the server redacted stays redacted.
    expect(block.textContent).toBe(JSON.stringify(entry.details, null, 2));
    expect(block.textContent).toContain('[REDACTED]');
  });

  it('names the actor "System" when no one did it', async () => {
    mockFetch(() => ok({ ...entry, user: null }));
    renderApp(<AuditDetailSheet id="17" onClose={vi.fn()} />);
    const d = await dialog();
    expect(await within(d).findByText(A.systemUser, undefined, WAIT)).toBeDefined();
  });

  it('says so when nothing more was recorded, and leaves out an empty address and correlation id', async () => {
    mockFetch(() => ok({ ...entry, details: null, ipAddress: null, corrId: null }));
    renderApp(<AuditDetailSheet id="17" onClose={vi.fn()} />);
    const d = await dialog();
    expect(await within(d).findByText(A.detail.noDetails, undefined, WAIT)).toBeDefined();
    expect(within(d).queryByText(A.columns.ipAddress)).toBeNull();
    expect(within(d).queryByText(A.detail.correlationId)).toBeNull();
  });

  it('shows a loading state while the entry is on its way', async () => {
    mockFetch(() => never());
    renderApp(<AuditDetailSheet id="17" onClose={vi.fn()} />);
    const d = await dialog();
    expect(d.querySelector('[aria-busy="true"]')).not.toBeNull();
  });

  it('says the entry could not be loaded, with a retry that asks again', async () => {
    const calls = mockFetch(() => fail(404, 'gone'));
    renderApp(<AuditDetailSheet id="17" onClose={vi.fn()} />);
    const d = await dialog();
    expect(await within(d).findByText(A.detail.loadError, undefined, WAIT)).toBeDefined();
    fireEvent.click(within(d).getByRole('button', { name: 'Retry' }));
    await vi.waitFor(() => {
      expect(calls.length).toBeGreaterThan(1);
    }, WAIT);
  });

  it('is closed, and asks for nothing, without an id', () => {
    const calls = mockFetch(() => ok(entry));
    renderApp(<AuditDetailSheet id={null} onClose={vi.fn()} />);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('asks to close on Escape', async () => {
    mockFetch(() => ok(entry));
    const onClose = vi.fn();
    renderApp(<AuditDetailSheet id="17" onClose={onClose} />);
    await dialog();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await vi.waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    }, WAIT);
  });
});

describe('AuditDetailSheet: what it hides', () => {
  const adopt = {
    ...entry,
    action: 'CREATED',
    details: {
      resourceId: 'api-1',
      syncStatus: 'SYNCED',
      node: 'tyk-gateway:8081',
      nodeUrl: 'http://tyk-gateway:8081',
      tykApiId: 'a1b2c3',
      error: 'retried http://tyk-gateway:8081/tyk/apis, then gave up',
      public: 'https://api.example.com/v1',
    },
  };

  it('does not show the platform’s internal addressing in the details, whatever the stored entry holds', async () => {
    mockFetch(() => ok(adopt));
    renderApp(<AuditDetailSheet id="17" onClose={vi.fn()} />);
    const d = await dialog();
    const block = await within(d).findByText(/"resourceId": "api-1"/, undefined, WAIT);
    expect(block.textContent).not.toContain('tyk-gateway');
    expect(block.textContent).not.toContain('a1b2c3');
    expect(block.textContent).toContain('"node": "••••"');
    expect(block.textContent).toContain('"tykApiId": "••••"');
    // Everything else is as recorded, including a public URL.
    expect(block.textContent).toContain('"syncStatus": "SYNCED"');
    expect(block.textContent).toContain('"public": "https://api.example.com/v1"');
    expect(block.textContent).toContain('retried ••••, then gave up');
  });
});

describe('AuditDetailSheet: the details block', () => {
  it('is a named region that a keyboard can scroll, not an anonymous focus stop', async () => {
    mockFetch(() => ok(entry));
    renderApp(<AuditDetailSheet id="17" onClose={vi.fn()} />);
    const d = await dialog();
    const region = await within(d).findByRole('region', { name: A.detail.details }, WAIT);
    expect(region.tagName).toBe('PRE');
    expect(region.getAttribute('tabindex')).toBe('0');
  });
});

describe('AuditDetailSheet: focus when it closes', () => {
  function Closable({ withRow }: { withRow: boolean }) {
    const [id, setId] = useState<string | null>('17');
    return (
      <>
        <main id="main-content" tabIndex={-1}>
          {'page'}
        </main>
        {withRow && (
          <a href="/audit-logs?open=17" data-focus-return="audit:17">
            {'entry 17'}
          </a>
        )}
        <AuditDetailSheet
          id={id}
          onClose={() => {
            setId(null);
          }}
        />
      </>
    );
  }
  const close = async () => {
    await dialog();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    }, WAIT);
  };

  it('returns focus to the entry’s link in the list, which a click on the row never focused', async () => {
    mockFetch(() => ok(entry));
    renderApp(<Closable withRow />);
    await close();
    await waitFor(() => {
      expect(document.activeElement?.textContent).toBe('entry 17');
    }, WAIT);
  });

  it('falls back to the page’s main content when the entry is not in the list (opened by a link)', async () => {
    mockFetch(() => ok(entry));
    renderApp(<Closable withRow={false} />);
    await close();
    await waitFor(() => {
      expect(document.activeElement?.id).toBe('main-content');
    }, WAIT);
  });
});
