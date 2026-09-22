/**
 * WP15a acceptance: traffic middleware, asserted on BEHAVIOUR rather than on emitted fields.
 *
 * Every check states which component answered, because with the WP26b edge in front of the gateway
 * two things can produce a 413 and only one of them is this WP's.
 *
 * Usage:
 *   TYK_ADMIN=http://127.0.0.1:18081/tyk TYK_DATA=http://127.0.0.1:18080 TYK_ADMIN_SECRET=… \
 *   pnpm --filter @open-gateway/database exec tsx scripts/wp15a-acceptance.ts
 */
const SECRET = process.env.TYK_ADMIN_SECRET ?? '';
// Defaults address the gateway BY SERVICE NAME, i.e. this script is meant to run from a container
// on the compose network (§6's curl-container pattern), not from the host through a published
// tunnel. That is not stylistic: a host-side socat hop adds enough per-request latency that a
// 100-request burst stretches past the 1-second rate-limit window and ~13 extra requests are
// legitimately allowed, which reads as a failing rate limiter when the limiter is exactly right.
const ADMIN = (process.env.TYK_ADMIN ?? 'http://tyk-gateway:8081/tyk').replace(/\/$/, '');
const DATA = (process.env.TYK_DATA ?? 'http://tyk-gateway:8080').replace(/\/$/, '');
const SLOW = process.env.SLOW_UPSTREAM ?? 'http://wp15a-slow:9000';
const ECHO_A = process.env.ECHO_A ?? 'http://wp15a-a:9000';
const ECHO_B = process.env.ECHO_B ?? 'http://wp15a-b:9000';
const ID = `wp15a-${Date.now().toString(36)}`;

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

const apiId = (suffix: string) => `${ID}-${suffix}`;

/** Classic definition; `extra` merges the per-case traffic middleware. */
function def(suffix: string, target: string, extra: Doc = {}, versionExtra: Doc = {}): Doc {
  return {
    name: apiId(suffix),
    api_id: apiId(suffix),
    org_id: 'og-wp15a',
    proxy: { listen_path: `/${apiId(suffix)}/`, target_url: target, strip_listen_path: true },
    version_data: {
      not_versioned: true,
      versions: { Default: { name: 'Default', ...versionExtra } },
    },
    use_keyless: true,
    active: true,
    ...extra,
  };
}

async function publish(d: Doc): Promise<void> {
  await tyk('/apis', { method: 'POST', body: JSON.stringify(d) });
  await tyk('/reload/?block=true');
}

async function main(): Promise<void> {
  if (!SECRET) throw new Error('TYK_ADMIN_SECRET is required');
  console.log('WP15a acceptance — traffic middleware\n');
  const made: string[] = [];

  try {
    // ── 1. rate limit: 10 rps, 100-request burst ────────────────────────
    const rl = apiId('rl');
    made.push(rl);
    await publish(def('rl', ECHO_A, { global_rate_limit: { rate: 10, per: 1 } }));

    const burst = await Promise.all(
      Array.from({ length: 100 }, () =>
        fetch(`${DATA}/${rl}/x`, { signal: AbortSignal.timeout(15_000) }).then((r) => ({
          status: r.status,
          limit: r.headers.get('x-ratelimit-limit'),
          remaining: r.headers.get('x-ratelimit-remaining'),
          reset: r.headers.get('x-ratelimit-reset'),
        })),
      ),
    );
    const tooMany = burst.filter((r) => r.status === 429);
    // 10 rps means ~10 allowed PER WINDOW, so the assertion only holds if the whole burst lands
    // inside one window; anything slower legitimately allows more.
    check(
      '10 rps: >=90% of a 100-request burst returns 429 (answered by: Tyk gateway)',
      tooMany.length >= 90,
      `${String(tooMany.length)}/100 were 429, ${String(burst.filter((r) => r.status === 200).length)} were 200`,
    );

    // AMENDED from the plan's "429 carrying X-RateLimit-*", on measurement. Three separate facts
    // about Tyk OSS v5.15.0, none of them configurable:
    //   (a) the headers are emitted ONLY on ALLOWED responses, never on a 429;
    //   (b) they describe the KEY'S QUOTA, not the rate limit — with rate 10/s and quota_max 57 the
    //       header reads 57, and `Remaining` counts the quota down;
    //   (c) they come from the key/session limiter, so a KEYLESS api-wide `global_rate_limit`
    //       emits nothing at all — which is this API, hence the assertion below.
    // Emitting spec-correct headers on a 429 needs a response plugin; the owner parked that as a
    // §8 follow-up rather than building it here.
    const keylessHasNoHeaders = tooMany.every((r) => r.limit === null && r.remaining === null && r.reset === null);
    check(
      'known Tyk OSS limit: a keyless api-wide rate limit emits NO X-RateLimit-* headers, and never on a 429',
      keylessHasNoHeaders,
      `${String(tooMany.length)} × 429, none carrying the headers — documented limit, see wp15a-ratelimit-headers.spec.ts for the keyed/quota behaviour that DOES emit them`,
    );

    // ── 2. enforced timeout: 1s limit vs a 3s upstream ──────────────────
    const to = apiId('to');
    made.push(to);
    await publish(
      def('to', SLOW, {}, {
        use_extended_paths: true,
        extended_paths: { hard_timeouts: [{ path: '/.*', method: 'GET', timeout: 1 }] },
      }),
    );
    const timeoutRes = await fetch(`${DATA}/${to}/slow?delay=3`, { signal: AbortSignal.timeout(20_000) });
    check(
      '1s enforced timeout against a 3s upstream returns 504 (answered by: Tyk gateway)',
      timeoutRes.status === 504,
      `got ${String(timeoutRes.status)}`,
    );

    // ── 3. request size limit: which component answers the 413? ─────────
    const sz = apiId('sz');
    made.push(sz);
    const PER_API_LIMIT = 1024;
    await publish(
      def('sz', ECHO_A, {}, {
        use_extended_paths: true,
        extended_paths: { size_limits: [{ path: '/.*', method: 'POST', size_limit: PER_API_LIMIT }] },
      }),
    );
    const oversize = 'x'.repeat(PER_API_LIMIT * 4);
    const sizeRes = await fetch(`${DATA}/${sz}/upload`, {
      method: 'POST',
      body: oversize,
      signal: AbortSignal.timeout(15_000),
    });
    const sizeBody = (await sizeRes.text()).slice(0, 200);
    // AMENDED from the plan's 413, on measurement: Tyk v5.15.0 answers an oversize body with 400
    // "Request is too large". `StatusRequestEntityTooLarge` does not appear anywhere in the gateway
    // binary, so no configuration produces a 413 — translating it would need a response plugin,
    // which the owner ruled out as cosmetics.
    //
    // ATTRIBUTION, which is the part that matters: this request goes straight to the gateway's data
    // port and never traverses the edge, so only Tyk can have answered. The per-API limit (1 KiB)
    // is far below Coraza's 10 MB, and the DTO caps every API at the edge's value, so the gateway
    // is always the smaller enforcer — the answer is Tyk's for every API, not just this one.
    check(
      `oversize body (${String(oversize.length)}B vs ${String(PER_API_LIMIT)}B limit) returns 400 (answered by: TYK GATEWAY — request did not traverse the edge; plan said 413, Tyk has no 413 path)`,
      sizeRes.status === 400,
      `got ${String(sizeRes.status)}; body: ${sizeBody.replace(/\s+/g, ' ').trim()}`,
    );

    // ── 4. load balancing: both targets receive traffic ─────────────────
    const lb = apiId('lb');
    made.push(lb);
    await publish(
      def('lb', ECHO_A, { proxy: {
        listen_path: `/${lb}/`,
        target_url: ECHO_A,
        strip_listen_path: true,
        enable_load_balancing: true,
        target_list: [ECHO_A, ECHO_B],
      } }),
    );
    const hits = await Promise.all(
      Array.from({ length: 100 }, () =>
        fetch(`${DATA}/${lb}/who`, { signal: AbortSignal.timeout(15_000) }).then((r) => r.text()),
      ),
    );
    const a = hits.filter((h) => h.includes('wp15a-a')).length;
    const b = hits.filter((h) => h.includes('wp15a-b')).length;
    check(
      'both load-balanced targets receive traffic over 100 requests',
      a > 0 && b > 0,
      `target A: ${String(a)}, target B: ${String(b)} (of 100)`,
    );
  } finally {
    for (const id of made) await tyk(`/apis/${id}`, { method: 'DELETE' }).catch(() => undefined);
    await tyk('/reload/?block=true').catch(() => undefined);
  }

  console.log(failures === 0 ? '\n✅ all WP15a acceptance checks passed' : `\n❌ ${String(failures)} check(s) failed`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error(`\n❌ ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
