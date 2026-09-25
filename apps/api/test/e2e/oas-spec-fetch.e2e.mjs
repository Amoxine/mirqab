/**
 * OAS-08a: the guarded spec fetcher against the REAL transport, DNS and sockets.
 *
 * Run it (the lead adds the package script; same shape as oas-endpoint-capabilities.e2e.mjs):
 *   docker cp apps/api/test/e2e/oas-spec-fetch.e2e.mjs open-gateway-api:/tmp/oas-spec-fetch.e2e.mjs \
 *     && docker exec open-gateway-api node /tmp/oas-spec-fetch.e2e.mjs
 *
 * It runs INSIDE the api container and builds its OWN SpecFetcherService out of dist/ (default
 * transport = node:http; default resolver = c-ares against Docker's DNS). The allowed target is
 * this container's own hostname, allow-listed by name and mapped (from /etc/hosts, which c-ares does
 * not read) to the container's non-loopback addresses by a thin resolver wrapper; every other name
 * goes to the real default resolver. Because those addresses are on the container's own networks,
 * the fetcher is built with the code-level `allowOwnNetworks` TEST option (production DI never sets
 * it) — and the script first proves the same target is refused without it. A local listener is
 * bound to exactly those addresses; a second one on 127.0.0.1 is the bait that must never be hit. No Postgres, no gateway, no tenant data: nothing to clean up but the
 * listeners (closed in `finally`) and a child process (killed in `finally`).
 *
 * Proves: 200 body + validators, 304 on If-None-Match, a 3-hop redirect chain, > 3 redirects refused,
 * refusal of 127.0.0.1 / the metadata address / Compose names / a redirect into loopback, the
 * allow-list's port rule, the startup refusal of an own-network CIDR, 5 MB + 1, the 10 s deadline, that
 * HTTP_PROXY + NODE_USE_ENV_PROXY (read at process start, so checked in a child) do not reroute the
 * request, and that no URL, token or host appears in anything written to stdout/stderr or in errors.
 */
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import dns from 'node:dns';
import http from 'node:http';
import os from 'node:os';

const require = createRequire('/app/apps/api/package.json');
require('reflect-metadata');
const D = '/app/apps/api/dist/modules/spec-fetch';
const SERVICE = `${D}/spec-fetcher.service.js`;
const { SpecFetcherService, defaultSpecResolver } = require(SERVICE);
const { SpecFetchError } = require(`${D}/spec-fetch.types.js`);

const PORT = Number(process.env.PROBE_SPEC_PORT ?? 9921);
const BAIT_PORT = PORT + 1;
const PROXY_PORT = PORT + 2;
const HOST = os.hostname();
const SECRET = `e2e-secret-${Date.now().toString(36)}`;
const SPEC = JSON.stringify({ openapi: '3.0.3', info: { title: 'og-probe-spec-fetch', version: '1' }, paths: {} });

const results = [];
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}: ${JSON.stringify(actual)}${ok ? '' : ` (expected ${JSON.stringify(expected)})`}`);
};
const config = (allow) => ({ get: (k) => (k === 'SPEC_FETCH_ALLOWED_HOSTS' ? allow : undefined) });
const code = async (p) => {
  try {
    const r = await p;
    return r.kind;
  } catch (e) {
    return e instanceof SpecFetchError ? e.code : `THREW ${e?.constructor?.name}`;
  }
};

// ── listeners ──────────────────────────────────────────────────────────────────────────────────
const hits = [];
const handler = (rq, rs) => {
  const path = rq.url.split('?')[0];
  hits.push(path);
  const redirect = (to) => { rs.writeHead(302, { location: to }); rs.end(); };
  if (path === '/spec') {
    if (rq.headers['if-none-match'] === '"e2e-v1"') { rs.writeHead(304); rs.end(); return; }
    rs.writeHead(200, { 'content-type': 'application/json', etag: '"e2e-v1"' });
    rs.end(SPEC);
  } else if (/^\/chain\/[0-2]$/.test(path)) redirect(Number(path.at(-1)) === 2 ? '/spec' : `/chain/${Number(path.at(-1)) + 1}`);
  else if (/^\/long\/\d$/.test(path)) redirect(`/long/${Number(path.at(-1)) + 1}`);
  else if (path === '/to-loopback') redirect(`http://127.0.0.1:${BAIT_PORT}/spec?token=${SECRET}`);
  else if (path === '/to-metadata') redirect('http://169.254.169.254/latest/meta-data/');
  else if (path === '/big') { rs.writeHead(200); rs.end(Buffer.alloc(5 * 1024 * 1024 + 1, 0x61)); }
  else if (path === '/slow') { rs.writeHead(200); const t = setInterval(() => rs.write(' '), 500); rs.on('close', () => clearInterval(t)); }
  else { rs.writeHead(404); rs.end(); }
};
const listen = (server, port, address) => new Promise((res, rej) => { server.once('error', rej); server.listen(port, address, res); });

let baitHits = 0;
let proxyHits = 0;
const servers = [];
let child;

const captured = [];
const capture = async (fn) => {
  const writes = [process.stdout.write, process.stderr.write];
  process.stdout.write = function (chunk, ...rest) { captured.push(String(chunk)); return writes[0].call(this, chunk, ...rest); };
  process.stderr.write = function (chunk, ...rest) { captured.push(String(chunk)); return writes[1].call(this, chunk, ...rest); };
  try { return await fn(); } finally { [process.stdout.write, process.stderr.write] = writes; }
};

try {
  const own = (await dns.promises.lookup(HOST, { all: true })).map((a) => a.address);
  const nonLoopback = own.filter((a) => !a.startsWith('127.') && a !== '::1');
  check('container hostname resolves only to non-loopback addresses', nonLoopback.length > 0 && nonLoopback.length === own.length, true);
  for (const address of nonLoopback) {
    const s = http.createServer(handler);
    await listen(s, PORT, address);
    servers.push(s);
  }
  const bait = http.createServer((rq, rs) => { baitHits++; rs.end(SPEC); });
  await listen(bait, BAIT_PORT, '127.0.0.1');
  const proxy = http.createServer((rq, rs) => { proxyHits++; rs.end('{"from":"proxy"}'); });
  await listen(proxy, PROXY_PORT, '127.0.0.1');
  servers.push(bait, proxy);

  const base = `http://${HOST}:${PORT}`;
  const resolve = (host, signal) =>
    host === HOST ? Promise.resolve(nonLoopback.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))) : defaultSpecResolver(host, signal);
  const allow = `${HOST}:${PORT}`;
  const plain = new SpecFetcherService(config(undefined), resolve);
  const strict = new SpecFetcherService(config(allow), resolve);
  const f = new SpecFetcherService(config(allow), resolve, undefined, { allowOwnNetworks: true });

  // The default c-ares resolver really resolves through Docker's embedded DNS
  const ac = new AbortController();
  const pg = await defaultSpecResolver('postgres', ac.signal).catch(() => []);
  check('c-ares default resolver answers a Compose name (Docker DNS)', pg.length > 0, true);

  await capture(async () => {
    // Policy before the allow-list
    check('no allow-list: the private host is refused', await code(plain.fetch(`${base}/spec?token=${SECRET}`)), 'BLOCKED_TARGET');
    check('no allow-list: the listener saw nothing', hits.length, 0);
    check('allow-listed name onto the own network is refused without the test option', await code(strict.fetch(`${base}/spec`)), 'BLOCKED_TARGET');
    check('the listener saw nothing yet', hits.length, 0);
    const t1 = Date.now();
    check('unknown name via real DNS: BLOCKED_TARGET', await code(plain.validateUrl('http://og-probe-does-not-exist.invalid/')), 'BLOCKED_TARGET');
    check('unknown name answered within the deadline', Date.now() - t1 < 10500, true);
    check('allow-listed name on an unlisted port is refused', await code(f.fetch(`http://${HOST}:${BAIT_PORT}/spec`)), 'BLOCKED_TARGET');

    // Happy paths over real sockets
    const r = await f.fetch(`${base}/spec?token=${SECRET}`);
    check('200: body returned', r.kind === 'OK' && r.text === SPEC, true);
    check('200: etag returned', r.etag, '"e2e-v1"');
    check('304 with the stored ETag', await code(f.fetch(`${base}/spec`, { etag: '"e2e-v1"' })), 'NOT_MODIFIED');
    hits.length = 0;
    check('3-hop redirect chain', await code(f.fetch(`${base}/chain/0`)), 'OK');
    check('chain hops seen by the listener', hits, ['/chain/0', '/chain/1', '/chain/2', '/spec']);
    check('4 redirects refused', await code(f.fetch(`${base}/long/0`)), 'TOO_MANY_REDIRECTS');

    // Refusals
    check('127.0.0.1 refused', await code(f.fetch(`http://127.0.0.1:${BAIT_PORT}/spec`)), 'BLOCKED_TARGET');
    check('localhost refused', await code(f.fetch(`http://localhost:${BAIT_PORT}/spec`)), 'BLOCKED_TARGET');
    check('metadata address refused', await code(f.fetch('http://169.254.169.254/latest/meta-data/')), 'BLOCKED_TARGET');
    check('Alibaba metadata refused', await code(f.fetch('http://100.100.100.200/latest/meta-data/')), 'BLOCKED_TARGET');
    check('host.docker.internal refused', await code(f.fetch('http://host.docker.internal/')), 'BLOCKED_TARGET');
    check('Compose name postgres refused', await code(f.fetch('http://postgres:5432/')), 'BLOCKED_TARGET');
    check('Compose name api refused', await code(f.fetch('http://api:3001/api/health')), 'BLOCKED_TARGET');
    check('Compose name hydra (admin) refused', await code(f.fetch('http://hydra:4445/admin/clients')), 'BLOCKED_TARGET');
    check('redirect into loopback refused', await code(f.fetch(`${base}/to-loopback`)), 'BLOCKED_TARGET');
    check('redirect to metadata refused', await code(f.fetch(`${base}/to-metadata`)), 'BLOCKED_TARGET');
    check('the loopback bait was never hit', baitHits, 0);
    check('userinfo refused', await code(f.fetch(`http://user:pw@${HOST}:${PORT}/spec`)), 'BAD_URL');

    // Limits
    check('5 MB + 1 refused', await code(f.fetch(`${base}/big`)), 'TOO_LARGE');
    const t0 = Date.now();
    const slow = await code(f.fetch(`${base}/slow?token=${SECRET}`));
    const ms = Date.now() - t0;
    check('slow body hits the deadline', slow, 'TIMEOUT');
    check('deadline is ~10 s', ms >= 9500 && ms < 12000, true);

    // Errors carry no URL
    try { await f.fetch(`${base}/to-loopback?token=${SECRET}`); } catch (e) {
      const text = `${e.message} ${e.stack}`;
      check('error text has no token, host or Location', [SECRET, HOST, '127.0.0.1'].some((s) => text.includes(s)), false);
    }
  });

  // Startup refusal of an own-network CIDR (live os.networkInterfaces())
  let refusal = null;
  try { new SpecFetcherService(config(`${nonLoopback[0]}/32`)); } catch (e) { refusal = String(e.message); }
  check('own-network CIDR refused at construction', refusal !== null && /overlaps this container/.test(refusal), true);

  // HTTP_PROXY + NODE_USE_ENV_PROXY are read at process start: prove it in a fresh process.
  const proxyUrl = `http://127.0.0.1:${PROXY_PORT}`;
  const script = `
    const { createRequire } = require('node:module');
    const r = createRequire('/app/apps/api/package.json'); r('reflect-metadata');
    const { SpecFetcherService } = r(${JSON.stringify(SERVICE)});
    const own = ${JSON.stringify(nonLoopback)}.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
    const f = new SpecFetcherService({ get: (k) => (k === 'SPEC_FETCH_ALLOWED_HOSTS' ? ${JSON.stringify(allow)} : undefined) }, async () => own, undefined, { allowOwnNetworks: true });
    f.fetch(${JSON.stringify(`${base}/spec`)}).then((x) => console.log(JSON.stringify({ node: process.version, kind: x.kind, spec: x.text === ${JSON.stringify(SPEC)} })), (e) => console.log(JSON.stringify({ node: process.version, err: e.code })));
  `;
  const out = await new Promise((resolve) => {
    let buf = '';
    child = spawn(process.execPath, ['-e', script], {
      env: { ...process.env, HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, http_proxy: proxyUrl, https_proxy: proxyUrl, NODE_USE_ENV_PROXY: '1', NO_PROXY: '' },
    });
    child.stdout.on('data', (d) => { buf += d; });
    child.on('exit', () => resolve(buf.trim()));
  });
  const parsed = JSON.parse(out || '{}');
  console.log(`      child node ${parsed.node}`);
  check('with HTTP_PROXY + NODE_USE_ENV_PROXY=1 the fetch still reaches the target', { kind: parsed.kind, spec: parsed.spec }, { kind: 'OK', spec: true });
  check('the proxy saw nothing', proxyHits, 0);

  const leaked = captured.join('').split('\n').filter((l) => l.includes(SECRET) || (!l.startsWith('PASS') && !l.startsWith('FAIL') && l.includes(HOST)));
  check('nothing written to stdout/stderr contains the token or the host', leaked, []);
} catch (err) {
  results.push(false);
  console.log(`FAIL  unexpected: ${err?.message ?? err}`);
} finally {
  child?.kill();
  await Promise.all(servers.map((s) => new Promise((r) => { s.closeAllConnections?.(); s.close(() => r()); })));
}

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
