/**
 * OAS-08a fetcher behaviour. Fully offline: the resolver is a fake, and the transport is the real
 * `node:http` request whose FINAL address is swapped for a local test server on 127.0.0.1 — the
 * pinned `lookup` the service hands to Node still runs, and what it answered is recorded, so the
 * tests see which address the socket would have used without ever leaving the machine.
 */
import { ConfigService } from '@nestjs/config';
import type { LookupAddress } from 'node:dns';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { RequestOptions } from 'node:https';
import type { AddressInfo } from 'node:net';
import { isIP, type LookupFunction } from 'node:net';
import { gzipSync } from 'node:zlib';
import { SpecFetchError, type SpecFetchOk } from './spec-fetch.types';
import { networkInterfaces } from 'node:os';
import {
  SPEC_FETCH_MAX_BYTES,
  SpecFetcherService,
  type SpecFetchOptions,
  type SpecResolver,
  type SpecTransport,
} from './spec-fetcher.service';

// ── harness ───────────────────────────────────────────────────────────────────────────────────

type Handler = (req: IncomingMessage, res: ServerResponse) => void;
interface TestServer {
  port: string;
  requests: IncomingMessage[];
  close: () => Promise<void>;
}
const servers: TestServer[] = [];

async function serve(handler: Handler): Promise<TestServer> {
  const requests: IncomingMessage[] = [];
  const server = http.createServer((req, res) => {
    requests.push(req);
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const t: TestServer = {
    port: String((server.address() as AddressInfo).port),
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
  servers.push(t);
  return t;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

/** Fake DNS: each call for a host returns the next answer (the last one repeats). */
function resolver(answers: Partial<Record<string, string[][]>>): SpecResolver & { calls: string[] } {
  const calls: string[] = [];
  const fn: SpecResolver = (hostname: string): Promise<LookupAddress[]> => {
    calls.push(hostname);
    const list = answers[hostname];
    if (!list) return Promise.reject(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }));
    const n = calls.filter((h) => h === hostname).length - 1;
    const answer = list[Math.min(n, list.length - 1)] ?? [];
    return Promise.resolve(answer.map((address) => ({ address, family: isIP(address) })));
  };
  return Object.assign(fn, { calls });
}

interface Hop {
  hostname: string;
  lookupOptions: unknown[];
  pinned: unknown[];
  options: RequestOptions;
}

/** Real node:http, final address redirected to 127.0.0.1 (the URL port is the test server's). */
function loopback(): SpecTransport & { hops: Hop[] } {
  const hops: Hop[] = [];
  const fn = ((url: URL, options: RequestOptions) => {
    const hop: Hop = { hostname: String(options.hostname), lookupOptions: [], pinned: [], options };
    hops.push(hop);
    const { agent, servername: _servername, ...rest } = options;
    const pinned = options.lookup;
    const lookup: LookupFunction = (hostname, opts, cb) => {
      hop.lookupOptions.push(opts);
      const answer = (): void => {
        if (opts.all) cb(null, [{ address: '127.0.0.1', family: 4 }]);
        else cb(null, '127.0.0.1', 4);
      };
      if (!pinned) {
        answer();
        return;
      }
      pinned(hostname, opts, (err, address) => {
        if (err) {
          cb(err, '', 0);
          return;
        }
        hop.pinned.push(address);
        answer();
      });
    };
    const literal = isIP(String(options.hostname)) !== 0;
    return http.request({
      ...rest,
      protocol: 'http:',
      agent: url.protocol === 'https:' ? undefined : agent, // https hops are served in clear by the fake
      hostname: literal ? '127.0.0.1' : options.hostname,
      headers: literal ? { ...(options.headers as Record<string, string>), host: `${String(options.hostname)}:${String(options.port ?? '')}` } : options.headers,
      lookup,
    });
  }) as SpecTransport & { hops: Hop[] };
  fn.hops = hops;
  return fn;
}

class FastFetcher extends SpecFetcherService {
  protected override readonly timeoutMs = 400;
}

function fetcher(
  dns: SpecResolver,
  transport: SpecTransport,
  { allow, fast, options }: { allow?: string; fast?: boolean; options?: SpecFetchOptions } = {},
): SpecFetcherService {
  const config = new ConfigService(allow ? { SPEC_FETCH_ALLOWED_HOSTS: allow } : {});
  return fast ? new FastFetcher(config, dns, transport, options) : new SpecFetcherService(config, dns, transport, options);
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'OK';
  } catch (err) {
    if (err instanceof SpecFetchError) return err.code;
    throw err;
  }
}

const PUB = '93.184.216.34';
const PUB2 = '93.184.216.35';
const SPEC = '{"openapi":"3.0.3","info":{"title":"t","version":"1"},"paths":{}}';
const ok: Handler = (_req, res) => {
  res.writeHead(200, { 'content-type': 'application/json', etag: '"v1"', 'last-modified': 'Wed, 01 Jan 2025 00:00:00 GMT' });
  res.end(SPEC);
};

// ── tests ─────────────────────────────────────────────────────────────────────────────────────

describe('SpecFetcherService — happy path and request shape', () => {
  it('returns the body and validators, sends GET + identity + no cookies, Host = the original name', async () => {
    const s = await serve(ok);
    const dns = resolver({ 'specs.example.com': [[PUB]] });
    const t = loopback();
    const result = (await fetcher(dns, t).fetch(`http://specs.example.com:${s.port}/openapi.json?token=abc`)) as SpecFetchOk;

    expect(result).toEqual({ kind: 'OK', text: SPEC, etag: '"v1"', lastModified: 'Wed, 01 Jan 2025 00:00:00 GMT' });
    const req = s.requests[0];
    expect(req.method).toBe('GET');
    expect(req.url).toBe('/openapi.json?token=abc');
    expect(req.headers.host).toBe(`specs.example.com:${s.port}`);
    expect(req.headers['accept-encoding']).toBe('identity');
    expect(req.headers.cookie).toBeUndefined();
    expect(req.headers.authorization).toBeUndefined();
    expect(t.hops[0]?.pinned).toEqual([[{ address: PUB, family: 4 }]]);
  });

  it('Node asks the pinned lookup for {all:true} (autoSelectFamily) and gets the validated list', async () => {
    const s = await serve(ok);
    const t = loopback();
    await fetcher(resolver({ 'specs.example.com': [[PUB, '2606:4700::1111']] }), t).fetch(`http://specs.example.com:${s.port}/`);
    expect(t.hops[0]?.lookupOptions).toEqual([expect.objectContaining({ all: true })]);
    expect(t.hops[0]?.pinned).toEqual([
      [
        { address: PUB, family: 4 },
        { address: '2606:4700::1111', family: 6 },
      ],
    ]);
  });

  it('the pinned lookup also answers the single-address signature, honouring family', async () => {
    const s = await serve(ok);
    const t = loopback();
    const dns = resolver({ 'specs.example.com': [[PUB, '2606:4700::1111']] });
    await fetcher(dns, t).fetch(`http://specs.example.com:${s.port}/`);
    const lookup: LookupFunction | undefined = t.hops[0]?.options.lookup;
    if (!lookup) throw new Error('the service passed no lookup');
    const single = (opts: object): Promise<unknown[]> =>
      new Promise((resolve) => {
        lookup('specs.example.com', opts, (...args) => {
          resolve(args);
        });
      });
    expect(await single({})).toEqual([null, PUB, 4]);
    expect(await single({ family: 6 })).toEqual([null, '2606:4700::1111', 6]);
    expect(await single({ family: 4, all: true })).toEqual([null, [{ address: PUB, family: 4 }]]);
    expect(dns.calls).toEqual(['specs.example.com']); // answered from the pin, never re-resolved
  });

  it('sets SNI to the original name for https', async () => {
    const s = await serve(ok);
    const t = loopback();
    await fetcher(resolver({ 'specs.example.com': [[PUB]] }), t).fetch(`https://specs.example.com:${s.port}/`);
    expect(t.hops[0]?.options.servername).toBe('specs.example.com');
  });

  it('strips a UTF-8 BOM and decodes a multi-byte character split across chunks', async () => {
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"title":"café"}')]);
    const s = await serve((_req, res) => {
      res.writeHead(200);
      const cut = bytes.indexOf(0xc3) + 1; // inside "é"
      res.write(bytes.subarray(0, cut));
      setTimeout(() => res.end(bytes.subarray(cut)), 20);
    });
    const r = (await fetcher(resolver({ 'a.example': [[PUB]] }), loopback()).fetch(`http://a.example:${s.port}/`)) as SpecFetchOk;
    expect(r.text).toBe('{"title":"café"}');
  });

  it('does not decompress: gzip bytes come back as bytes (the backend lint then fails them)', async () => {
    const s = await serve((_req, res) => {
      res.writeHead(200, { 'content-encoding': 'gzip' });
      res.end(gzipSync(SPEC));
    });
    const r = (await fetcher(resolver({ 'a.example': [[PUB]] }), loopback()).fetch(`http://a.example:${s.port}/`)) as SpecFetchOk;
    expect(r.text).not.toContain('openapi');
  });

  it('allows a public IP literal without calling DNS', async () => {
    const s = await serve(ok);
    const dns = resolver({});
    expect(await codeOf(fetcher(dns, loopback()).fetch(`http://${PUB}:${s.port}/`))).toBe('OK');
    expect(dns.calls).toEqual([]);
  });
});

describe('conditional requests', () => {
  it('sends If-None-Match / If-Modified-Since and maps 304 to NOT_MODIFIED', async () => {
    const s = await serve((req, res) => {
      res.writeHead(req.headers['if-none-match'] === '"v1"' ? 304 : 200);
      res.end();
    });
    const r = await fetcher(resolver({ 'a.example': [[PUB]] }), loopback()).fetch(`http://a.example:${s.port}/`, {
      etag: '"v1"',
      lastModified: 'Wed, 01 Jan 2025 00:00:00 GMT',
    });
    expect(r).toEqual({ kind: 'NOT_MODIFIED' });
    expect(s.requests[0]?.headers['if-modified-since']).toBe('Wed, 01 Jan 2025 00:00:00 GMT');
  });

  it('a 304 to an unconditional request is an HTTP error, not "unchanged"', async () => {
    const s = await serve((_req, res) => {
      res.writeHead(304);
      res.end();
    });
    expect(await codeOf(fetcher(resolver({ 'a.example': [[PUB]] }), loopback()).fetch(`http://a.example:${s.port}/`))).toBe('HTTP_304');
  });

  it('drops the validator headers after a cross-origin hop, keeps them same-origin', async () => {
    const b = await serve(ok);
    const a = await serve((req, res) => {
      res.writeHead(302, { location: req.url === '/start' ? '/same' : `http://b.example:${b.port}/spec` });
      res.end();
    });
    const dns = resolver({ 'a.example': [[PUB]], 'b.example': [[PUB2]] });
    await fetcher(dns, loopback()).fetch(`http://a.example:${a.port}/start`, { etag: '"v1"' });
    expect(a.requests.map((r) => r.headers['if-none-match'])).toEqual(['"v1"', '"v1"']);
    expect(b.requests[0]?.headers['if-none-match']).toBeUndefined();
  });
});

describe('HTTP status and size', () => {
  it.each([404, 500, 204, 206])('maps %s to HTTP_<status>', async (status) => {
    const s = await serve((_req, res) => {
      res.writeHead(status);
      res.end();
    });
    expect(await codeOf(fetcher(resolver({ 'a.example': [[PUB]] }), loopback()).fetch(`http://a.example:${s.port}/`))).toBe(`HTTP_${String(status)}`);
  });

  it('accepts exactly 5 MB', async () => {
    const s = await serve((_req, res) => {
      res.writeHead(200);
      res.end(Buffer.alloc(SPEC_FETCH_MAX_BYTES, 0x61));
    });
    expect(await codeOf(fetcher(resolver({ 'a.example': [[PUB]] }), loopback()).fetch(`http://a.example:${s.port}/`))).toBe('OK');
  });

  it('refuses 5 MB + 1 counted while streaming (no Content-Length)', async () => {
    const s = await serve((_req, res) => {
      res.writeHead(200); // chunked
      res.write(Buffer.alloc(SPEC_FETCH_MAX_BYTES, 0x61));
      res.end(Buffer.from('b'));
    });
    expect(await codeOf(fetcher(resolver({ 'a.example': [[PUB]] }), loopback()).fetch(`http://a.example:${s.port}/`))).toBe('TOO_LARGE');
  });

  it('refuses a declared Content-Length over 5 MB before reading', async () => {
    const s = await serve((_req, res) => {
      res.writeHead(200, { 'content-length': String(SPEC_FETCH_MAX_BYTES + 1) });
      res.write('x');
    });
    expect(await codeOf(fetcher(resolver({ 'a.example': [[PUB]] }), loopback()).fetch(`http://a.example:${s.port}/`))).toBe('TOO_LARGE');
  });
});

describe('deadline and reachability', () => {
  it('slow-loris body: TIMEOUT at the deadline', async () => {
    const s = await serve((_req, res) => {
      res.writeHead(200);
      const drip = setInterval(() => res.write(' '), 50);
      res.on('close', () => {
        clearInterval(drip);
      });
    });
    const t0 = Date.now();
    expect(await codeOf(fetcher(resolver({ 'a.example': [[PUB]] }), loopback(), { fast: true }).fetch(`http://a.example:${s.port}/`))).toBe('TIMEOUT');
    expect(Date.now() - t0).toBeLessThan(1500);
  });

  it('one deadline across hops: three slow redirects each under the limit still time out', async () => {
    const s = await serve((req, res) => {
      const n = Number(req.url?.slice(1));
      setTimeout(() => {
        res.writeHead(302, { location: `/${String(n + 1)}` });
        res.end();
      }, 180);
    });
    expect(await codeOf(fetcher(resolver({ 'a.example': [[PUB]] }), loopback(), { fast: true }).fetch(`http://a.example:${s.port}/0`))).toBe('TIMEOUT');
  });

  it('a DNS answer that never comes: TIMEOUT', async () => {
    const hang: SpecResolver = () => new Promise(() => undefined);
    expect(await codeOf(fetcher(hang, loopback(), { fast: true }).fetch('http://a.example/'))).toBe('TIMEOUT');
  });

  it('the resolver gets the deadline signal and it is aborted at the deadline', async () => {
    let seen: AbortSignal | undefined;
    const hang: SpecResolver = (_host, signal) => {
      seen = signal;
      return new Promise(() => undefined);
    };
    expect(await codeOf(fetcher(hang, loopback(), { fast: true }).fetch('http://a.example/'))).toBe('TIMEOUT');
    expect(seen?.aborted).toBe(true);
  });

  it('hung DNS lookups give their slots back at the deadline: a third, valid fetch still succeeds', async () => {
    const s = await serve(ok);
    const good = resolver({ 'a.example': [[PUB]] });
    const dns: SpecResolver = (host, signal) => (host === 'hang.example' ? new Promise(() => undefined) : good(host, signal));
    const f = fetcher(dns, loopback(), { fast: true });
    expect(await Promise.all([codeOf(f.fetch('http://hang.example/')), codeOf(f.fetch('http://hang.example/'))])).toEqual(['TIMEOUT', 'TIMEOUT']);
    expect(await codeOf(f.fetch(`http://a.example:${s.port}/`))).toBe('OK');
  });

  it('validateUrl has the same deadline', async () => {
    const hang: SpecResolver = () => new Promise(() => undefined);
    const t0 = Date.now();
    expect(await codeOf(fetcher(hang, loopback(), { fast: true }).validateUrl('http://a.example/'))).toBe('TIMEOUT');
    expect(Date.now() - t0).toBeLessThan(1500);
  });

  it('validateUrl takes a concurrency slot like fetch', async () => {
    const good = resolver({ 'a.example': [[PUB]] });
    const dns: SpecResolver = (host, signal) => (host === 'hang.example' ? new Promise(() => undefined) : good(host, signal));
    const f = fetcher(dns, loopback(), { fast: true });
    const all = [f.validateUrl('http://hang.example/'), f.validateUrl('http://hang.example/'), f.validateUrl('http://a.example/')].map(codeOf);
    await new Promise((r) => setTimeout(r, 50));
    expect(good.calls).toEqual([]); // the third is queued behind the two hung ones
    await Promise.all(all);
  });

  it('bounds the wait queue: beyond 2 running + 20 waiting a call fails at once', async () => {
    const hang: SpecResolver = () => new Promise(() => undefined);
    const f = fetcher(hang, loopback(), { fast: true });
    const busy = Array.from({ length: 22 }, () => codeOf(f.fetch('http://hang.example/')));
    const t0 = Date.now();
    expect(await codeOf(f.fetch('http://hang.example/'))).toBe('TIMEOUT');
    expect(Date.now() - t0).toBeLessThan(100);
    await Promise.all(busy);
  });

  it('an expired waiter leaves the queue (the queue drains back to accepting calls)', async () => {
    const s = await serve(ok);
    const good = resolver({ 'a.example': [[PUB]] });
    const dns: SpecResolver = (host, signal) => (host === 'hang.example' ? new Promise(() => undefined) : good(host, signal));
    const f = fetcher(dns, loopback(), { fast: true });
    await Promise.all(Array.from({ length: 22 }, () => codeOf(f.fetch('http://hang.example/'))));
    expect(await codeOf(f.fetch(`http://a.example:${s.port}/`))).toBe('OK');
  });

  it('connection refused: UNREACHABLE', async () => {
    const s = await serve(ok);
    const port = s.port;
    await s.close();
    servers.splice(servers.indexOf(s), 1);
    expect(await codeOf(fetcher(resolver({ 'a.example': [[PUB]] }), loopback()).fetch(`http://a.example:${port}/`))).toBe('UNREACHABLE');
  });

  it('runs at most 2 fetches at once per process', async () => {
    let active = 0;
    let peak = 0;
    const s = await serve((_req, res) => {
      active++;
      peak = Math.max(peak, active);
      setTimeout(() => {
        active--;
        ok(_req, res);
      }, 60);
    });
    const f = fetcher(resolver({ 'a.example': [[PUB]] }), loopback());
    const codes = await Promise.all([1, 2, 3, 4, 5].map(() => codeOf(f.fetch(`http://a.example:${s.port}/`))));
    expect(codes).toEqual(['OK', 'OK', 'OK', 'OK', 'OK']);
    expect(peak).toBe(2);
  });
});

describe('redirects', () => {
  it('follows a relative Location against the current hop, re-validating it', async () => {
    const s = await serve((req, res) => {
      if (req.url === '/dir/spec.json') {
        ok(req, res);
        return;
      }
      res.writeHead(301, { location: 'spec.json' });
      res.end();
    });
    const dns = resolver({ 'a.example': [[PUB]] });
    expect(await codeOf(fetcher(dns, loopback()).fetch(`http://a.example:${s.port}/dir/`))).toBe('OK');
    expect(s.requests.map((r) => r.url)).toEqual(['/dir/', '/dir/spec.json']);
    expect(dns.calls).toEqual(['a.example', 'a.example']); // each hop validated
  });

  it('allows exactly 3 redirects and refuses a fourth', async () => {
    const make = (limit: number): Handler => (req, res) => {
      const n = Number(req.url?.slice(1));
      if (n >= limit) {
        ok(req, res);
        return;
      }
      res.writeHead(307, { location: `/${String(n + 1)}` });
      res.end();
    };
    const three = await serve(make(3));
    const four = await serve(make(4));
    const dns = resolver({ 'a.example': [[PUB]] });
    expect(await codeOf(fetcher(dns, loopback()).fetch(`http://a.example:${three.port}/0`))).toBe('OK');
    expect(await codeOf(fetcher(dns, loopback()).fetch(`http://a.example:${four.port}/0`))).toBe('TOO_MANY_REDIRECTS');
    expect(four.requests).toHaveLength(4);
  });

  it('a redirect loop ends as TOO_MANY_REDIRECTS', async () => {
    const s = await serve((_req, res) => {
      res.writeHead(302, { location: '/loop' });
      res.end();
    });
    expect(await codeOf(fetcher(resolver({ 'a.example': [[PUB]] }), loopback()).fetch(`http://a.example:${s.port}/loop`))).toBe('TOO_MANY_REDIRECTS');
  });

  it('refuses a Location carrying userinfo (BAD_URL) and never contacts it', async () => {
    const b = await serve(ok);
    const a = await serve((_req, res) => {
      res.writeHead(302, { location: `http://user:pw@b.example:${b.port}/` });
      res.end();
    });
    expect(await codeOf(fetcher(resolver({ 'a.example': [[PUB]], 'b.example': [[PUB2]] }), loopback()).fetch(`http://a.example:${a.port}/`))).toBe('BAD_URL');
    expect(b.requests).toHaveLength(0);
  });

  it('refuses https → http', async () => {
    const s = await serve((req, res) => {
      if (req.url === '/plain') {
        ok(req, res);
        return;
      }
      res.writeHead(302, { location: `http://a.example:${s.port}/plain` });
      res.end();
    });
    expect(await codeOf(fetcher(resolver({ 'a.example': [[PUB]] }), loopback()).fetch(`https://a.example:${s.port}/`))).toBe('BLOCKED_TARGET');
    expect(s.requests).toHaveLength(1);
  });

  it.each([
    ['a loopback literal', () => 'http://127.0.0.1/'],
    ['the metadata address', () => 'http://169.254.169.254/latest/meta-data/'],
    ['a Compose service', () => 'http://postgres:5432/'],
    ['a name resolving to a private address', () => 'http://internal.example/'],
    ['a non-http scheme', () => 'file:///etc/passwd'],
  ])('refuses a redirect to %s without contacting it', async (_label, target) => {
    const s = await serve((_req, res) => {
      res.writeHead(302, { location: target() });
      res.end();
    });
    const code = await codeOf(
      fetcher(resolver({ 'a.example': [[PUB]], 'internal.example': [['10.0.0.9']] }), loopback()).fetch(`http://a.example:${s.port}/`),
    );
    expect(['BLOCKED_TARGET', 'BAD_URL']).toContain(code);
    expect(s.requests).toHaveLength(1);
  });

  it('a port change is followed only after re-validation (public host yes; allow-listed host on an unlisted port no)', async () => {
    const other = await serve(ok);
    const first = await serve((_req, res) => {
      res.writeHead(302, { location: `http://${String(_req.headers.host).split(':')[0]}:${other.port}/` });
      res.end();
    });
    const dns = resolver({ 'a.example': [[PUB]], 'specs.corp.example': [['10.1.2.3']] });
    expect(await codeOf(fetcher(dns, loopback()).fetch(`http://a.example:${first.port}/`))).toBe('OK');
    const f = fetcher(dns, loopback(), { allow: `specs.corp.example:${first.port}` });
    expect(await codeOf(f.fetch(`http://specs.corp.example:${first.port}/`))).toBe('BLOCKED_TARGET');
    expect(other.requests).toHaveLength(1); // only the public-host run reached it
  });
});

describe('address policy at fetch time', () => {
  it.each([
    'http://localhost/',
    'http://LOCALHOST./',
    'http://ｌｏｃａｌｈｏｓｔ/', // full-width: WHATWG maps it to "localhost"
    'http://metadata.google.internal/computeMetadata/v1/',
    'http://metadata/',
    'http://open-gateway-hydra:4445/',
    'http://tyk-gateway:8080/',
    'http://127.0.0.1/',
    'http://2130706433/',
    'http://0x7f000001/',
    'http://0177.0.0.1/',
    'http://127.1/',
    'http://0x7f.1/',
    'http://0.0.0.0/',
    'http://169.254.169.254/',
    'http://[::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:169.254.169.254]/',
    'http://[fe80::1]/',
    'http://[64:ff9b::a9fe:a9fe]/',
    'http://10.0.0.1/',
    'http://192.168.1.1/',
    'http://[fd00::1]/',
    'http://100.64.0.1/',
    'http://100.100.100.200/',
    'http://168.63.129.16/',
    'http://[fd00:ec2::254]/',
    'http://foo.localhost/',
    'http://host.docker.internal/',
    'http://gateway.docker.internal/',
    'http://anything.docker.internal/',
    'http://kubernetes.default.svc/',
    'http://kubernetes.default.svc.cluster.local/',
  ])('refuses %s (BLOCKED_TARGET) without resolving or connecting', async (url) => {
    const dns = resolver({});
    const t = loopback();
    expect(await codeOf(fetcher(dns, t).fetch(url))).toBe('BLOCKED_TARGET');
    expect(dns.calls).toEqual([]);
    expect(t.hops).toEqual([]);
  });

  it.each(['postgres', 'hydra', 'open-gateway-kratos', 'metadata.google.internal', 'localhost', 'edge'])(
    'refuses the platform name %s by NAME even when DNS answers a public address',
    async (name) => {
      const dns = resolver({ [name]: [[PUB]] });
      expect(await codeOf(fetcher(dns, loopback()).fetch(`http://${name}/`))).toBe('BLOCKED_TARGET');
      expect(dns.calls).toEqual([]);
    },
  );

  it.each([
    ['loopback', ['127.0.0.1']],
    ['metadata', ['169.254.169.254']],
    ['IPv6 loopback', ['::1']],
    ['mapped loopback', ['::ffff:127.0.0.1']],
    ['a private address', ['10.0.0.5']],
    ['one public and one private address', [PUB, '10.0.0.5']],
    ['no address', []],
  ])('refuses a name that resolves to %s', async (_label, addresses) => {
    const t = loopback();
    expect(await codeOf(fetcher(resolver({ 'evil.example': [addresses] }), t).fetch('http://evil.example/'))).toBe('BLOCKED_TARGET');
    expect(t.hops).toEqual([]);
  });

  it('a DNS failure is BLOCKED_TARGET too (no oracle for which names exist)', async () => {
    expect(await codeOf(fetcher(resolver({}), loopback()).fetch('http://nope.example/'))).toBe('BLOCKED_TARGET');
  });

  it('DNS rebinding: resolves once per hop and connects to the FIRST (validated) answer', async () => {
    const s = await serve(ok);
    const dns = resolver({ 'rebind.example': [[PUB], ['127.0.0.1']] });
    const t = loopback();
    expect(await codeOf(fetcher(dns, t).fetch(`http://rebind.example:${s.port}/`))).toBe('OK');
    expect(dns.calls).toEqual(['rebind.example']);
    expect(t.hops[0]?.pinned).toEqual([[{ address: PUB, family: 4 }]]);
  });

  it('resolves an IDN as punycode', async () => {
    const s = await serve(ok);
    const dns = resolver({ 'xn--bcher-kva.example': [[PUB]] });
    expect(await codeOf(fetcher(dns, loopback()).fetch(`http://bücher.example:${s.port}/`))).toBe('OK');
    expect(dns.calls).toEqual(['xn--bcher-kva.example']);
  });

  it('refuses userinfo as BAD_URL (Basic-auth specs are unsupported)', async () => {
    const dns = resolver({ 'a.example': [[PUB]] });
    expect(await codeOf(fetcher(dns, loopback()).fetch('http://user:pw@a.example/'))).toBe('BAD_URL');
    expect(dns.calls).toEqual([]);
  });
});

describe('allow-list at fetch time', () => {
  it('lets an allow-listed name reach its private address; the same name without the list is refused', async () => {
    const s = await serve(ok);
    const dns = resolver({ 'specs.corp.example': [['10.1.2.3']] });
    const url = `http://specs.corp.example:${s.port}/`;
    expect(await codeOf(fetcher(dns, loopback(), { allow: `specs.corp.example:${s.port}` }).fetch(url))).toBe('OK');
    expect(await codeOf(fetcher(dns, loopback()).fetch(url))).toBe('BLOCKED_TARGET');
    expect(await codeOf(fetcher(dns, loopback(), { allow: 'specs.corp.example' }).fetch(url))).toBe('BLOCKED_TARGET'); // port not listed
  });

  it('lets a private CIDR entry through by address', async () => {
    const s = await serve(ok);
    const dns = resolver({ 'x.corp.example': [['10.123.45.6']] });
    expect(await codeOf(fetcher(dns, loopback(), { allow: `10.123.45.0/24:${s.port}` }).fetch(`http://x.corp.example:${s.port}/`))).toBe('OK');
  });

  it.each([['169.254.169.254'], ['127.0.0.1'], ['::1'], ['0.0.0.0']])(
    'refuses an allow-listed name re-pointed to %s',
    async (address) => {
      const t = loopback();
      const f = fetcher(resolver({ 'specs.corp.example': [[address]] }), t, { allow: 'specs.corp.example' });
      expect(await codeOf(f.fetch('http://specs.corp.example/'))).toBe('BLOCKED_TARGET');
      expect(t.hops).toEqual([]);
    },
  );

  it.each([
    ['100.64.0.0/10', 'specs.corp.example', '100.100.100.200'],
    ['100.64.0.0/10', 'specs.corp.example', '100.100.100.100'],
    ['fd00::/20', 'specs.corp.example', 'fd00:ec2::254'], // /20 still contains fd00:ec2::; kept off this host's own ULA
    ['specs.corp.example', 'specs.corp.example', '100.100.100.200'],
  ])('allow-list %s cannot unlock metadata: %s → %s refused', async (allow, name, address) => {
    const t = loopback();
    const f = fetcher(resolver({ [name]: [[address]] }), t, { allow });
    expect(await codeOf(f.fetch(`http://${name}/`))).toBe('BLOCKED_TARGET');
    expect(t.hops).toEqual([]);
  });

  const ownV4 = Object.values(networkInterfaces())
    .flat()
    .find((i) => i && !i.internal && i.family === 'IPv4')?.address;

  it('finds a non-loopback interface address on this machine (guards the next two tests)', () => {
    expect(ownV4).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
  });

  it('refuses an allow-listed NAME that resolves onto this container’s own network', async () => {
    const t = loopback();
    const f = fetcher(resolver({ 'specs.corp.example': [[String(ownV4)]] }), t, { allow: 'specs.corp.example' });
    expect(await codeOf(f.fetch('http://specs.corp.example/'))).toBe('BLOCKED_TARGET');
    expect(t.hops).toEqual([]);
  });

  it('the code-level allowOwnNetworks test option (never set by DI) lifts only that rule', async () => {
    const s = await serve(ok);
    const dns = resolver({ 'specs.corp.example': [[String(ownV4)]] });
    const opts = { allow: `specs.corp.example:${s.port}`, options: { allowOwnNetworks: true } };
    expect(await codeOf(fetcher(dns, loopback(), opts).fetch(`http://specs.corp.example:${s.port}/`))).toBe('OK');
    const meta = resolver({ 'specs.corp.example': [['169.254.169.254']] });
    expect(await codeOf(fetcher(meta, loopback(), opts).fetch(`http://specs.corp.example:${s.port}/`))).toBe('BLOCKED_TARGET');
  });

  it('fails at startup on a CIDR overlapping this machine’s own interfaces, naming the entry', () => {
    expect(() => fetcher(resolver({}), loopback(), { allow: '127.0.0.0/8' })).toThrow(/127\.0\.0\.0\/8.*overlaps/);
  });

  it('fails at startup on an invalid entry or a Compose name', () => {
    expect(() => fetcher(resolver({}), loopback(), { allow: 'http://x' })).toThrow(/http:\/\/x/);
    expect(() => fetcher(resolver({}), loopback(), { allow: 'redis' })).toThrow(/redis/);
  });
});

// HTTP_PROXY / NODE_USE_ENV_PROXY are read at process START, so no in-process test can fail on them:
// the proof is the child process in test/e2e/oas-spec-fetch.e2e.mjs.

describe('errors never carry the URL, the Location or remote text', () => {
  it('uses fixed messages', async () => {
    const s = await serve((req, res) => {
      if (req.url === '/body') {
        res.writeHead(500);
        res.end('secret-remote-text');
        return;
      }
      res.writeHead(302, { location: 'http://user:leak-location@a.example/' });
      res.end();
    });
    const dns = resolver({ 'a.example': [[PUB]] });
    const errors: unknown[] = [];
    for (const url of [
      `http://a.example:${s.port}/body?token=secret-token`,
      `http://a.example:${s.port}/redirect?token=secret-token`,
      'http://127.0.0.1/?token=secret-token',
      'ftp://a.example/?token=secret-token',
    ]) {
      await fetcher(dns, loopback()).fetch(url).catch((e: unknown) => errors.push(e));
    }
    expect(errors).toHaveLength(4);
    for (const e of errors) {
      expect(e).toBeInstanceOf(SpecFetchError);
      const text = `${(e as Error).message} ${String((e as Error).stack)}`;
      for (const leak of ['secret-token', 'a.example', 'leak-location', 'secret-remote-text', '127.0.0.1']) expect(text).not.toContain(leak);
    }
  });
});

describe('validateUrl', () => {
  it('applies the same policy including resolution, without fetching', async () => {
    const t = loopback();
    const dns = resolver({ 'pub.example': [[PUB]], 'priv.example': [['10.0.0.1']] });
    const f = fetcher(dns, t);
    expect(await codeOf(f.validateUrl('https://pub.example/spec'))).toBe('OK');
    expect(await codeOf(f.validateUrl('https://priv.example/spec'))).toBe('BLOCKED_TARGET');
    expect(await codeOf(f.validateUrl('https://nope.example/spec'))).toBe('BLOCKED_TARGET');
    expect(await codeOf(f.validateUrl('http://127.0.0.1/'))).toBe('BLOCKED_TARGET');
    expect(await codeOf(f.validateUrl('https://u@pub.example/'))).toBe('BAD_URL');
    expect(t.hops).toEqual([]);
  });
});
