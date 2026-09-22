/**
 * WP12c acceptance checks, run against a live gateway + database.
 *
 * These cannot be unit tests: every one of them is a claim about what the Tyk gateway actually does
 * with an org, and the whole point of WP12c is that the previous behaviour (one shared org) looked
 * correct in code and was wrong on the gateway.
 *
 * Covers, in order:
 *   1. no tenant-owned definition or policy is left outside a tenant org
 *   2. two tenants may hold the SAME `listenPath` and each routes to its own upstream
 *   3. cutting off tenant A's org 403s every key of A and leaves B's key at 200
 *   4. `GET /tyk/certs?org_id=<A>` never returns B's certs
 *
 * Creates its own throwaway tenants/APIs/keys/cert and removes them again, so it is safe to re-run.
 * It does NOT touch pre-existing tenants beyond reading them.
 *
 * Usage:
 *   pnpm --filter @open-gateway/database exec tsx scripts/wp12c-acceptance.ts
 *
 * Env: TYK_ADMIN_URL, TYK_ADMIN_SECRET, TYK_DATA_URL (data plane, default http://127.0.0.1:33005)
 */
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { tykOrgIdFor } from '../src/index';

const prisma = new PrismaClient();
const ADMIN = (process.env.TYK_ADMIN_URL ?? 'http://127.0.0.1:18081/tyk').replace(/\/$/, '');
const DATA = (process.env.TYK_DATA_URL ?? 'http://127.0.0.1:33005').replace(/\/$/, '');
const SECRET = process.env.TYK_ADMIN_SECRET ?? '';
// Local echo upstream on the compose network; it returns the path it was called on, which is
// what makes "each tenant reaches its OWN upstream" observable rather than inferred.
const UPSTREAM = process.env.TYK_TEST_UPSTREAM ?? 'http://wp12c-upstream:9000';

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

type Doc = Record<string, unknown>;
async function tyk<T = Doc>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${ADMIN}${path}`, {
    ...init,
    headers: { 'x-tyk-authorization': SECRET, 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path} -> ${res.status} ${body.slice(0, 200)}`);
  return (body ? JSON.parse(body) : {}) as T;
}

async function call(path: string, key: string): Promise<{ code: number; body: string }> {
  const res = await fetch(`${DATA}${path}`, { headers: { Authorization: key } });
  return { code: res.status, body: (await res.text()).slice(0, 200) };
}

/** Poll until `want` or the budget runs out — org-session changes take a beat to reach the node. */
async function settle(path: string, key: string, want: number, ms = 20000): Promise<{ code: number; body: string }> {
  const deadline = Date.now() + ms;
  let last = { code: 0, body: '' };
  while (Date.now() < deadline) {
    last = await call(path, key);
    if (last.code === want) return last;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return last;
}

async function main(): Promise<void> {
  if (!SECRET) throw new Error('TYK_ADMIN_SECRET is required');
  const suffix = randomUUID().slice(0, 8);
  const made: { tenantIds: string[]; apiIds: string[]; certIds: string[] } = {
    tenantIds: [],
    apiIds: [],
    certIds: [],
  };

  try {
    // ─── 1. nothing left outside a tenant org ────────────────────────
    const orgs = new Set((await prisma.tenant.findMany({ select: { tykOrgId: true } })).map((t) => t.tykOrgId));
    const dbDefs = await prisma.apiDefinition.findMany({ select: { tykApiId: true } });
    const owned = new Set(dbDefs.map((d) => d.tykApiId).filter((x): x is string => Boolean(x)));
    const defs = (await tyk<Doc[]>('/apis')).filter((d) => owned.has(String(d.api_id)));
    const strayDefs = defs.filter((d) => !orgs.has(String(d.org_id)));
    check(
      'no tenant-owned definition carries a non-tenant org (e.g. org123)',
      strayDefs.length === 0,
      `${defs.length} checked, ${strayDefs.length} stray`,
    );
    const pols = await tyk<Doc[]>('/policies');
    const strayPols = pols.filter((p) => {
      const rights = Object.keys((p.access_rights ?? {}) as Doc);
      return rights.some((a) => owned.has(a)) && !orgs.has(String(p.org_id));
    });
    check(
      'no tenant-owned policy carries a non-tenant org',
      strayPols.length === 0,
      `${pols.length} policies on the gateway, ${strayPols.length} stray`,
    );

    // ─── two throwaway tenants sharing one listenPath ────────────────
    const shared = '/payments/';
    const tenants = await Promise.all(
      ['a', 'b'].map(async (letter) => {
        const id = randomUUID();
        const t = await prisma.tenant.create({
          data: { id, tykOrgId: tykOrgIdFor(id), name: `wp12c-${letter}-${suffix}`, slug: `wp12c-${letter}-${suffix}` },
        });
        made.tenantIds.push(t.id);
        return t;
      }),
    );

    for (const [i, t] of tenants.entries()) {
      const apiId = `og-wp12c-${i}-${suffix}`;
      await tyk('/apis', {
        method: 'POST',
        body: JSON.stringify({
          name: apiId,
          api_id: apiId,
          org_id: t.tykOrgId,
          proxy: {
            listen_path: `/${t.slug}${shared}`,
            // distinct upstream per tenant, so "routes to its own upstream" is observable
            target_url: `${UPSTREAM}/upstream-of-${t.slug}`,
            strip_listen_path: true,
          },
          version_data: { not_versioned: true, versions: { Default: { name: 'Default' } } },
          use_keyless: false,
          use_standard_auth: true,
          auth: { auth_header_name: 'Authorization' },
          active: true,
        }),
      });
      made.apiIds.push(apiId);
    }
    await tyk('/reload/group');
    await new Promise((r) => setTimeout(r, 4000));

    const keys = await Promise.all(
      tenants.map(async (t, i) => {
        const res = await tyk<{ key: string }>('/keys/create', {
          method: 'POST',
          body: JSON.stringify({
            org_id: t.tykOrgId,
            quota_max: -1,
            rate: 1000,
            per: 1,
            expires: -1,
            access_rights: {
              [`og-wp12c-${i}-${suffix}`]: {
                api_id: `og-wp12c-${i}-${suffix}`,
                api_name: `og-wp12c-${i}-${suffix}`,
                versions: ['Default'],
              },
            },
          }),
        });
        return res.key;
      }),
    );

    // ─── 2. same listenPath, different upstream ──────────────────────
    const pathA = `/${tenants[0].slug}${shared}`;
    const pathB = `/${tenants[1].slug}${shared}`;
    const resA = await settle(pathA, keys[0], 200);
    const resB = await settle(pathB, keys[1], 200);
    const hitOwnUpstream =
      resA.code === 200 &&
      resB.code === 200 &&
      resA.body.includes(`upstream-of-${tenants[0].slug}`) &&
      resB.body.includes(`upstream-of-${tenants[1].slug}`);
    check(
      `two tenants both own "${shared}" and each reaches its OWN upstream`,
      hitOwnUpstream,
      `A -> ${resA.code} ${resA.body.trim()} | B -> ${resB.code} ${resB.body.trim()}`,
    );

    // ─── 3. org cutoff isolates one tenant ───────────────────────────
    await tyk(`/org/keys/${tenants[0].tykOrgId}`, {
      method: 'POST',
      body: JSON.stringify({
        org_id: tenants[0].tykOrgId,
        is_inactive: true,
        allowance: -1,
        rate: -1,
        per: 1,
        quota_max: -1, // never impose an org quota as a side effect of the cutoff flag
      }),
    });
    const cutA = await settle(pathA, keys[0], 403);
    const stillB = await settle(pathB, keys[1], 200);
    check("cutting off tenant A's org 403s A's key", cutA.code === 403, `got ${cutA.code}`);
    check("tenant B's key is unaffected by A's cutoff", stillB.code === 200, `got ${stillB.code}`);

    // ─── 4. cert isolation ───────────────────────────────────────────
    const pem = await makeSelfSignedPem();
    const certA = await tyk<{ id: string }>(`/certs?org_id=${tenants[0].tykOrgId}`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: pem,
    });
    made.certIds.push(certA.id);
    const listB = await tyk<{ certs: string[] | null }>(`/certs?org_id=${tenants[1].tykOrgId}`);
    const listA = await tyk<{ certs: string[] | null }>(`/certs?org_id=${tenants[0].tykOrgId}`);
    check(
      "GET /tyk/certs?org_id=<A> returns A's cert",
      (listA.certs ?? []).includes(certA.id),
      `A sees ${JSON.stringify(listA.certs)}`,
    );
    check(
      "GET /tyk/certs?org_id=<B> never returns A's cert",
      !(listB.certs ?? []).includes(certA.id),
      `B sees ${JSON.stringify(listB.certs)}`,
    );
  } finally {
    // ─── cleanup ───────────────────────────────────────────────────
    for (const id of made.certIds) {
      const org = (await prisma.tenant.findFirst({ where: { id: made.tenantIds[0] } }))?.tykOrgId;
      await tyk(`/certs/${id}?org_id=${org ?? ''}`, { method: 'DELETE' }).catch(() => undefined);
    }
    for (const id of made.apiIds) await tyk(`/apis/${id}`, { method: 'DELETE' }).catch(() => undefined);
    for (const id of made.tenantIds) {
      const t = await prisma.tenant.findUnique({ where: { id }, select: { tykOrgId: true } });
      if (t) {
        // leave no org session behind, or a re-run inherits a cut-off org
        await tyk(`/org/keys/${t.tykOrgId}`, { method: 'DELETE' }).catch(() => undefined);
      }
      await prisma.tenant.delete({ where: { id } }).catch(() => undefined);
    }
    await tyk('/reload/group').catch(() => undefined);
  }

  console.log(failures === 0 ? '\n✅ all WP12c acceptance checks passed' : `\n❌ ${failures} check(s) failed`);
  if (failures > 0) process.exitCode = 1;
}

/** Self-signed cert+key PEM, via openssl (present in every image this runs in). */
async function makeSelfSignedPem(): Promise<string> {
  const { execFileSync } = await import('node:child_process');
  const { mkdtempSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'wp12c-'));
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem'),
    '-days', '1', '-subj', '/CN=wp12c-acceptance',
  ]);
  return readFileSync(join(dir, 'c.pem'), 'utf8') + readFileSync(join(dir, 'k.pem'), 'utf8');
}

main()
  .catch((err: unknown) => {
    console.error(`\n❌ ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
