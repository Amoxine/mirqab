/**
 * WP13b acceptance: OAS definitions across the multinode profile, and proof that CLASSIC rows are
 * untouched by the change.
 *
 * Covers:
 *   1. an OAS-format definition is accepted by /tyk/apis/oas on every node
 *   2. its normalised doc hashes IDENTICALLY across all 3 nodes (WP13a's hash, same strip list)
 *   3. a CLASSIC definition still serves 200 through the data plane (the WP26b edge, HTTPS)
 *   4. no pre-existing row was rewritten: still CLASSIC, still no oasDocument
 *
 * Usage:
 *   TYK_NODES=… TYK_ADMIN_SECRET=… TYK_EDGE_URL=https://localhost:33005 \
 *   pnpm --filter @open-gateway/database exec tsx scripts/wp13b-acceptance.ts
 */
import { createHash } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const SECRET = process.env.TYK_ADMIN_SECRET ?? '';
const NODES = (process.env.TYK_NODES ?? '').split(',').map((n) => n.trim()).filter(Boolean);
const EDGE = (process.env.TYK_EDGE_URL ?? 'https://localhost:33005').replace(/\/$/, '');
const SUFFIX = Date.now().toString(36);
const OAS_ID = `wp13b-oas-${SUFFIX}`;
const CLASSIC_ID = `wp13b-classic-${SUFFIX}`;
const UPSTREAM = process.env.TYK_TEST_UPSTREAM ?? 'http://wp13b-upstream:9000';

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

type Doc = Record<string, unknown>;
async function tyk<T = Doc>(node: string, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${node}${path}`, {
    ...init,
    headers: { 'x-tyk-authorization': SECRET, 'content-type': 'application/json', ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(10_000),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${node}${path} -> ${res.status} ${body.slice(0, 160)}`);
  return (body ? JSON.parse(body) : {}) as T;
}

/** Same normalisation as ReconcileService.definitionHash. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Doc)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => [k, sortKeys(v)]),
  );
}
function hash(doc: Doc): string {
  const copy = structuredClone(doc);
  const xtyk = copy['x-tyk-api-gateway'] as Doc | undefined;
  const info = xtyk?.info as Doc | undefined;
  if (info) Reflect.deleteProperty(info, 'state');
  Reflect.deleteProperty(copy, '_id');
  Reflect.deleteProperty(copy, 'internal_id');
  return createHash('sha256').update(JSON.stringify(sortKeys(copy))).digest('hex');
}

const oasDoc = (): Doc => ({
  openapi: '3.0.3',
  info: { title: OAS_ID, version: '1.0.0' },
  paths: {},
  'x-tyk-api-gateway': {
    info: { id: OAS_ID, name: OAS_ID, orgId: 'og-wp13b', state: { active: true } },
    upstream: { url: UPSTREAM, rateLimit: { enabled: true, rate: 10, per: '60s' } },
    server: {
      listenPath: { value: `/${OAS_ID}/`, strip: true },
      authentication: { enabled: false },
    },
    middleware: { global: { trafficLogs: { enabled: true } } },
  },
});

const classicDef = (): Doc => ({
  name: CLASSIC_ID,
  api_id: CLASSIC_ID,
  org_id: 'og-wp13b',
  proxy: { listen_path: `/${CLASSIC_ID}/`, target_url: UPSTREAM, strip_listen_path: true },
  version_data: { not_versioned: true, versions: { Default: { name: 'Default' } } },
  use_keyless: true,
  active: true,
});

async function main(): Promise<void> {
  if (!SECRET || NODES.length < 2) throw new Error('TYK_ADMIN_SECRET and 2+ TYK_NODES are required');
  console.log(`WP13b acceptance across ${String(NODES.length)} nodes\n`);

  try {
    // ─── 1. OAS accepted on every node ────────────────────────────────
    const accepted: boolean[] = [];
    for (const node of NODES) {
      try {
        await tyk(node, '/apis/oas', { method: 'POST', body: JSON.stringify(oasDoc()) });
        await tyk(node, '/reload/?block=true');
        accepted.push(true);
      } catch (err) {
        console.log(`     ${node}: ${String(err).slice(0, 160)}`);
        accepted.push(false);
      }
    }
    check('POST /tyk/apis/oas accepted on every node', accepted.every(Boolean), `${accepted.filter(Boolean).length}/${accepted.length}`);

    // ─── 2. identical hash across nodes ───────────────────────────────
    const docs = await Promise.all(NODES.map((n) => tyk<Doc>(n, `/apis/oas/${OAS_ID}`)));
    const hashes = docs.map(hash);
    check(
      "an OAS definition's normalised doc is identical on every node",
      new Set(hashes).size === 1,
      `${hashes[0].slice(0, 12)}… on all ${String(hashes.length)}`,
    );

    // ─── 3. a CLASSIC definition still serves 200 through the edge ────
    for (const node of NODES) {
      await tyk(node, '/apis', { method: 'POST', body: JSON.stringify(classicDef()) });
      await tyk(node, '/reload/?block=true');
    }
    // The edge fronts `tyk-gateway` (node 1) and terminates TLS; -k because it issues from its own
    // internal CA (WP26b).
    let code = 0;
    let body = '';
    for (let attempt = 0; attempt < 10 && code !== 200; attempt += 1) {
      const res = await fetch(`${EDGE}/${CLASSIC_ID}/ping`, { signal: AbortSignal.timeout(10_000) });
      code = res.status;
      body = (await res.text()).slice(0, 80);
      if (code !== 200) await new Promise((r) => setTimeout(r, 1500));
    }
    check('a CLASSIC definition still serves 200 through the edge (HTTPS)', code === 200, `${String(code)} ${body.trim()}`);

    // ─── 4. no pre-existing row was rewritten ─────────────────────────
    const rows = await prisma.apiDefinition.findMany({ select: { name: true, defFormat: true, oasDocument: true } });
    const preExisting = rows.filter((r) => r.defFormat === 'CLASSIC');
    check(
      'pre-existing rows are still CLASSIC with no oasDocument — the migration rewrote nothing',
      preExisting.length > 0 && preExisting.every((r) => r.oasDocument === null),
      `${String(preExisting.length)} CLASSIC row(s): ${preExisting.map((r) => r.name).join(', ')}`,
    );
  } finally {
    for (const node of NODES) {
      await tyk(node, `/apis/oas/${OAS_ID}`, { method: 'DELETE' }).catch(() => undefined);
      await tyk(node, `/apis/${CLASSIC_ID}`, { method: 'DELETE' }).catch(() => undefined);
      await tyk(node, '/reload/?block=true').catch(() => undefined);
    }
  }

  console.log(failures === 0 ? '\n✅ all WP13b acceptance checks passed' : `\n❌ ${String(failures)} check(s) failed`);
  if (failures > 0) process.exitCode = 1;
}

main()
  .catch((err: unknown) => {
    console.error(`\n❌ ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
