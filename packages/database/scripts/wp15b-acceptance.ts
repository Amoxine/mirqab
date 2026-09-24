/**
 * WP15b acceptance: transform middleware and per-API detailed recording, on behaviour.
 *
 * Two assertions are deliberately structural rather than timing-based:
 *   - the MOCK is proved by stopping the upstream first, so a passing response cannot have come
 *     from it;
 *   - the CACHE is proved with an upstream hit COUNTER, never a wall clock — a "second request was
 *     faster" assertion passes on a warm connection pool and tells you nothing.
 *
 * Usage (from a container on the compose network):
 *   TYK_ADMIN_SECRET=… pnpm --filter @open-gateway/database exec tsx scripts/wp15b-acceptance.ts
 */
const SECRET = process.env.TYK_ADMIN_SECRET ?? '';
const ADMIN = (process.env.TYK_ADMIN ?? 'http://tyk-gateway:8081/tyk').replace(/\/$/, '');
const DATA = (process.env.TYK_DATA ?? 'http://tyk-gateway:8080').replace(/\/$/, '');
const ECHO = process.env.ECHO ?? 'http://wp15b-echo:9000';
const ECHO_CTL = process.env.ECHO_CTL ?? 'http://wp15b-echo:9001';
const ID = `wp15b-${Date.now().toString(36)}`;

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? `\n       ${detail}` : ''}`);
  if (!ok) failures += 1;
}

type Doc = Record<string, unknown>;
async function tyk<T = Doc>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${ADMIN}${path}`, {
    ...init,
    headers: { 'x-tyk-authorization': SECRET, 'content-type': 'application/json', ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(15_000),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path} -> ${res.status} ${body.slice(0, 160)}`);
  return (body ? JSON.parse(body) : {}) as T;
}

const hits = async (): Promise<number> =>
  Number((await (await fetch(`${ECHO_CTL}/count`, { signal: AbortSignal.timeout(5000) })).json() as { count: number }).count);
const resetHits = () => fetch(`${ECHO_CTL}/reset`, { signal: AbortSignal.timeout(5000) });
const setUpstream = (up: boolean) => fetch(`${ECHO_CTL}/${up ? 'up' : 'down'}`, { signal: AbortSignal.timeout(5000) });

function def(suffix: string, extra: Doc = {}, versionExtra: Doc = {}): Doc {
  return {
    name: `${ID}-${suffix}`,
    api_id: `${ID}-${suffix}`,
    org_id: 'og-wp15b',
    proxy: { listen_path: `/${ID}-${suffix}/`, target_url: ECHO, strip_listen_path: true },
    version_data: { not_versioned: true, versions: { Default: { name: 'Default', ...versionExtra } } },
    use_keyless: true,
    active: true,
    ...extra,
  };
}

async function publish(d: Doc): Promise<void> {
  await tyk('/apis', { method: 'POST', body: JSON.stringify(d) });
  await tyk('/reload/?block=true');
}


/**
 * Minimal Redis client over a raw socket — enough for SCAN/DEL, and deliberately dependency-free so
 * this script stays runnable from any container on the compose network.
 */
async function redisCmd(...args: string[]): Promise<string> {
  const { connect } = await import('node:net');
  return new Promise((resolve, reject) => {
    const sock = connect(6379, process.env.REDIS_HOST ?? 'redis');
    let out = '';
    sock.setTimeout(5000, () => { sock.destroy(); reject(new Error('redis timeout')); });
    sock.on('connect', () => {
      sock.write(`*${String(args.length)}\r\n` + args.map((a) => `$${String(a.length)}\r\n${a}\r\n`).join(''));
      setTimeout(() => { sock.end(); }, 400);
    });
    sock.on('data', (d: Buffer) => { out += d.toString(); });
    sock.on('close', () => { resolve(out); });
    sock.on('error', reject);
  });
}
const redisKeys = async (pattern: string): Promise<string[]> =>
  (await redisCmd('SCAN', '0', 'MATCH', pattern, 'COUNT', '1000'))
    .split('\r\n')
    .filter((l) => l.startsWith('cache-'));
const redisDel = (key: string) => redisCmd('DEL', key);

const made: string[] = [];
async function main(): Promise<void> {
  if (!SECRET) throw new Error('TYK_ADMIN_SECRET is required');
  console.log('WP15b acceptance — transform middleware\n');

  try {
    // ── 1. header inject + remove, observed AT THE UPSTREAM ────────────────
    const h = `${ID}-hdr`;
    made.push(h);
    await publish(
      def('hdr', {}, {
        use_extended_paths: true,
        extended_paths: {
          transform_headers: [
            {
              path: '/.*',
              method: 'GET',
              add_headers: { 'X-Injected': 'by-tyk' },
              delete_headers: ['X-Should-Vanish'],
            },
          ],
        },
      }),
    );
    const seen = (await (
      await fetch(`${DATA}/${h}/echo`, {
        headers: { 'X-Should-Vanish': 'please-remove-me' },
        signal: AbortSignal.timeout(15_000),
      })
    ).json()) as { headers: Record<string, string> };
    const lower = Object.fromEntries(Object.entries(seen.headers).map(([k, v]) => [k.toLowerCase(), v]));
    check('injected request header arrives at the upstream', lower['x-injected'] === 'by-tyk', `x-injected=${String(lower['x-injected'])}`);
    check('removed request header does NOT arrive at the upstream', lower['x-should-vanish'] === undefined, `x-should-vanish=${String(lower['x-should-vanish'])}`);

    // ── 2. url rewrite — the upstream reports the path it actually got ─────
    const rw = `${ID}-rw`;
    made.push(rw);
    await publish(
      def('rw', {}, {
        use_extended_paths: true,
        extended_paths: { url_rewrites: [{ path: '/.*', method: 'GET', match_pattern: '/old/(.*)', rewrite_to: '/new/$1' }] },
      }),
    );
    const rwBody = (await (await fetch(`${DATA}/${rw}/old/thing`, { signal: AbortSignal.timeout(15_000) })).json()) as { path: string };
    check('rewrite reaches the rewritten path', rwBody.path.startsWith('/new/thing'), `upstream saw ${rwBody.path}`);

    // ── 3. mock, WITH THE UPSTREAM STOPPED ─────────────────────────────────
    const mk = `${ID}-mock`;
    made.push(mk);
    await publish(
      def('mock', {}, {
        use_extended_paths: true,
        // `white_list` belongs UNDER extended_paths, not beside it — placed one level up it is
        // silently ignored and the request goes to the upstream, which is what a 503 here means.
        extended_paths: {
          white_list: [
            { path: '/.*', method_actions: { GET: { action: 'reply', code: 418, data: '{"mocked":true}', headers: { 'X-Mocked': 'yes' } } } },
          ],
        },
      }),
    );
    await setUpstream(false);
    const mockRes = await fetch(`${DATA}/${mk}/anything`, { signal: AbortSignal.timeout(15_000) });
    const mockBody = await mockRes.text();
    check(
      'mock returns the configured status+body with the UPSTREAM STOPPED (so it never reached it)',
      mockRes.status === 418 && mockBody.includes('"mocked":true'),
      `status=${String(mockRes.status)} body=${mockBody.slice(0, 60)}`,
    );
    await setUpstream(true);

    // ── 4. cache: header + upstream counter unchanged ──────────────────────
    const ch = `${ID}-cache`;
    made.push(ch);
    await publish(
      def('cache', { cache_options: { enable_cache: true, cache_timeout: 60, cache_all_safe_requests: true } }, {
        use_extended_paths: true,
        extended_paths: { cache: ['/.*'] },
      }),
    );
    await resetHits();
    const first = await fetch(`${DATA}/${ch}/cacheable`, { signal: AbortSignal.timeout(15_000) });
    await first.text();
    const afterFirst = await hits();
    const second = await fetch(`${DATA}/${ch}/cacheable`, { signal: AbortSignal.timeout(15_000) });
    await second.text();
    const afterSecond = await hits();

    check(
      'second identical request carries x-tyk-cached-response',
      second.headers.get('x-tyk-cached-response') !== null,
      `header=${String(second.headers.get('x-tyk-cached-response'))}`,
    );
    check(
      'upstream hit counter unchanged by the second request (counter, not wall clock)',
      afterSecond === afterFirst,
      `upstream hits: ${String(afterFirst)} -> ${String(afterSecond)}`,
    );

    // ── 5. invalidation drops the entry ────────────────────────────────────
    // DRIFT GUARD for the Redis workaround. Tyk's own DELETE /tyk/cache/{id} answers 200 and
    // deletes nothing on v5.15.0, so the product invalidates by removing these keys directly. That
    // only works while Tyk keeps writing them under this prefix — assert it, so an upstream change
    // fails here instead of silently restoring the no-op.
    const cacheKeys = await redisKeys(`cache-${ch}*`);
    check(
      'Tyk still writes response-cache keys under `cache-<apiId>*` (guards the Redis workaround)',
      cacheKeys.length > 0,
      `${String(cacheKeys.length)} key(s) matched — if this is 0, the invalidation workaround is broken, not the cache`,
    );

    // Tyk's own endpoint, called for completeness. Its result is RECORDED, NOT ASSERTED: measured
    // on v5.15.0 it succeeds roughly half the time under identical conditions (6 identical trials
    // alternated WORKED/NOTHING exactly 3-3). Asserting either outcome would give a 50% flaky test
    // — which is precisely why the product does not rely on it.
    await tyk(`/cache/${ch}`, { method: 'DELETE' });
    const survived = await redisKeys(`cache-${ch}*`);
    console.log(
      `  ℹ️  Tyk's DELETE /tyk/cache/{id} left ${String(survived.length)}/${String(cacheKeys.length)} keys ` +
        `(unreliable upstream, ~50% — recorded, never relied on)`,
    );

    // The invalidation the product actually performs: delete the keys itself, deterministically.
    for (const k of survived) await redisDel(k);
    // The gateway drops the entry asynchronously, so poll for the upstream to be reached again
    // rather than asserting on a single immediate read.
    let third = await fetch(`${DATA}/${ch}/cacheable`, { signal: AbortSignal.timeout(15_000) });
    await third.text();
    let afterThird = await hits();
    for (let i = 0; i < 8 && afterThird === afterSecond; i += 1) {
      await new Promise((r) => setTimeout(r, 1000));
      third = await fetch(`${DATA}/${ch}/cacheable`, { signal: AbortSignal.timeout(15_000) });
      await third.text();
      afterThird = await hits();
    }
    check(
      'invalidation drops the entry — the next request reaches the upstream again',
      afterThird > afterSecond && third.headers.get('x-tyk-cached-response') === null,
      `upstream hits: ${String(afterSecond)} -> ${String(afterThird)}, cached-header=${String(third.headers.get('x-tyk-cached-response'))}`,
    );
  } finally {
    await setUpstream(true).catch(() => undefined);
    for (const id of made) await tyk(`/apis/${id}`, { method: 'DELETE' }).catch(() => undefined);
    await tyk('/reload/?block=true').catch(() => undefined);
  }

  console.log(failures === 0 ? '\n✅ all WP15b acceptance checks passed' : `\n❌ ${String(failures)} check(s) failed`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error(`\n❌ ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
