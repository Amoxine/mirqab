// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import apisMessages from '@/messages/en/apis.json';
import commonMessages from '@/messages/en/common.json';
import dashboardMessages from '@/messages/en/dashboard.json';
import { EndpointList } from './endpoint-list';

const M = apisMessages;

const wrap = (ui: React.ReactNode) => (
  <NextIntlClientProvider locale="en" messages={{ apis: apisMessages, common: commonMessages, dashboard: dashboardMessages }}>
    {ui}
  </NextIntlClientProvider>
);

describe('EndpointList', () => {
  it('shows the empty state when the OAS document has no paths', () => {
    render(wrap(<EndpointList oasDocument={{ paths: {} }} />));
    expect(screen.getByText(M.designer.endpoints.empty)).toBeDefined();
  });

  it('shows the empty state for a null (CLASSIC-format) document', () => {
    render(wrap(<EndpointList oasDocument={null} />));
    expect(screen.getByText(M.designer.endpoints.empty)).toBeDefined();
  });

  it('flattens paths x methods into one row each, derived from the document — never hand-entered', () => {
    render(
      wrap(
        <EndpointList
          oasDocument={{
            paths: {
              '/.*': {
                get: { operationId: 'catchAll_get' },
                post: { operationId: 'catchAll_post' },
              },
            },
          }}
        />,
      ),
    );
    expect(screen.getByText('GET')).toBeDefined();
    expect(screen.getByText('POST')).toBeDefined();
    expect(screen.getAllByText('/.*')).toHaveLength(2);
    expect(screen.getByText('catchAll_get')).toBeDefined();
  });
});
