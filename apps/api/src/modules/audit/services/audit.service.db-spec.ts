import { prisma } from '@open-gateway/database';
import type { AnalyticsService } from '../../analytics/services/analytics.service';
import { AuditService } from './audit.service';

/**
 * The audit list's `apiId` filter against a REAL Postgres with the real schema, because Prisma's JSON-path
 * filter is the part a mocked `findMany` cannot prove. Not part of `jest` (the name does not match
 * `.spec.ts`): it needs a THROWAWAY database with the migrations applied (`prisma migrate deploy`).
 *
 *   docker run -d --rm --name og-probe-search-pg -e POSTGRES_USER=t -e POSTGRES_PASSWORD=t \
 *     -e POSTGRES_DB=t -p 127.0.0.1:55451:5432 postgres:16-alpine
 *   export OG_THROWAWAY_DATABASE_URL='postgresql://t:t@127.0.0.1:55451/t?schema=public'
 *   (cd packages/database && DATABASE_URL=$OG_THROWAWAY_DATABASE_URL npx prisma migrate deploy)
 *   (cd apps/api && DATABASE_URL=$OG_THROWAWAY_DATABASE_URL npx jest --runInBand --testRegex 'audit\.service\.db-spec\.ts$')
 *   docker rm -f og-probe-search-pg
 */

jest.setTimeout(60_000);

const API_A = '6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f';
const API_B = '7a2d3e4f-5b6c-4d7e-9f80-1b2c3d4e5f60';

describe('AuditService apiId filter on a real Postgres', () => {
  const service = new AuditService({} as AnalyticsService);
  const tenants: string[] = [];

  const tenant = async (slug: string): Promise<string> => {
    const t = await prisma.tenant.create({ data: { name: slug, slug, tykOrgId: `og-${slug}` } });
    tenants.push(t.id);
    return t.id;
  };
  const log = (tenantId: string, resource: string, action: 'UPDATED' | 'CREATED', details: object | null) =>
    prisma.auditLog.create({ data: { tenantId, resource, action, details: details ?? undefined } });

  beforeAll(() => {
    const url = process.env.DATABASE_URL;
    if (!url || url !== process.env.OG_THROWAWAY_DATABASE_URL || url.includes(':33002')) {
      throw new Error('Refusing to run: DATABASE_URL must equal OG_THROWAWAY_DATABASE_URL and must not be the stack database');
    }
  });
  afterAll(async () => {
    await prisma.auditLog.deleteMany({ where: { tenantId: { in: tenants } } });
    await prisma.tenant.deleteMany({ where: { id: { in: tenants } } });
    await prisma.$disconnect();
  });

  it('returns exactly the apis rows that carry that API id, never another API, another resource or another tenant', async () => {
    const mine = await tenant('audit-spec-a');
    const other = await tenant('audit-spec-b');
    await log(mine, 'apis', 'UPDATED', { resourceId: API_A });
    await log(mine, 'apis', 'CREATED', { resourceId: API_A, requestBody: { x: 1 } });
    await log(mine, 'apis', 'UPDATED', { resourceId: API_B });
    await log(mine, 'keys', 'UPDATED', { resourceId: API_A }); // a key whose id happens to equal it: not an API row
    await log(mine, 'apis', 'CREATED', null); // an old row with no details
    await log(other, 'apis', 'UPDATED', { resourceId: API_A }); // another tenant's row about the same id

    const result = await service.findAll(mine, { apiId: API_A });
    expect(result.data).toHaveLength(2);
    expect(result.data.every((r) => r.resource === 'apis')).toBe(true);
    expect(result.meta.totalCount).toBe(2);

    expect((await service.findAll(mine, { apiId: API_B })).data).toHaveLength(1);
    expect((await service.findAll(other, { apiId: API_A })).data).toHaveLength(1);
    expect((await service.findAll(mine, { apiId: '11111111-2222-4333-8444-555555555555' })).data).toHaveLength(0);
    expect((await service.findAll(mine, {})).data).toHaveLength(5); // no filter: everything in the tenant
  });

  it('the apiId filter wins over a contradicting resource filter', async () => {
    const t = await tenant('audit-spec-c');
    await log(t, 'apis', 'UPDATED', { resourceId: API_A });
    await log(t, 'keys', 'UPDATED', { resourceId: API_A });
    expect((await service.findAll(t, { apiId: API_A, resource: 'keys' })).data).toHaveLength(1);
  });
});
