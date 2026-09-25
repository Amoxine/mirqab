import 'reflect-metadata';
import { NotFoundException } from '@nestjs/common';
import { ApiStatus } from '@prisma/client';
import type { ApiDefinition } from '@prisma/client';
import { parseYaml } from '@stoplight/spectral-parsers';
import type * as SpectralParsers from '@stoplight/spectral-parsers';
import { prisma } from '@open-gateway/database';
import { RetiredVersionException, type ApiService } from '../../api-management/services/api.service';
import { mapToTykOas } from '../../api-management/services/tyk-mappers';
import { PortalApiDocService } from './portal-api-doc.service';

jest.mock('@open-gateway/database', () => ({
  prisma: {
    tenant: { findUniqueOrThrow: jest.fn() },
    apiSpec: { findFirst: jest.fn() },
    productApi: { findFirst: jest.fn() },
  },
}));

// The real YAML parser, wrapped so a test can prove it was (not) called and stub it for a hostile document.
jest.mock('@stoplight/spectral-parsers', () => {
  const actual = jest.requireActual<typeof SpectralParsers>('@stoplight/spectral-parsers');
  return { ...actual, parseYaml: jest.fn(actual.parseYaml) };
});

const parseYamlMock = parseYaml as unknown as jest.Mock;
const { parseYaml: realParseYaml } = jest.requireActual<typeof SpectralParsers>('@stoplight/spectral-parsers');

const db = prisma as unknown as {
  tenant: { findUniqueOrThrow: jest.Mock };
  apiSpec: { findFirst: jest.Mock };
  productApi: { findFirst: jest.Mock };
};

const TENANT = { tykOrgId: 'og-t1', slug: 'acme' };
const TENANT_ID = 'tenant-1';
const API_ID = '11111111-1111-1111-1111-111111111111';
const SERVER = [{ url: '/acme/orders' }];

// Hosts a developer must never learn from the portal.
const INTERNAL = ['internal-orders.corp', 'internal-lb-2.corp', 'internal-probe.corp', 'spec-server.corp'];

/** A real row, so the generated document below is exactly what `mapToTykOas` emits for it. */
function apiDef(): ApiDefinition {
  return {
    id: 'a1',
    tenantId: TENANT_ID,
    name: 'Orders',
    slug: 'orders',
    tykApiId: null,
    proxyUrl: 'http://internal-orders.corp:8443/v1',
    listenPath: '/orders/',
    authType: 'AUTH_TOKEN',
    status: 'ACTIVE',
    config: {
      loadBalancing: { targets: [{ url: 'http://internal-lb-2.corp:9000', weight: 1 }] },
      uptimeTests: [{ url: 'http://internal-probe.corp/health' }],
    },
    syncStatus: 'SYNCED',
    syncError: null,
    syncState: null,
    defFormat: 'OAS',
    parentApiId: null,
    retiredAt: null,
    versionName: null,
    oasDocument: null,
    lastSyncedAt: null,
    healthStatus: 'UNKNOWN',
    createdAt: new Date(0),
    updatedAt: new Date(0),
  } as unknown as ApiDefinition;
}

const specDocument = () => ({
  openapi: '3.0.3',
  info: { title: 'Orders', version: '1', description: '<script>alert(1)</script>' },
  servers: [{ url: 'https://spec-server.corp/v1' }],
  'x-tyk-api-gateway': { upstream: { url: 'http://spec-server.corp' } },
  paths: {
    '/orders': {
      servers: [{ url: 'http://spec-server.corp/path' }],
      get: { operationId: 'listOrders', summary: 'List', responses: {} },
      post: { operationId: 'createOrder', responses: {} },
    },
    '/orders/{id}': { delete: { operationId: 'deleteOrder', responses: {} } },
  },
  components: { schemas: { Order: { $ref: 'http://spec-server.corp/schema.json' } } },
});

const specYaml = `openapi: 3.0.3
info:
  title: Orders
  version: "1"
servers:
  - url: https://spec-server.corp/v1
x-tyk-api-gateway:
  upstream:
    url: http://spec-server.corp
paths:
  /orders:
    get:
      operationId: listOrders
      summary: List <b>orders</b>
      responses: {}
`;

interface Stored {
  contentHash?: string;
  format?: 'json' | 'yaml';
  sourceText: string;
}

/**
 * `ApiService.findOne`'s answer (the parts of `ApiDetail` the service reads) and the two spec
 * queries, all driven by `state` so a test can change the world between two calls.
 */
function setup(
  options: {
    config?: Record<string, unknown>;
    oasDocument?: unknown;
    stored?: Stored | null;
    status?: ApiStatus;
    inProduct?: boolean;
  } = {},
) {
  const state = { config: options.config ?? {}, stored: options.stored ?? null, readDelayMs: 0, failReads: 0 };
  const findOne = jest.fn().mockImplementation(() =>
    Promise.resolve({
      id: API_ID,
      name: 'Orders',
      authType: 'AUTH_TOKEN',
      listenPath: '/orders/',
      status: options.status ?? ApiStatus.ACTIVE,
      config: state.config,
      oasDocument: options.oasDocument ?? null,
    }),
  );
  db.tenant.findUniqueOrThrow.mockResolvedValue(TENANT);
  db.productApi.findFirst.mockResolvedValue(options.inProduct === false ? null : { productId: 'product-1' });
  db.apiSpec.findFirst.mockImplementation(async (args: { select: Record<string, boolean> }) => {
    const { stored } = state;
    if (stored === null) return null;
    if (!args.select.sourceText) {
      return { versionNo: 1, contentHash: stored.contentHash ?? 'hash-1', format: stored.format ?? 'json' };
    }
    await new Promise((resolve) => setTimeout(resolve, state.readDelayMs));
    if (state.failReads > 0) {
      state.failReads -= 1;
      throw new Error('database unavailable');
    }
    return { sourceText: stored.sourceText };
  });
  const service = new PortalApiDocService({ findOne } as unknown as ApiService);
  return { service, findOne, state };
}

const wire = (value: unknown): string => JSON.stringify(value);

/** Calls that read the (large) source text, as opposed to the version summary. */
const sourceReads = (): number =>
  (db.apiSpec.findFirst.mock.calls as [{ select: Record<string, boolean> }][]).filter(([args]) => args.select.sourceText).length;

beforeEach(() => {
  jest.resetAllMocks();
  parseYamlMock.mockImplementation(realParseYaml);
});

describe('PortalApiDocService — an API without a stored spec (the generated document)', () => {
  // MOCKED persistence: the mapper and the sanitizer are real, the rows come from fakes.
  it('serves no upstream host and no x-tyk-* extension, and points servers at the gateway', async () => {
    const { service } = setup({ oasDocument: mapToTykOas(apiDef(), TENANT) });

    const result = await service.forTenant(API_ID, TENANT_ID);

    expect(wire(result.oasDocument)).not.toContain('x-tyk-');
    for (const host of INTERNAL) expect(wire(result.oasDocument)).not.toContain(host);
    expect(result.oasDocument?.servers).toEqual(SERVER);
    expect(result.gatewayListenPath).toBe('/acme/orders/');
  });

  it('answers a null document for a classic API (no generated document)', async () => {
    const { service } = setup({ oasDocument: null });

    expect((await service.forTenant(API_ID, TENANT_ID)).oasDocument).toBeNull();
  });
});

describe('PortalApiDocService — an API with a stored spec', () => {
  it.each([
    ['JSON', { format: 'json' as const, sourceText: JSON.stringify(specDocument()) }],
    ['YAML', { format: 'yaml' as const, sourceText: specYaml }],
  ])('serves the stored %s spec, sanitized, in preference to the generated document', async (_label, stored) => {
    const { service } = setup({ oasDocument: mapToTykOas(apiDef(), TENANT), stored });

    const result = await service.forTenant(API_ID, TENANT_ID);

    expect(result.oasDocument).not.toBeNull();
    const document = result.oasDocument ?? {};
    expect(Object.keys(document.paths as object)).toContain('/orders');
    expect(document.servers).toEqual(SERVER);
    expect(wire(document)).not.toContain('x-tyk-');
    for (const host of INTERNAL) expect(wire(document)).not.toContain(host);
    // Preferred over the generated document: no synthetic catch-all operation from it.
    expect(wire(document)).not.toContain('catchAll');
  });

  it('keeps description text as the same string (it is rendered as plain text by the web)', async () => {
    const { service } = setup({ stored: { sourceText: JSON.stringify(specDocument()) } });

    const document = (await service.forTenant(API_ID, TENANT_ID)).oasDocument as { info: { description: string } };

    expect(document.info.description).toBe('<script>alert(1)</script>');
  });

  it('drops the operations endpoint governance blocks, by endpoint key', async () => {
    const config = { endpoints: { createOrder: { enabled: false }, listOrders: { rateLimit: { rate: 1, per: 60 } } } };
    const { service } = setup({ config, stored: { sourceText: JSON.stringify(specDocument()) } });

    const document = (await service.forTenant(API_ID, TENANT_ID)).oasDocument as { paths: Record<string, object> };

    expect(Object.keys(document.paths['/orders'] ?? {})).toEqual(['get']);
    expect(Object.keys(document.paths)).toContain('/orders/{id}');
  });

  it('answers null, never the generated document, when the stored spec cannot be served', async () => {
    const generated = mapToTykOas(apiDef(), TENANT);
    const broken: [string, Stored][] = [
      ['invalid JSON', { format: 'json', sourceText: '{"openapi": ' }],
      ['YAML the parser throws on', { format: 'yaml', sourceText: 'openapi: 3.0.3\nx: !!binary aGk=\n' }],
      ['a YAML alias bomb', { format: 'yaml', sourceText: `a: &a [x]\n${'b: *a\n'.repeat(10)}` }],
      ['a scalar', { format: 'json', sourceText: '42' }],
    ];

    for (const [, stored] of broken) {
      jest.resetAllMocks();
      const { service } = setup({ oasDocument: generated, stored });

      expect((await service.forTenant(API_ID, TENANT_ID)).oasDocument).toBeNull();
    }
  });
});

describe('PortalApiDocService — a YAML alias bomb', () => {
  it('with NON-ASCII anchors is refused before the YAML parser is ever called', async () => {
    // 10 aliases of a `é` anchor: expands exponentially when nested, and the parser would run for as
    // long as it likes on the one event loop. The stub throws so a missing guard cannot hang this test.
    const bomb = ['a: &é [x]', ...Array.from({ length: 10 }, (_, i) => `b${String(i)}: *é`)].join('\n');
    const { service } = setup({ stored: { format: 'yaml', sourceText: bomb } });
    parseYamlMock.mockImplementation(() => {
      throw new Error('the YAML parser must not run on this document');
    });

    const result = await service.forTenant(API_ID, TENANT_ID);

    expect(result.oasDocument).toBeNull();
    expect(parseYamlMock).not.toHaveBeenCalled();
  });
});

describe('PortalApiDocService — tenant scope', () => {
  it('answers 404 for another tenant\'s API and reads nothing else', async () => {
    const { service, findOne } = setup();
    findOne.mockRejectedValue(new NotFoundException('API not found'));

    await expect(service.forTenant(API_ID, 'tenant-b')).rejects.toBeInstanceOf(NotFoundException);

    expect(findOne).toHaveBeenCalledWith(API_ID, 'tenant-b');
    expect(db.tenant.findUniqueOrThrow).not.toHaveBeenCalled();
    expect(db.apiSpec.findFirst).not.toHaveBeenCalled();
  });

  it('carries the tenant id in every spec query', async () => {
    const { service } = setup({ stored: { sourceText: JSON.stringify(specDocument()) } });

    await service.forTenant(API_ID, TENANT_ID);

    const calls = db.apiSpec.findFirst.mock.calls as [{ where: Record<string, unknown> }][];
    expect(calls).toHaveLength(2);
    for (const [args] of calls) expect(args.where).toMatchObject({ tenantId: TENANT_ID, apiDefId: API_ID });
    expect(db.productApi.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { apiDefId: API_ID, product: { tenantId: TENANT_ID } } }),
    );
  });
});

describe('PortalApiDocService — the parse is paid once', () => {
  it('reads and parses the source text once per (spec version, server, blocked set)', async () => {
    const { service } = setup({ stored: { sourceText: JSON.stringify(specDocument()) } });

    const first = await service.forTenant(API_ID, TENANT_ID);
    const second = await service.forTenant(API_ID, TENANT_ID);

    expect(sourceReads()).toBe(1);
    expect(second.oasDocument).toEqual(first.oasDocument);
  });

  it('reads again when the spec content changes or governance blocks another endpoint', async () => {
    const source = JSON.stringify(specDocument());
    const { service, state } = setup({ stored: { contentHash: 'hash-1', sourceText: source } });
    await service.forTenant(API_ID, TENANT_ID);

    state.stored = { contentHash: 'hash-2', sourceText: source };
    await service.forTenant(API_ID, TENANT_ID);
    expect(sourceReads()).toBe(2);

    state.config = { endpoints: { createOrder: { enabled: false } } };
    const result = await service.forTenant(API_ID, TENANT_ID);
    expect(sourceReads()).toBe(3);
    expect(Object.keys((result.oasDocument as { paths: Record<string, object> }).paths['/orders'] ?? {})).toEqual(['get']);
  });
});

describe('PortalApiDocService — who may read a document (ACTIVE and in a product of the tenant)', () => {
  const stored = { sourceText: JSON.stringify(specDocument()) };
  const missing = () => new NotFoundException('API definition not found');

  it.each([ApiStatus.DRAFT, ApiStatus.DISABLED, ApiStatus.RETIRED])(
    'answers the missing-id 404 for a %s API, and reads no spec',
    async (status) => {
      const { service } = setup({ status, stored });

      const error: unknown = await service.forTenant(API_ID, TENANT_ID).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(NotFoundException);
      expect((error as NotFoundException).getResponse()).toEqual(missing().getResponse());
      expect(db.apiSpec.findFirst).not.toHaveBeenCalled();
    },
  );

  it('answers 404, not the dashboard\'s 410, for a retired version', async () => {
    const { service, findOne } = setup({ stored });
    findOne.mockRejectedValue(new RetiredVersionException(new Date(0), 'v1'));

    const error: unknown = await service.forTenant(API_ID, TENANT_ID).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(NotFoundException);
    expect(db.apiSpec.findFirst).not.toHaveBeenCalled();
  });

  it('answers 404 for an ACTIVE API that is in no product, and reads no spec', async () => {
    const { service } = setup({ inProduct: false, stored });

    await expect(service.forTenant(API_ID, TENANT_ID)).rejects.toBeInstanceOf(NotFoundException);

    expect(db.apiSpec.findFirst).not.toHaveBeenCalled();
    expect(db.tenant.findUniqueOrThrow).not.toHaveBeenCalled();
  });

  it('serves an ACTIVE API that is in a product', async () => {
    const { service } = setup({ stored });

    const result = await service.forTenant(API_ID, TENANT_ID);

    expect(result.oasDocument).not.toBeNull();
  });

  it('applies the same rule to the generated document (no stored spec)', async () => {
    const { service } = setup({ oasDocument: mapToTykOas(apiDef(), TENANT), inProduct: false });

    await expect(service.forTenant(API_ID, TENANT_ID)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('PortalApiDocService — concurrent cache misses', () => {
  it('share ONE source read and ONE parse', async () => {
    const source = JSON.stringify(specDocument());
    const { service, state } = setup({ stored: { sourceText: source } });
    state.readDelayMs = 25; // keep the requests overlapping
    const parse = jest.spyOn(JSON, 'parse');

    try {
      const results = await Promise.all(Array.from({ length: 8 }, () => service.forTenant(API_ID, TENANT_ID)));

      expect(sourceReads()).toBe(1);
      expect(parse.mock.calls.filter(([text]) => text === source)).toHaveLength(1);
      expect(new Set(results.map((result) => wire(result.oasDocument))).size).toBe(1);
      expect(results[0]?.oasDocument).not.toBeNull();
    } finally {
      parse.mockRestore();
    }
  });

  it('do not remember a failed build: the next request tries again', async () => {
    const { service, state } = setup({ stored: { sourceText: JSON.stringify(specDocument()) } });
    state.failReads = 1;

    await expect(service.forTenant(API_ID, TENANT_ID)).rejects.toThrow('database unavailable');
    const second = await service.forTenant(API_ID, TENANT_ID);

    expect(second.oasDocument).not.toBeNull();
    expect(sourceReads()).toBe(2);
  });
});

describe('PortalApiDocService — cache weight and key', () => {
  it('weighs an entry by the sanitized document, not by its source text', async () => {
    // Insignificant whitespace: a 9 MB source that sanitizes to a few hundred bytes.
    const padded = JSON.stringify(specDocument()) + ' '.repeat(9 * 1024 * 1024);
    const { service } = setup({ stored: { sourceText: padded } });

    await service.forTenant(API_ID, TENANT_ID);
    await service.forTenant(API_ID, TENANT_ID);

    expect(sourceReads()).toBe(1);
  });

  it('keeps two blocked sets apart even when a blocked key contains a newline', async () => {
    const { service, state } = setup({ stored: { sourceText: JSON.stringify(specDocument()) } });
    const paths = (result: { oasDocument: unknown }) => (result.oasDocument as { paths: Record<string, object> }).paths;

    // One key that merely LOOKS like two ...
    state.config = { endpoints: { 'createOrder\nlistOrders': { enabled: false } } };
    const nothingBlocked = await service.forTenant(API_ID, TENANT_ID);
    // ... and the two real keys, which would share its cache key if the key were a joined string.
    state.config = { endpoints: { createOrder: { enabled: false }, listOrders: { enabled: false } } };
    const bothBlocked = await service.forTenant(API_ID, TENANT_ID);

    expect(Object.keys(paths(nothingBlocked))).toContain('/orders');
    expect(Object.keys(paths(bothBlocked))).not.toContain('/orders');
  });
});
