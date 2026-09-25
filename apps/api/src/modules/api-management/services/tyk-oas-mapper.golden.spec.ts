import 'reflect-metadata';
import type { ApiDefinition, Prisma } from '@prisma/client';
import golden from './__fixtures__/tyk-oas-mapper.golden.pre-oas03.json';
import { mapToTykOas } from './tyk-mappers';
import type { EndpointRef } from './endpoint-operations';

jest.mock('@open-gateway/database', () => ({ prisma: {} }));

/**
 * OAS-03 rule 10: an API WITHOUT endpoint governance renders exactly as it did before OAS-03. The golden
 * was produced by the COMMITTED mapper (see `source` in the fixture), not by this working tree, so this
 * test cannot drift along with the code it checks.
 */

const refs: EndpointRef[] = [
  { key: 'listOrders', method: 'GET', path: '/orders' },
  { key: 'getOrder', method: 'GET', path: '/{id}' },
];

function apiDef(authType: string, config: Record<string, unknown>): ApiDefinition {
  return {
    id: 'a1',
    tenantId: 't1',
    name: 'Orders',
    slug: 'orders',
    tykApiId: 'og-a1',
    proxyUrl: 'http://orders:4000',
    listenPath: '/orders/',
    authType,
    status: 'ACTIVE',
    config: config as Prisma.JsonValue,
    parentApiId: null,
    versionName: null,
    retiredAt: null,
    webhooksEnabled: false,
    protocol: 'HTTP',
    defFormat: 'OAS',
  } as unknown as ApiDefinition;
}

describe('mapToTykOas without governance matches the pre-OAS-03 golden', () => {
  it('was generated from a commit', () => {
    expect(golden.source).toMatch(/^git show [0-9a-f]{7,40}:/);
    expect(golden.cases).toHaveLength(3);
  });

  it.each(golden.cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const tenant = { tykOrgId: 'og-t1', slug: 'acme' };
    // No refs, refs with nothing governed, an empty map, and orphan-only governance all render identically.
    for (const extra of [{}, { endpoints: {} }, { endpoints: { notInIndex: { enabled: false } } }, { restrictToSpec: false }]) {
      const def = apiDef(c.authType, { ...c.config, ...extra });
      expect(mapToTykOas(def, tenant, '')).toEqual(c.output);
      expect(mapToTykOas(def, tenant, '', [], refs)).toEqual(c.output);
    }
    // The comparison is sensitive: the moment one endpoint IS governed, the output differs from the golden.
    const governed = apiDef(c.authType, { ...c.config, endpoints: { listOrders: { enabled: false } } });
    expect(mapToTykOas(governed, tenant, '', [], refs)).not.toEqual(c.output);
  });
});
