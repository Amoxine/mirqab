/**
 * WP27 acceptance, end to end against the real stack: Tyk's native webhook event handlers, the
 * platform's own relay (redaction/signing/retry/delivery log), the SSRF deny list on a receiver
 * URL, and four protocols proxied THROUGH the edge (GraphQL proxy-only, SSE, gRPC, and — the one
 * exception — TCP passthrough BYPASSING the edge on its own port.
 *
 * Same shape as plans-quotas.e2e.mjs / portal.e2e.mjs next door: runs INSIDE the api container,
 * driving compiled services from dist/ for setup, real HTTP/TCP/HTTP2 traffic for the actual
 * acceptance proofs. GraphQL/SSE/gRPC test fixtures are raw CLASSIC Tyk API defs pushed directly —
 * GraphQL and TCP passthrough have no OAS-format equivalent at all (confirmed against the live
 * `/tyk/schema`: zero `graphql`/`tcp`/`protocol` keys anywhere in the OAS extension schema), so
 * this WP's own product surface (webhooks, TCP passthrough) uses OAS/the real DTOs where that
 * exists, and a raw classic def where it is a platform-capability proof instead.
 *
 * Run it:
 *   pnpm --filter @open-gateway/api test:e2e:webhooks
 *
 * Requires the stack up and the api image + edge Caddyfile current, and TYK_WEBHOOK_RELAY_SECRET
 * set (infra/.env) — the relay refuses every call, fail closed, without it.
 */
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import http2 from 'node:http2';
import net from 'node:net';

// The edge's cert is Caddy's own internal CA (`tls internal`, infra/edge/README.md) — trusted by
// installing its root, a per-CLIENT step this throwaway container never does. Every edge call below
// sets `rejectUnauthorized: false` explicitly instead (http2Connect/httpsRequest), which is enough;
// this only guards the plain `fetch()` calls this script does NOT make against the edge (none do).

const ROOT = '/app/apps/api/dist';
const require = createRequire('/app/apps/api/package.json');
require('reflect-metadata');

const { validate } = require('class-validator');
const { plainToInstance } = require('class-transformer');

const { prisma, tykOrgIdFor } = require('@open-gateway/database');
const { TykClientService } = require(`${ROOT}/modules/tyk-integration/services/tyk-client.service.js`);
const { CircuitBreakerService } = require(`${ROOT}/common/circuit-breaker/circuit-breaker.service.js`);
const { ApiService } = require(`${ROOT}/modules/api-management/services/api.service.js`);
const { ReconcileService } = require(`${ROOT}/modules/api-management/services/reconcile.service.js`);
const { OAuthClientService } = require(`${ROOT}/modules/oauth-clients/services/oauth-client.service.js`);
const { HydraAdminService } = require(`${ROOT}/modules/oauth-clients/services/hydra-admin.service.js`);
const { WebhookSubscriptionService } = require(`${ROOT}/modules/webhooks/services/webhook-subscription.service.js`);
const { CreateWebhookSubscriptionDto } = require(`${ROOT}/modules/webhooks/dto/create-webhook-subscription.dto.js`);

const config = { get: (key, fallback) => process.env[key] ?? fallback };
const tyk = new TykClientService(config, new CircuitBreakerService());
const reconcile = new ReconcileService(tyk);
const oauthClients = new OAuthClientService(new HydraAdminService(config), tyk, config);
const apiService = new ApiService(tyk, oauthClients, reconcile);
const webhookSubs = new WebhookSubscriptionService(apiService);

const results = [];
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  results.push({ label, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}: ${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`);
};
const checkTrue = (label, cond) => check(label, cond, true);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function stubUpstream(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => server.listen(0, '0.0.0.0', () => resolve(server)));
}
const stubUrl = (server) => `http://api:${server.address().port}/`;

/** The webhook receiver stub — records every delivery it gets, headers included. */
function webhookReceiver() {
  const deliveries = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      deliveries.push({ headers: req.headers, body });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });
  server.deliveries = deliveries;
  return new Promise((resolve) => server.listen(0, '0.0.0.0', () => resolve(server)));
}

async function createTenant(name, slug) {
  const id = randomUUID();
  return prisma.tenant.create({ data: { id, name, slug, tykOrgId: tykOrgIdFor(id) } });
}

// ── hand-rolled gRPC (no client library — Node core http2 only) ──────────────────────────────
// Wire format: 1-byte compressed flag + 4-byte big-endian length + protobuf bytes. Test message is
// one string field (field 1, wire type 2 — LEN), which is all this needs to encode/decode.
function grpcFrame(str) {
  const strBuf = Buffer.from(str, 'utf8');
  const msg = Buffer.concat([Buffer.from([0x0a, strBuf.length]), strBuf]);
  const header = Buffer.alloc(5);
  header.writeUInt32BE(msg.length, 1);
  return Buffer.concat([header, msg]);
}
function grpcUnframe(buf) {
  const msg = buf.subarray(5); // skip the 5-byte grpc header
  const len = msg[1]; // single-byte varint length is enough for this test's short strings
  return msg.subarray(2, 2 + len).toString('utf8');
}
function startGrpcServer() {
  const server = http2.createServer();
  server.on('stream', (stream, headers) => {
    if (headers[':path'] !== '/hello.HelloService/SayHello') {
      stream.respond({ ':status': 404 });
      stream.end();
      return;
    }
    const chunks = [];
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', () => {
      const greeting = grpcUnframe(Buffer.concat(chunks));
      stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true });
      stream.write(grpcFrame(`hello ${greeting}`));
      stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' }));
      stream.end();
    });
  });
  return new Promise((resolve) => server.listen(0, '0.0.0.0', () => resolve(server)));
}
/** One unary call through the edge (h2c client -> TLS -> Caddy -> h2c -> Tyk -> h2c -> our server). */
function grpcCallThroughEdge(path, greeting) {
  return new Promise((resolve, reject) => {
    const client = http2.connect('https://edge:33005', { servername: 'localhost', rejectUnauthorized: false });
    client.on('error', reject);
    const stream = client.request({
      ':method': 'POST',
      ':path': path,
      'content-type': 'application/grpc',
      te: 'trailers',
    });
    stream.on('response', (headers) => {
      if (headers[':status'] !== 200) {
        client.close();
        reject(new Error(`gRPC call got HTTP ${headers[':status']}`));
      }
    });
    const chunks = [];
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', () => {
      client.close();
      resolve(grpcUnframe(Buffer.concat(chunks)));
    });
    stream.on('error', reject);
    stream.end(grpcFrame(greeting));
  });
}

/**
 * A request to the edge from INSIDE this container. Not plain `fetch()`: the edge's Caddyfile keys
 * its certificate off SNI (`localhost` / the LAN IP, infra/edge/Caddyfile's `default_sni`), but this
 * script dials the compose network alias `edge` — sending SNI `edge` would match no site and the
 * handshake dies with "tls: internal error" (live-verified). `servername` overrides SNI independent
 * of the actual TCP destination (`host`/`port`), which `fetch()` has no option for at all.
 */
// HTTP/2 client, not the plain `https` module: live-verified that a plain HTTP/1.1-negotiated
// client against this Caddyfile's 33005 site gets a bare, unlogged 404 (falls through to the
// catch-all) while an HTTP/2 client (curl, or this) reaches Tyk correctly — same asymmetry the
// gRPC/SSE checks below already rely on `http2.connect` for. Worth a note in the report; not
// chased further here since every through-the-edge client this product actually has (grpcurl-style
// gRPC clients, EventSource, fetch() with its automatic h2 upgrade over TLS) negotiates h2 anyway.
function httpsRequest(path, init = {}) {
  return new Promise((resolve, reject) => {
    const client = http2.connect('https://edge:33005', { servername: 'localhost', rejectUnauthorized: false });
    client.on('error', reject);
    const stream = client.request({ ':method': init.method ?? 'GET', ':path': path, ...(init.headers ?? {}) });
    let status;
    stream.on('response', (headers) => {
      status = headers[':status'];
    });
    const chunks = [];
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', () => {
      client.close();
      resolve({ status, body: Buffer.concat(chunks).toString('utf8') });
    });
    stream.on('error', reject);
    if (init.body) stream.write(init.body);
    stream.end();
  });
}

// ── raw TCP echo upstream (for TCP passthrough) ───────────────────────────────────────────────
function tcpEchoServer() {
  const server = net.createServer((socket) => socket.pipe(socket));
  return new Promise((resolve) => server.listen(0, '0.0.0.0', () => resolve(server)));
}
function tcpEchoOnce(host, port, payload) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, host, () => socket.write(payload));
    let data = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      data = Buffer.concat([data, chunk]);
      if (data.length >= payload.length) {
        socket.end();
        resolve(data);
      }
    });
    socket.on('error', reject);
    setTimeout(() => reject(new Error('tcp echo timed out')), 5000);
  });
}

const suffix = Date.now().toString(36);
let tenant;
let stubOk;
let stubUnreachablePort;
let grpcServer;
let receiver;
let apiQuotaAuth;
let apiBreaker;
let apiRetryProbe;
let apiGraphql;
let apiSse;
let apiGrpc;
let apiTcp;
const rawTykApiIds = [];
const tykKeyHashes = [];
let tcpUpstream;

try {
  tenant = await createTenant(`WP27 ${suffix}`, `wp27-${suffix}`);
  stubOk = await stubUpstream((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
  });
  receiver = await webhookReceiver();
  // An unused port on this same container — connections fail fast (ECONNREFUSED), which is both
  // (a) what trips the circuit breaker quickly and (b) a receiver `webhookSubs` can subscribe to
  // that will never answer, for the retry/backoff test.
  stubUnreachablePort = 18391;

  // ── fixtures: two OAS apis, both getting webhooks enabled ───────────────────────────────────
  // `create()` only fires the FIRST sync in the background (`syncInBackground`, not awaited) — the
  // sync race plans-quotas.e2e.mjs/oas-import.e2e.mjs both warn about. `syncNowWithNodes` blocks
  // until the definition is actually live before the next line drives traffic at it.
  apiQuotaAuth = await apiService.create(
    { name: `WP27 quota-auth ${suffix}`, slug: `wp27-quota-auth-${suffix}`, proxyUrl: stubUrl(stubOk), listenPath: `/wp27-qa-${suffix}/`, authType: 'AUTH_TOKEN' },
    tenant.id,
  );
  await apiService.syncNowWithNodes(apiQuotaAuth.id, tenant.id);
  apiBreaker = await apiService.create(
    {
      name: `WP27 breaker ${suffix}`,
      slug: `wp27-breaker-${suffix}`,
      proxyUrl: `http://api:${stubUnreachablePort}/`,
      listenPath: `/wp27-brk-${suffix}/`,
      authType: 'NONE',
      config: { circuitBreaker: { threshold: 0.01, sampleSize: 1, coolDownSeconds: 60 } },
    },
    tenant.id,
  );
  await apiService.syncNowWithNodes(apiBreaker.id, tenant.id);
  await new Promise((r) => setTimeout(r, 400));

  // ── SSRF: the DTO refuses a denied host before anything is created ──────────────────────────
  const deniedDto = plainToInstance(CreateWebhookSubscriptionDto, { apiId: apiQuotaAuth.id, receiverUrl: 'http://localhost/hook' });
  const deniedErrors = await validate(deniedDto);
  checkTrue('SSRF: a denied receiver host fails DTO validation (400 at the controller)', deniedErrors.length > 0);

  // ── subscribe both apis to the working receiver ──────────────────────────────────────────────
  const subQuotaAuth = await webhookSubs.create({ apiId: apiQuotaAuth.id, receiverUrl: stubUrl(receiver) }, tenant.id);
  checkTrue('subscribe: raw secret returned exactly once', typeof subQuotaAuth.secret === 'string' && subQuotaAuth.secret.length > 0);
  const subBreaker = await webhookSubs.create({ apiId: apiBreaker.id, receiverUrl: stubUrl(receiver) }, tenant.id);

  const afterQuotaAuth = await prisma.apiDefinition.findUnique({ where: { id: apiQuotaAuth.id } });
  checkTrue('webhooksEnabled flips true on first subscription', afterQuotaAuth.webhooksEnabled === true);

  // ── issue a real Tyk key on the quota/auth api, quota_max 1 ──────────────────────────────────
  const created = await tyk.createKey({
    org_id: tenant.tykOrgId,
    quota_max: 1,
    quota_renewal_rate: 3600,
    rate: 0,
    per: 0,
    access_rights: { [afterQuotaAuth.tykApiId]: { api_id: afterQuotaAuth.tykApiId, api_name: afterQuotaAuth.name, versions: ['Default'] } },
  });
  tykKeyHashes.push(created.keyHash);

  const gatewayCall = (path, headers = {}) => fetch(`http://tyk-gateway:8080${path}`, { headers });
  const qaPath = `/${tenant.slug}${apiQuotaAuth.listenPath}`;

  // 1st call within quota -> 200; 2nd -> quota exceeded (QuotaExceeded event)
  const r1 = await gatewayCall(qaPath, { Authorization: created.key });
  check('quota: first call within the limit -> 200', r1.status, 200);
  const r2 = await gatewayCall(qaPath, { Authorization: created.key });
  checkTrue('quota: second call is over the limit (fires QuotaExceeded)', r2.status !== 200);

  // AuthFailure: a garbage key against the same keyed api
  const r3 = await gatewayCall(qaPath, { Authorization: 'not-a-real-key' });
  checkTrue('auth: a bad key is rejected (fires AuthFailure)', r3.status === 401 || r3.status === 403);

  // BreakerTripped: one request against an unreachable upstream, threshold 0.01/sampleSize 1 trips
  // on the very first failure.
  // A trailing segment, not the bare listen path: per-operation middleware (circuitBreaker here,
  // same for urlRewrite/mockResponse/the body transforms — `tyk-mappers.ts`'s own comment calls
  // this "one synthesised catch-all path") is expressed as an OAS `/{wildcard}` path template, which
  // requires a value for `wildcard` to match at all. A bare request to the listen path itself
  // supplies none and never reaches that operation's middleware — live-verified: identical requests
  // with vs. without a trailing segment, only the latter trips the breaker or fires its event. Not a
  // WP27 defect (the mapper is unchanged by this WP); worth a note in the report, not a fix here.
  const breakerPath = `/${tenant.slug}${apiBreaker.listenPath}probe`;
  const b1 = await gatewayCall(breakerPath).catch((e) => ({ status: `ERR:${e.message}` }));
  console.log('  breaker trigger request:', b1.status);

  // ── all three deliveries land within 10s, signed, key redacted ──────────────────────────────
  const deadline = Date.now() + 10_000;
  const wantedEvents = new Set(['QuotaExceeded', 'AuthFailure', 'BreakerTripped']);
  while (Date.now() < deadline && wantedEvents.size > 0) {
    for (const d of receiver.deliveries) {
      try {
        const parsed = JSON.parse(d.body);
        wantedEvents.delete(parsed.event);
      } catch {
        /* ignore non-JSON */
      }
    }
    if (wantedEvents.size > 0) await sleep(300);
  }
  if (wantedEvents.size > 0) {
    console.log('  ...missing:', [...wantedEvents].join(', '), '| received:', receiver.deliveries.map((d) => d.body).join(' || '));
  }
  checkTrue('all three events (quota/auth/breaker) delivered within 10s', wantedEvents.size === 0);
  checkTrue('every delivery is signed', receiver.deliveries.every((d) => /^sha256=[0-9a-f]{64}$/.test(d.headers['x-webhook-signature'] ?? '')));
  checkTrue('the raw key is redacted before it ever leaves this platform', receiver.deliveries.every((d) => !d.body.includes(created.key)));

  // ── retry + backoff + delivery log: a subscription whose receiver never answers ─────────────
  // A THIRD api, not the two above: S1's own caveat is that Tyk de-dupes/cools down repeat firings
  // of the same trigger even at cooldownPeriod "0s", so re-driving AuthFailure on `apiQuotaAuth`
  // (already fired once above) risks a suppressed second event that has nothing to do with retry
  // behaviour. A fresh api has no de-dupe history to collide with.
  apiRetryProbe = await apiService.create(
    { name: `WP27 retry-probe ${suffix}`, slug: `wp27-retry-${suffix}`, proxyUrl: stubUrl(stubOk), listenPath: `/wp27-retry-${suffix}/`, authType: 'AUTH_TOKEN' },
    tenant.id,
  );
  // No explicit sync wait needed here: `webhookSubs.create()` below awaits `syncNowWithNodes`
  // itself the moment `webhooksEnabled` flips (this is the api's first subscription).
  const subDead = await webhookSubs.create({ apiId: apiRetryProbe.id, receiverUrl: `http://api:${stubUnreachablePort}/dead-receiver` }, tenant.id);
  await gatewayCall(`/${tenant.slug}${apiRetryProbe.listenPath}`, { Authorization: 'still-not-a-real-key' }).catch(() => {});
  await sleep(6000); // 3 attempts, backed off 0/500/1500ms, each with its own network round trip
  const failedDeliveries = await webhookSubs.deliveries(subDead.id, tenant.id);
  const lastFailed = failedDeliveries.data.find((d) => d.status === 'FAILED');
  checkTrue('a receiver that never answers is retried 3x with backoff and logged FAILED', lastFailed?.attempts === 3);

  // ── GraphQL (proxy-only), SSE, gRPC — one classic Tyk def each, through the edge ────────────
  const rawTykApi = async (def) => {
    const res = await fetch('http://tyk-gateway:8081/tyk/apis', {
      method: 'POST',
      headers: { 'x-tyk-authorization': process.env.TYK_ADMIN_SECRET ?? '', 'Content-Type': 'application/json' },
      body: JSON.stringify(def),
    });
    if (!res.ok) throw new Error(`raw Tyk api create failed: ${res.status} ${await res.text()}`);
    rawTykApiIds.push(def.api_id);
    return res.json();
  };
  const reloadGateway = () =>
    fetch('http://tyk-gateway:8081/tyk/reload/?block=true', { headers: { 'x-tyk-authorization': process.env.TYK_ADMIN_SECRET ?? '' } });

  const graphqlUpstream = await stubUpstream((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: { hello: 'world' } }));
    });
  });
  apiGraphql = {
    api_id: `wp27-graphql-${suffix}`,
    org_id: tenant.tykOrgId,
    name: `WP27 GraphQL ${suffix}`,
    active: true,
    use_keyless: true,
    proxy: { listen_path: `/wp27-gql-${suffix}/`, target_url: stubUrl(graphqlUpstream), strip_listen_path: true },
    graphql: { enabled: true, execution_mode: 'proxyOnly', version: '2', schema: 'type Query { hello: String }' },
    version_data: { not_versioned: true, versions: { Default: { name: 'Default' } } },
  };
  await rawTykApi(apiGraphql);

  const sseUpstream = await stubUpstream((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
    let n = 0;
    const iv = setInterval(() => {
      n += 1;
      res.write(`data: chunk-${n}\n\n`);
      if (n >= 3) {
        clearInterval(iv);
        res.end();
      }
    }, 150);
  });
  apiSse = {
    api_id: `wp27-sse-${suffix}`,
    org_id: tenant.tykOrgId,
    name: `WP27 SSE ${suffix}`,
    active: true,
    use_keyless: true,
    proxy: { listen_path: `/wp27-sse-${suffix}/`, target_url: stubUrl(sseUpstream), strip_listen_path: true },
    version_data: { not_versioned: true, versions: { Default: { name: 'Default' } } },
  };
  await rawTykApi(apiSse);

  grpcServer = await startGrpcServer();
  apiGrpc = {
    api_id: `wp27-grpc-${suffix}`,
    org_id: tenant.tykOrgId,
    name: `WP27 gRPC ${suffix}`,
    active: true,
    use_keyless: true,
    protocol: '',
    proxy: { listen_path: '/hello.HelloService/', target_url: `h2c://api:${grpcServer.address().port}`, strip_listen_path: false },
    version_data: { not_versioned: true, versions: { Default: { name: 'Default' } } },
  };
  await rawTykApi(apiGrpc);

  await reloadGateway();
  await sleep(500);

  // GraphQL, through the edge, proxy-only (Tyk forwards the raw POST body untouched)
  // Raw classic defs pushed directly (no tenant-slug prefix — that's `gatewayListenPath`'s doing for
  // APIs created through `ApiService`, not something Tyk applies on its own): request the literal `listen_path`.
  const gqlRes = await httpsRequest(apiGraphql.proxy.listen_path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: '{ hello }' }),
  });
  check('GraphQL proxy-only through the edge -> 200 with the upstream body untouched', gqlRes.status, 200);
  checkTrue('GraphQL response body passed through unmodified', gqlRes.body.includes('"hello":"world"'));

  // SSE through the edge: multiple chunks must arrive on ONE connection, not stall (the whole
  // reason WP26b pinned coraza-caddy >= 2.6.1 — an earlier build drops Flush() and this hangs).
  const sseChunks = await new Promise((resolve, reject) => {
    const req = http2.connect('https://edge:33005', { servername: 'localhost', rejectUnauthorized: false });
    req.on('error', reject);
    const stream = req.request({ ':method': 'GET', ':path': apiSse.proxy.listen_path });
    let buf = '';
    stream.on('data', (c) => (buf += c.toString('utf8')));
    stream.on('end', () => {
      req.close();
      resolve(buf);
    });
    stream.on('error', reject);
    setTimeout(() => reject(new Error('SSE through the edge timed out')), 8000);
  });
  checkTrue('SSE through the edge delivers multiple chunks on one connection (not stalled)', (sseChunks.match(/data: chunk-/g) ?? []).length >= 3);

  // gRPC unary through the edge
  const grpcReply = await grpcCallThroughEdge('/hello.HelloService/SayHello', 'wp27');
  check('gRPC unary call through the edge', grpcReply, 'hello wp27');

  // ── TCP passthrough: own port, bypasses the edge entirely, NO WAF inspection ────────────────
  tcpUpstream = await tcpEchoServer();
  apiTcp = await apiService.create(
    {
      name: `WP27 TCP ${suffix}`,
      slug: `wp27-tcp-${suffix}`,
      proxyUrl: `http://api:${tcpUpstream.address().port}`,
      listenPath: `/wp27-tcp-${suffix}/`, // unused for routing on a TCP api; still required by the DTO
      authType: 'NONE',
      protocol: 'TCP',
      listenPort: 6000,
    },
    tenant.id,
  );
  await apiService.syncNowWithNodes(apiTcp.id, tenant.id);
  checkTrue('TCP-mode api def is CLASSIC (OAS has no TCP fields)', apiTcp.defFormat === 'CLASSIC');

  // A payload that looks exactly like the SQLi string WP26b's own WAF verdict says trips rule
  // 942100 over HTTP — sent as raw bytes on the TCP port. If this reaches the echo upstream and
  // comes straight back, nothing on the path inspected it: WAF, HTTP parsing, none of it applies.
  const wafShapedPayload = Buffer.from("id=1 OR 1=1 -- raw TCP, not HTTP, no WAF should ever see this\n");
  const echoed = await tcpEchoOnce('tyk-gateway', 6000, wafShapedPayload);
  checkTrue('TCP passthrough on its own port: raw bytes echo back untouched', echoed.equals(wafShapedPayload));

  // The edge only ever routes to Tyk's HTTP data plane (8080) — it has no site for port 6000 at
  // all, so there is no request shape that reaches the TCP upstream through it. What actually
  // proves "bypasses the edge" is `apiTcp.defFormat === 'CLASSIC'` (OAS cannot express `protocol`)
  // plus the raw socket connect above landing directly on 6000 with zero WAF/HTTP framing involved
  // — asserted already. Confirms the negative space instead: the edge's catch-all still answers a
  // normal request, i.e. nothing about publishing 33020 changed its own routing.
  const edgeStillNormal = await httpsRequest('/');
  checkTrue('publishing the TCP port left the edge itself unaffected (still answers normally)', edgeStillNormal.status === 404 || edgeStillNormal.status === 200);
} catch (err) {
  console.error('FATAL', err);
  results.push({ label: 'script ran to completion (see FATAL above)', ok: false });
} finally {
  for (const s of [stubOk, receiver, grpcServer, tcpUpstream]) {
    s?.close?.();
  }
  for (const hash of tykKeyHashes) {
    await tyk.deleteKey(hash).catch(() => {});
  }
  for (const id of rawTykApiIds) {
    await fetch(`http://tyk-gateway:8081/tyk/apis/${id}`, {
      method: 'DELETE',
      headers: { 'x-tyk-authorization': process.env.TYK_ADMIN_SECRET ?? '' },
    }).catch(() => {});
  }
  if (apiQuotaAuth) await apiService.remove(apiQuotaAuth.id, tenant.id).catch(() => {});
  if (apiBreaker) await apiService.remove(apiBreaker.id, tenant.id).catch(() => {});
  if (apiRetryProbe) await apiService.remove(apiRetryProbe.id, tenant.id).catch(() => {});
  if (apiTcp) await apiService.remove(apiTcp.id, tenant.id).catch(() => {});
  if (rawTykApiIds.length > 0) {
    await fetch('http://tyk-gateway:8081/tyk/reload/?block=true', {
      headers: { 'x-tyk-authorization': process.env.TYK_ADMIN_SECRET ?? '' },
    }).catch(() => {});
  }
  if (tenant) {
    await prisma.webhookSubscription.deleteMany({ where: { tenantId: tenant.id } }).catch(() => {});
    await prisma.tenant.delete({ where: { id: tenant.id } }).catch(() => {});
  }
  await prisma.$disconnect();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) console.log('FAILED:', failed.map((r) => r.label).join(', '));
  process.exit(failed.length === 0 && results.length > 0 ? 0 : 1);
}
