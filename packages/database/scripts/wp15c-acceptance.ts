/**
 * WP15c acceptance: security middleware, on behaviour.
 *
 * The assertion that matters most is the SPOOF one. Everything else here checks a feature works;
 * that one checks a defence cannot be walked around, which is a different and stricter claim. It
 * runs THROUGH THE EDGE over HTTPS, because that is the only path a real client has — testing it
 * against the gateway directly would prove nothing, since the gateway is not publicly reachable.
 *
 * Usage (from a container on the compose network):
 *   TYK_ADMIN_SECRET=… pnpm --filter @open-gateway/database exec tsx scripts/wp15c-acceptance.ts
 */
import { createHmac } from 'node:crypto';

const SECRET = process.env.TYK_ADMIN_SECRET ?? '';
const ADMIN = (process.env.TYK_ADMIN ?? 'http://tyk-gateway:8081/tyk').replace(/\/$/, '');
// Every data-plane call goes through the EDGE, because that is the only path a real client has:
// the gateway is `expose:`-only since WP26b. The edge routes on Host `localhost`, so this script
// runs from the HOST with the admin API tunnelled, not from a container.
const EDGE = (process.env.TYK_EDGE ?? 'https://localhost:33005').replace(/\/$/, '');
const DATA = EDGE;
const ECHO = process.env.ECHO ?? 'http://wp15c-echo:9000';
const ID = `wp15c-${Date.now().toString(36)}`;

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

const made: string[] = [];
function def(suffix: string, extra: Doc = {}, versionExtra: Doc = {}): Doc {
  made.push(`${ID}-${suffix}`);
  return {
    name: `${ID}-${suffix}`,
    api_id: `${ID}-${suffix}`,
    org_id: 'og-wp15c',
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
const key = async (session: Doc): Promise<string> =>
  (await tyk<{ key: string }>('/keys/create', { method: 'POST', body: JSON.stringify(session) })).key;

const status = async (url: string, init: RequestInit = {}): Promise<number> =>
  (await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) })).status;

async function main(): Promise<void> {
  if (!SECRET) throw new Error('TYK_ADMIN_SECRET is required');
  console.log('WP15c acceptance — security middleware\n');
  // Learn this client's IP AS THE GATEWAY SEES IT, by going through the edge to an echo API and
  // reading back the X-Forwarded-For the edge set. Asking the upstream directly would report the
  // wrong address — a container-to-container IP rather than the one the deny list is evaluated on.
  const probe = `${ID}-probe`;
  await publish(def('probe'));
  const probed = (await (
    await fetch(`${EDGE}/${probe}/whoami-through-edge`, { signal: AbortSignal.timeout(15_000) })
  ).json()) as { headers: Record<string, string> };
  const xff = Object.entries(probed.headers).find(([k]) => k.toLowerCase() === 'x-forwarded-for')?.[1] ?? '';
  // FIRST entry, not last. By the time the upstream sees it the chain is
  // `<what Caddy set>, <the gateway's own peer>` — the gateway appends the edge's address on the way
  // out. Tyk matched on what CADDY sent (one entry, `xff_depth: 1`), which is the first here.
  // Taking the last yields the edge's container IP and silently denies the wrong address.
  const myIp = { ip: xff.split(',')[0]?.trim() ?? '' };
  if (!myIp.ip) throw new Error('could not determine this client IP from X-Forwarded-For');
  console.log(`  this client's IP as the GATEWAY sees it (first XFF entry): ${myIp.ip}\n`);

  try {
    // ── 1. denied IP → 403 ────────────────────────────────────────────────
    const den = `${ID}-deny`;
    await publish(def('deny', { enable_ip_blacklisting: true, blacklisted_ips: [myIp.ip] }));
    check('a denied IP is refused with 403', (await status(`${DATA}/${den}/x`)) === 403, 'through the edge');

    // ── 2. THE SPOOF: forged XFF naming an allowed IP, through the edge ───
    // The deny list holds THIS client's real IP. The request claims to come from 10.0.0.1, which is
    // not denied. If the gateway trusted the client-supplied header, this would be 200.
    const viaEdgeForged = await status(`${EDGE}/${den}/x`, { headers: { 'X-Forwarded-For': '10.0.0.1' } });
    check(
      'a FORGED X-Forwarded-For naming an allowed IP, sent from a denied IP THROUGH THE EDGE, is still 403',
      viaEdgeForged === 403,
      `edge answered ${String(viaEdgeForged)} — the edge REPLACES XFF with the real peer ` +
        `(infra/edge/Caddyfile) and the gateway reads the last entry (xff_depth: 1); a 200 here would ` +
        `mean the deny list is bypassable by anyone who can set a header`,
    );
    // Control: the same route without the forged header must also be 403, so the assertion above
    // cannot pass merely because the edge is broken and refusing everything.
    const viaEdgePlain = await status(`${EDGE}/${den}/x`);
    check(
      'control: the same request through the edge WITHOUT the forged header is also 403',
      viaEdgePlain === 403,
      `edge answered ${String(viaEdgePlain)} — proves the 403 above is the IP rule, not a broken edge`,
    );

    // ── 3. schema validation: 422 vs 200 ─────────────────────────────────
    const sch = `${ID}-schema`;
    await publish(
      def('schema', {}, {
        use_extended_paths: true,
        extended_paths: {
          validate_json: [
            {
              path: '/.*',
              method: 'POST',
              schema: { type: 'object', required: ['email'], properties: { email: { type: 'string' } } },
              error_response_code: 422,
            },
          ],
        },
      }),
    );
    const post = (body: string) =>
      status(`${DATA}/${sch}/submit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    check('a schema-violating body is rejected with 422', (await post('{"nope":1}')) === 422);
    check('a conforming body is accepted with 200', (await post('{"email":"a@b.c"}')) === 200);

    // ── 4. custom auth header REPLACES Authorization ──────────────────────
    const cus = `${ID}-hdr`;
    await publish(
      def('hdr', {
        use_keyless: false,
        use_standard_auth: true,
        auth: { auth_header_name: 'X-Api-Key' },
      }),
    );
    const k = await key({
      org_id: 'og-wp15c', quota_max: -1, rate: 1000, per: 1, expires: -1,
      access_rights: { [cus]: { api_id: cus, api_name: cus, versions: ['Default'] } },
    });
    const inCustom = await status(`${DATA}/${cus}/x`, { headers: { 'X-Api-Key': k } });
    const inAuthorization = await status(`${DATA}/${cus}/x`, { headers: { Authorization: k } });
    check('a key in the configured custom header authenticates', inCustom === 200, `X-Api-Key -> ${String(inCustom)}`);
    check(
      'the SAME key in Authorization does not — the header name replaces, not adds',
      inAuthorization === 401,
      `Authorization -> ${String(inAuthorization)} (200 would mean the custom name is merely one of several accepted)`,
    );

    // ── 5. basic auth ─────────────────────────────────────────────────────
    const bas = `${ID}-basic`;
    await publish(def('basic', { use_keyless: false, use_basic_auth: true, auth: { auth_header_name: 'Authorization' } }));
    const username = `wp15c-${Date.now().toString(36)}`;
    await tyk('/keys/' + username, {
      method: 'POST',
      body: JSON.stringify({
        org_id: 'og-wp15c', quota_max: -1, rate: 1000, per: 1, expires: -1,
        basic_auth_data: { password: 'correct-horse', hash_type: '' },
        access_rights: { [bas]: { api_id: bas, api_name: bas, versions: ['Default'] } },
      }),
    });
    const basicHdr = (pw: string) => ({ Authorization: `Basic ${Buffer.from(`${username}:${pw}`).toString('base64')}` });
    const basicOk = await status(`${DATA}/${bas}/x`, { headers: basicHdr('correct-horse') });
    const basicBad = await status(`${DATA}/${bas}/x`, { headers: basicHdr('wrong') });
    check('basic auth accepts the right password', basicOk === 200, `-> ${String(basicOk)}`);
    check('basic auth rejects the wrong password', basicBad === 401, `-> ${String(basicBad)}`);

    // ── 6. HMAC — NOT ASSERTED, and that is deliberate ────────────────────
    // The mapper emits HMAC config (`enable_signature_checking`, `hmac_allowed_algorithms`,
    // `hmac_allowed_clock_skew`, and the OAS X-Tyk-HMAC scheme) but NO request has been made to
    // authenticate end to end, so nothing here claims it works. Owner-agreed: shipped unverified
    // and parked, rather than asserted on evidence that does not exist.
    //
    // What was established: Tyk FINDS the key — the gateway log gets past "Key ID does not exist"
    // to `Signature string does not match!` with the base64 arriving intact — so the failure is the
    // signing string alone, not key lookup, not the middleware being off.
    //
    // Ruled out (all 400):
    //   signing string `date: <value>` · the bare value · capitalised `Date: <value>` ·
    //   `(request-target)` + date · URL-encoded signature · an `x-tyk-date` header
    //   · `keyId` as the key hash rather than the raw key — that one regresses to
    //     "Key ID does not exist", which confirms the RAW KEY is the correct keyId and that
    //     `hash_keys: true` is not the cause.
    //
    // Whoever picks this up should start from Tyk's own HMAC client rather than the HTTP Signatures
    // spec: the two have diverged somewhere this list does not cover.
    console.log(
      '  ⏭️  HMAC: mapper written, end-to-end NOT verified — parked with findings (see comment above)',
    );
  } finally {
    for (const id of made) await tyk(`/apis/${id}`, { method: 'DELETE' }).catch(() => undefined);
    await tyk('/reload/?block=true').catch(() => undefined);
  }

  console.log(failures === 0 ? '\n✅ all WP15c acceptance checks passed' : `\n❌ ${String(failures)} check(s) failed`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error(`\n❌ ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
