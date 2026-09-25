// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import type { PortalApiDoc } from '@/hooks/use-portal';
import { wrap } from './test-utils';
import { ApiDocsSection } from './api-docs-section';

const doc = vi.hoisted(() => ({ current: null as PortalApiDoc | null }));

vi.mock('@/hooks/use-portal', () => ({
  usePortalApiDoc: () => ({ data: doc.current, isLoading: false, isError: false, error: null }),
}));

const SCRIPT = '<script>alert(1)</script>';
const IMG = '<img src=x onerror="alert(1)">';

function apiWith(oasDocument: Record<string, unknown> | null, name = 'Orders'): PortalApiDoc {
  return { id: 'api-1', name, authType: 'AUTH_TOKEN', gatewayListenPath: '/acme/orders/', oasDocument };
}

function renderDocs(api: PortalApiDoc) {
  doc.current = api;
  return render(wrap(<ApiDocsSection apiId={api.id} />));
}

describe('ApiDocsSection', () => {
  it('lists one row per operation of a real specification, not one per path-item key', () => {
    renderDocs(
      apiWith({
        openapi: '3.0.3',
        paths: {
          '/orders': {
            summary: 'Shared summary',
            description: 'Shared description',
            servers: [{ url: '/acme/orders' }],
            parameters: [{ name: 'trace', in: 'header' }],
            'x-internal': true,
            get: { summary: 'List' },
            post: { summary: 'Create' },
          },
          '/orders/{id}': { $ref: '#/components/pathItems/One', delete: {} },
        },
      }),
    );

    const rows = within(screen.getByRole('list')).getAllByRole('listitem');
    expect(rows.map((row) => row.textContent)).toEqual(['GET/orders', 'POST/orders', 'DELETE/orders/{id}']);
  });

  it('shows spec-supplied text as inert text: no element, handler or javascript: link is created from it', () => {
    const { container } = renderDocs(
      apiWith(
        {
          openapi: '3.0.3',
          info: { title: SCRIPT, description: `${SCRIPT} ${IMG}`, termsOfService: 'javascript:alert(1)' },
          externalDocs: { url: 'javascript:alert(1)', description: IMG },
          paths: {
            [`/${SCRIPT}`]: {
              get: { summary: SCRIPT, description: `[click](javascript:alert(1)) ${IMG}` },
            },
          },
        },
        SCRIPT,
      ),
    );

    // The tenant-controlled strings that ARE rendered (the API name and the path) appear verbatim as text …
    expect(screen.getAllByText(SCRIPT).length).toBeGreaterThan(0);
    expect(screen.getByText(`/${SCRIPT}`)).toBeDefined();
    // … and nothing they contain became markup.
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('a[href^="javascript:" i]')).toBeNull();
    expect(container.innerHTML).not.toContain('onerror=');
  });

  it.each([
    ['a null path item', { '/a': null }],
    ['a string path item', { '/a': 'nope' }],
    ['a numeric path item', { '/a': 7 }],
    ['an array path item', { '/a': [{ get: {} }] }],
    ['paths as an array', [{ get: {} }]],
    ['paths as a string', 'nope'],
  ])('does not crash on %s and shows the empty state', (_label, paths) => {
    renderDocs(apiWith({ openapi: '3.0.3', paths }));

    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
    expect(screen.getByText('Orders')).toBeDefined();
  });

  it('shows the empty state for an API without a document (classic)', () => {
    renderDocs(apiWith(null));

    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
  });
});
