import { Inject, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { promises as dns, type LookupAddress } from 'node:dns';
import http, { type ClientRequest, type IncomingMessage } from 'node:http';
import https, { type RequestOptions } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { networkInterfaces } from 'node:os';
import {
  SpecFetchError,
  type SpecFetchConditions,
  type SpecFetcherPort,
  type SpecFetchNotModified,
  type SpecFetchOk,
} from './spec-fetch.types';
import {
  addressAllowed,
  bareHost,
  nameDenied,
  ownNetworks,
  parseAllowList,
  parseSpecUrl,
  type AllowEntry,
  type Cidr,
} from './spec-url-policy';

/** Resolve a host name to ALL its addresses; must give up when `signal` aborts. */
export type SpecResolver = (hostname: string, signal: AbortSignal) => Promise<LookupAddress[]>;
/** Open one HTTP/1.1 request. The default is `node:http`/`node:https` `request` — never fetch/undici. */
export type SpecTransport = (url: URL, options: RequestOptions) => ClientRequest;
/** Code-level options. Production DI never provides them. */
export interface SpecFetchOptions {
  /**
   * TEST ONLY (the live e2e): allow addresses inside this container's own interface networks for
   * allow-listed hosts. Never set in production; there is deliberately no environment variable.
   */
  allowOwnNetworks?: boolean;
}

export const SPEC_FETCH_RESOLVER = Symbol('SPEC_FETCH_RESOLVER');
export const SPEC_FETCH_TRANSPORT = Symbol('SPEC_FETCH_TRANSPORT');
export const SPEC_FETCH_OPTIONS = Symbol('SPEC_FETCH_OPTIONS');

/**
 * c-ares (`dns.Resolver`), not getaddrinfo: it has its own timeout and can be cancelled, so a DNS
 * server that never answers cannot pin a libuv thread-pool thread. It does NOT read /etc/hosts and
 * applies no resolv.conf search domains: allow-list internal hosts by their fully-qualified name.
 */
export const defaultSpecResolver: SpecResolver = async (hostname, signal) => {
  const resolver = new dns.Resolver({ timeout: 2500, tries: 2 });
  const cancel = (): void => {
    resolver.cancel();
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    const [v4, v6] = await Promise.allSettled([resolver.resolve4(hostname), resolver.resolve6(hostname)]);
    const addresses: LookupAddress[] = [
      ...(v4.status === 'fulfilled' ? v4.value.map((address) => ({ address, family: 4 })) : []),
      ...(v6.status === 'fulfilled' ? v6.value.map((address) => ({ address, family: 6 })) : []),
    ];
    if (addresses.length === 0) throw new Error('no address');
    return addresses;
  } finally {
    signal.removeEventListener('abort', cancel);
  }
};
const defaultTransport: SpecTransport = (url, options) =>
  (url.protocol === 'https:' ? https : http).request(options);

export const SPEC_FETCH_MAX_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const MAX_CONCURRENT = 2;
const MAX_WAITING = 20;
const MAX_VALIDATOR_LENGTH = 512;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const blocked = (): SpecFetchError => new SpecFetchError('BLOCKED_TARGET');
const timeout = (): SpecFetchError => new SpecFetchError('TIMEOUT');
// `${number}` in a template is refused by lint; String(status) of an integer is exactly that shape
const httpError = (status: number): SpecFetchError => new SpecFetchError(`HTTP_${String(status)}` as `HTTP_${number}`);

/**
 * A `lookup` that answers with the addresses already validated for this hop and never resolves
 * again, in both the single-address and the `{ all: true }` (autoSelectFamily) signatures. The
 * socket can therefore only connect to an address the policy has seen: no rebinding window.
 */
function pinnedLookup(addresses: readonly LookupAddress[]): LookupFunction {
  return (_hostname, options, callback) => {
    const family = options.family === 4 || options.family === 'IPv4' ? 4 : options.family === 6 || options.family === 'IPv6' ? 6 : 0;
    const usable = family ? addresses.filter((a) => a.family === family) : [...addresses];
    if (usable.length === 0) {
      callback(Object.assign(new Error('no usable address'), { code: 'ENOTFOUND' }), '', 0);
      return;
    }
    const first = usable[0];
    if (options.all) callback(null, usable);
    else callback(null, first.address, first.family);
  };
}

function mapError(err: unknown, signal: AbortSignal): SpecFetchError {
  if (err instanceof SpecFetchError) return err;
  return signal.aborted ? timeout() : new SpecFetchError('UNREACHABLE');
}

function validator(res: IncomingMessage, name: 'etag' | 'last-modified'): string | null {
  const value = res.headers[name];
  return typeof value === 'string' && value.length <= MAX_VALIDATOR_LENGTH ? value : null;
}

/**
 * OAS-08a: the only code path allowed to fetch a tenant-supplied spec URL. Policy in
 * `spec-url-policy.ts`, behaviour and limits in docs/OAS-SPEC-FETCH.md. Logs nothing: the URL may
 * carry a secret in its query string, and a redirect Location is attacker-chosen text.
 */
@Injectable()
export class SpecFetcherService implements SpecFetcherPort {
  /** One deadline per call: queueing, every DNS answer, every hop and the body. */
  protected readonly timeoutMs: number = 10_000;
  private readonly allowList: readonly AllowEntry[];
  private readonly ownNetworks: readonly Cidr[];
  // Dedicated agents: no keep-alive, and never the global agents that NODE_USE_ENV_PROXY rewires.
  private readonly httpAgent = new http.Agent({ keepAlive: false });
  private readonly httpsAgent = new https.Agent({ keepAlive: false });
  private freeSlots = MAX_CONCURRENT;
  private readonly waiting: (() => void)[] = [];

  constructor(
    config: ConfigService,
    @Optional() @Inject(SPEC_FETCH_RESOLVER) private readonly resolver: SpecResolver = defaultSpecResolver,
    @Optional() @Inject(SPEC_FETCH_TRANSPORT) private readonly transport: SpecTransport = defaultTransport,
    @Optional() @Inject(SPEC_FETCH_OPTIONS) options: SpecFetchOptions = {},
  ) {
    const interfaces = networkInterfaces();
    // Throws (naming the entry) on an invalid entry or an own-network CIDR: startup fails loudly.
    this.allowList = parseAllowList(config.get<string>('SPEC_FETCH_ALLOWED_HOSTS'), interfaces);
    this.ownNetworks = options.allowOwnNetworks ? [] : ownNetworks(interfaces);
  }

  async validateUrl(url: string): Promise<void> {
    const parsed = parseSpecUrl(url);
    await this.guarded((signal) => this.vet(parsed, signal));
  }

  async fetch(url: string, cond?: SpecFetchConditions): Promise<SpecFetchOk | SpecFetchNotModified> {
    const start = parseSpecUrl(url);
    return this.guarded((signal) => this.follow(start, cond, signal));
  }

  /** The deadline and the concurrency slot, shared by fetch and validateUrl. */
  private async guarded<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(timeout());
      }, this.timeoutMs);
    });
    const run = this.withSlot(controller.signal, () => task(controller.signal));
    run.catch(() => undefined); // settled after the deadline won: already answered
    try {
      return await Promise.race([run, deadline]);
    } finally {
      clearTimeout(timer);
      controller.abort(); // frees the slot and cancels DNS even if a task still dangles
    }
  }

  /**
   * At most MAX_CONCURRENT calls hold a slot; at most MAX_WAITING wait for one. The slot is given
   * back when the task settles OR its deadline aborts, whichever is first, so a task stuck on
   * something that ignores the signal cannot starve the others.
   */
  private async withSlot<T>(signal: AbortSignal, task: () => Promise<T>): Promise<T> {
    if (this.freeSlots > 0) {
      this.freeSlots--;
    } else {
      if (this.waiting.length >= MAX_WAITING) throw timeout();
      await new Promise<void>((resolve, reject) => {
        const onAbort = (): void => {
          const i = this.waiting.indexOf(grant);
          if (i >= 0) this.waiting.splice(i, 1);
          reject(timeout());
        };
        const grant = (): void => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        };
        this.waiting.push(grant);
        signal.addEventListener('abort', onAbort, { once: true });
      });
    }
    let held = true;
    const release = (): void => {
      if (!held) return;
      held = false;
      const next = this.waiting.shift();
      if (next) next();
      else this.freeSlots++;
    };
    signal.addEventListener('abort', release, { once: true });
    try {
      if (signal.aborted) throw timeout();
      return await task();
    } finally {
      signal.removeEventListener('abort', release);
      release();
    }
  }

  /** Name denylist, then every address; returns the addresses to pin (null for an IP literal). */
  private async vet(url: URL, signal: AbortSignal): Promise<LookupAddress[] | null> {
    if (nameDenied(url)) throw blocked();
    const host = bareHost(url);
    const allowed = (address: string): boolean => addressAllowed(address, url, this.allowList, this.ownNetworks);
    if (isIP(host)) {
      if (!allowed(host)) throw blocked();
      return null;
    }
    let addresses: LookupAddress[];
    try {
      addresses = await this.resolver(url.hostname, signal);
    } catch {
      if (signal.aborted) throw timeout();
      throw blocked(); // DNS failure and policy refusal look the same: no oracle for internal names
    }
    if (addresses.length === 0 || !addresses.every((a) => allowed(a.address))) throw blocked();
    return addresses;
  }

  private async follow(
    start: URL,
    cond: SpecFetchConditions | undefined,
    signal: AbortSignal,
  ): Promise<SpecFetchOk | SpecFetchNotModified> {
    let url = start;
    let conditional = Boolean(cond?.etag) || Boolean(cond?.lastModified);
    for (let hop = 0; ; hop++) {
      const res = await this.request(url, conditional ? cond : undefined, signal);
      const status = res.statusCode ?? 0;

      if (REDIRECTS.has(status)) {
        const location = res.headers.location;
        res.destroy();
        if (hop >= MAX_REDIRECTS) throw new SpecFetchError('TOO_MANY_REDIRECTS');
        if (!location) throw httpError(status);
        let next: URL;
        try {
          next = parseSpecUrl(new URL(location, url).href); // relative against this hop; refuses userinfo
        } catch {
          throw new SpecFetchError('BAD_URL');
        }
        if (url.protocol === 'https:' && next.protocol === 'http:') throw blocked();
        if (next.origin !== url.origin) conditional = false; // validators belong to the first origin
        url = next;
        continue;
      }
      if (status === 304 && conditional) {
        res.destroy();
        return { kind: 'NOT_MODIFIED' };
      }
      if (status !== 200) {
        res.destroy();
        throw httpError(status);
      }
      return this.readBody(res, signal);
    }
  }

  private async request(url: URL, cond: SpecFetchConditions | undefined, signal: AbortSignal): Promise<IncomingMessage> {
    if (signal.aborted) throw new SpecFetchError('TIMEOUT');
    const pinned = await this.vet(url, signal);
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- the deadline can fire during the await above
    if (signal.aborted) throw new SpecFetchError('TIMEOUT');

    const host = url.hostname.replace(/^\[|\]$/g, '');
    const secure = url.protocol === 'https:';
    const headers: Record<string, string> = {
      accept: 'application/vnd.oai.openapi+json, application/json, application/yaml, text/yaml, text/plain;q=0.5, */*;q=0.1',
      'accept-encoding': 'identity',
      'user-agent': 'OpenGateway-SpecFetcher/1.0',
    };
    if (cond?.etag) headers['if-none-match'] = cond.etag;
    if (cond?.lastModified) headers['if-modified-since'] = cond.lastModified;

    return new Promise<IncomingMessage>((resolve, reject) => {
      let req: ClientRequest;
      try {
        req = this.transport(url, {
          method: 'GET',
          protocol: url.protocol,
          hostname: host, // Host header and SNI follow the original name; the socket follows `lookup`
          port: url.port || undefined,
          path: `${url.pathname}${url.search}`,
          headers,
          agent: secure ? this.httpsAgent : this.httpAgent,
          lookup: pinned ? pinnedLookup(pinned) : undefined,
          servername: secure && !isIP(host) ? host : undefined,
          signal,
        });
      } catch (err) {
        reject(mapError(err, signal));
        return;
      }
      req.once('response', resolve);
      req.once('error', (err) => {
        reject(mapError(err, signal));
      });
      req.end();
    });
  }

  private readBody(res: IncomingMessage, signal: AbortSignal): Promise<SpecFetchOk> {
    if (Number(res.headers['content-length']) > SPEC_FETCH_MAX_BYTES) {
      res.destroy();
      return Promise.reject(new SpecFetchError('TOO_LARGE'));
    }
    return new Promise<SpecFetchOk>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > SPEC_FETCH_MAX_BYTES) {
          res.destroy();
          reject(new SpecFetchError('TOO_LARGE'));
          return;
        }
        chunks.push(chunk);
      });
      res.once('end', () => {
        resolve({
          kind: 'OK',
          // UTF-8, BOM stripped (TextDecoder default); bytes are never decompressed
          text: new TextDecoder('utf-8').decode(Buffer.concat(chunks)),
          etag: validator(res, 'etag'),
          lastModified: validator(res, 'last-modified'),
        });
      });
      res.once('error', (err) => {
        reject(mapError(err, signal));
      });
      res.once('close', () => {
        if (!res.complete) reject(mapError(new Error('response closed early'), signal));
      });
    });
  }
}
