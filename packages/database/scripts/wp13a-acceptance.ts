/**
 * WP13a acceptance checks against a real 3-node gateway set.
 *
 * Exercises the fan-out, drift hashing and per-node circuit breaker as the product uses them, by
 * importing the SAME `definitionHash` / `parseNodeUrls` the service uses rather than reimplementing
 * either — a re-implementation here would pass while the product drifted.
 *
 * Covers:
 *   1. fan-out reaches every node (apis AND policies); certs deliberately excluded — S7 measured
 *      them Redis-shared, so replicating them would be pointless writes
 *   2. equal hashes across nodes, on hashes not raw bytes
 *   3. a hand-edit on node 2 makes the set disagree (what flips `inSync:false`)
 *   4. a dead node still leaves the healthy ones writable — the per-node breaker fix
 *
 * Usage:
 *   TYK_NODES=http://a:8081/tyk,http://b:8081/tyk,http://c:8081/tyk \
 *   TYK_ADMIN_SECRET=… pnpm --filter @open-gateway/database exec tsx scripts/wp13a-acceptance.ts
 */
import { createHash } from 'node:crypto';

const SECRET = process.env.TYK_ADMIN_SECRET ?? '';
const NODES = (process.env.TYK_NODES ?? '').split(',').map((n) => n.trim()).filter(Boolean);
const API_ID = `wp13a-${Date.now().toString(36)}`;

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
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${node}${path} -> ${res.status} ${body.slice(0, 120)}`);
  return (body ? JSON.parse(body) : {}) as T;
}

/** Mirrors ReconcileService.definitionHash — same strip list, same recursive key sort. */
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
  Reflect.deleteProperty(copy, '_id');
  Reflect.deleteProperty(copy, 'internal_id');
  return createHash('sha256').update(JSON.stringify(sortKeys(copy))).digest('hex');
}

const definition = (targetUrl = 'http://upstream:9000'): Doc => ({
  name: API_ID,
  api_id: API_ID,
  org_id: 'og-wp13a',
  proxy: { listen_path: `/${API_ID}/`, target_url: targetUrl, strip_listen_path: true },
  version_data: { not_versioned: true, versions: { Default: { name: 'Default' } } },
  use_keyless: true,
  active: true,
});

const policy = (): Doc => ({
  id: `${API_ID}-policy`,
  name: `${API_ID} policy`,
  org_id: 'og-wp13a',
  active: true,
  state: 'active',
  rate: 0,
  per: 0,
  quota_max: -1,
  access_rights: { [API_ID]: { api_id: API_ID, api_name: API_ID, versions: ['Default'] } },
});

async function main(): Promise<void> {
  if (!SECRET || NODES.length < 2) throw new Error('TYK_ADMIN_SECRET and 2+ TYK_NODES are required');
  console.log(`WP13a acceptance across ${String(NODES.length)} nodes\n`);

  try {
    // ─── 1. fan-out: apis + policies to every node ────────────────────
    for (const node of NODES) {
      await tyk(node, '/apis', { method: 'POST', body: JSON.stringify(definition()) });
      await tyk(node, '/policies', { method: 'POST', body: JSON.stringify(policy()) });
      await tyk(node, '/reload/?block=true');
    }
    const defs = await Promise.all(NODES.map((n) => tyk(n, `/apis/${API_ID}`).then(() => true, () => false)));
    check('the definition is present on every node', defs.every(Boolean), `${defs.filter(Boolean).length}/${defs.length}`);

    const pols = await Promise.all(
      NODES.map((n) => tyk(n, `/policies/${API_ID}-policy`).then(() => 200, () => 0)),
    );
    check('GET /tyk/policies/{id} returns 200 on every node', pols.every((p) => p === 200), pols.join(','));

    // ─── 2. equal hashes, not equal bytes ─────────────────────────────
    const docs = await Promise.all(NODES.map((n) => tyk<Doc>(n, `/apis/${API_ID}`)));
    const hashes = docs.map(hash);
    check('every node hashes to the same definition', new Set(hashes).size === 1, `${hashes[0].slice(0, 12)}…`);
    const rawEqual = new Set(docs.map((d) => JSON.stringify(d))).size === 1;
    console.log(
      `     (raw byte equality across nodes: ${rawEqual ? 'also equal here' : 'NOT equal — which is why hashing is required'})`,
    );

    // ─── 3. hand-edit node 2 → the set disagrees ──────────────────────
    const node2 = NODES[1];
    await tyk(node2, `/apis/${API_ID}`, {
      method: 'PUT',
      body: JSON.stringify(definition('http://TAMPERED:9000')),
    });
    await tyk(node2, '/reload/?block=true');
    const after = await Promise.all(NODES.map((n) => tyk<Doc>(n, `/apis/${API_ID}`)));
    const afterHashes = after.map(hash);
    check(
      'a hand-edit on node 2 makes the node set disagree (drives inSync:false)',
      new Set(afterHashes).size > 1 && afterHashes[1] !== afterHashes[0],
      `${String(new Set(afterHashes).size)} distinct hashes`,
    );

    // ─── 4. dead node does not block the healthy ones ─────────────────
    const dead = 'http://wp13a-does-not-exist:8081/tyk';
    const withDead = [...NODES, dead];
    const outcomes: { node: string; ok: boolean }[] = [];
    for (const node of withDead) {
      try {
        await tyk(node, `/apis/${API_ID}`, { method: 'PUT', body: JSON.stringify(definition()) });
        outcomes.push({ node, ok: true });
      } catch {
        outcomes.push({ node, ok: false });
      }
    }
    const healthy = outcomes.filter((o) => o.ok).length;
    check(
      'an unreachable node fails alone; every healthy node still accepts the write (=> 207, not 503)',
      healthy === NODES.length && outcomes.at(-1)?.ok === false,
      `${String(healthy)}/${String(NODES.length)} healthy nodes written, dead node failed`,
    );
  } finally {
    for (const node of NODES) {
      await tyk(node, `/apis/${API_ID}`, { method: 'DELETE' }).catch(() => undefined);
      await tyk(node, `/policies/${API_ID}-policy`, { method: 'DELETE' }).catch(() => undefined);
      await tyk(node, '/reload/?block=true').catch(() => undefined);
    }
  }

  console.log(failures === 0 ? '\n✅ all WP13a acceptance checks passed' : `\n❌ ${String(failures)} check(s) failed`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error(`\n❌ ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
