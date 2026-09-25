import ipaddr from 'ipaddr.js';
import { isIP } from 'node:net';
import type { NetworkInterfaceInfo } from 'node:os';
import { proxyUrlDenyReason } from '../api-management/dto/proxy-url.validator';
import { SpecFetchError } from './spec-fetch.types';

/**
 * OAS-08a address and URL policy (contract REV 2, M1/M2). Pure: no DNS, no sockets.
 *
 * An address may be connected to only when `ipaddr.js` classifies it as `unicast` (IPv6: inside
 * 2000::/3) and it is outside EXTRA_DENIED. `private`, `uniqueLocal` and `carrierGradeNat` are
 * reachable only through the operator allow-list. Every other range is refused for every name.
 */

type Ip = ipaddr.IPv4 | ipaddr.IPv6;
export type Cidr = [Ip, number];

const cidr = (s: string): Cidr => ipaddr.parseCIDR(s);

/**
 * Refused before anything else, so NO allow-list entry can lift them: cloud metadata endpoints that
 * sit inside ranges the allow-list may relax (CGNAT, ULA) or that ipaddr.js calls public, and ranges
 * ipaddr.js 1.9.1 calls `unicast`. IPv6 ranges outside 2000::/3 (IPv4-compatible ::/96,
 * 64:ff9b:1::/48, 100::/64, 5f00::/16, fec0::/10) are refused by the IPV6_GLOBAL rule below;
 * 0/8, 192.0.0.0/24 (incl. 192.0.0.192) and 2001:db8::/32 are already non-unicast in ipaddr.js, and
 * 169.254/16 (AWS/GCP/Azure/OCI IMDS) is linkLocal.
 */
const EXTRA_DENIED: readonly Cidr[] = [
  cidr('100.100.100.100/32'), // Alibaba Cloud DNS / metadata (inside CGNAT)
  cidr('100.100.100.200/32'), // Alibaba Cloud metadata (inside CGNAT)
  cidr('fd00:ec2::/32'), // AWS IPv6 IMDS / DNS (inside ULA)
  cidr('168.63.129.16/32'), // Azure WireServer (public by range)
  cidr('198.18.0.0/15'), // benchmarking
  cidr('2001::/23'), // IETF protocol assignments: Teredo, ORCHID, benchmarking, …
  cidr('3fff::/20'), // documentation (RFC 9637)
];
const IPV6_GLOBAL = cidr('2000::/3');
const RELAXABLE = new Set(['private', 'uniqueLocal', 'carrierGradeNat']);

export const MAX_URL_LENGTH = 2048;

export type AddressClass = 'public' | 'relaxable' | 'denied';

function inCidr(ip: Ip, [net, bits]: Cidr): boolean {
  if (ip instanceof ipaddr.IPv4 && net instanceof ipaddr.IPv4) return ip.match(net, bits);
  if (ip instanceof ipaddr.IPv6 && net instanceof ipaddr.IPv6) return ip.match(net, bits);
  return false;
}

function parseIp(address: string): Ip | null {
  if (!ipaddr.isValid(address)) return null;
  try {
    const ip = ipaddr.parse(address);
    return ip instanceof ipaddr.IPv6 && ip.isIPv4MappedAddress() ? ip.toIPv4Address() : ip;
  } catch {
    return null;
  }
}

export function classifyAddress(address: string): AddressClass {
  const ip = parseIp(address);
  if (!ip) return 'denied';
  if (EXTRA_DENIED.some((range) => inCidr(ip, range))) return 'denied';
  const range = ip.range();
  if (RELAXABLE.has(range)) return 'relaxable';
  if (range !== 'unicast') return 'denied';
  if (ip instanceof ipaddr.IPv6 && !inCidr(ip, IPV6_GLOBAL)) return 'denied';
  return 'public';
}

/** Defence in depth on top of `proxyUrlDenyReason`: names that point back at a host or orchestrator. */
function extraNameDenied(host: string): boolean {
  return (
    host.endsWith('.localhost') ||
    host === 'docker.internal' ||
    host.endsWith('.docker.internal') ||
    host === 'kubernetes' ||
    host.startsWith('kubernetes.default')
  );
}

function platformNameDenied(host: string): boolean {
  return proxyUrlDenyReason(`http://${host}/`) !== null || extraNameDenied(host);
}

// ── allow-list ────────────────────────────────────────────────────────────────────────────────

export type AllowEntry =
  | { kind: 'host'; host: string; port: number | null }
  | { kind: 'cidr'; range: Cidr; port: number | null };

function parsePort(raw: string | undefined, entry: string): number | null {
  if (raw === undefined) return null;
  const port = Number(raw);
  if (!/^\d{1,5}$/.test(raw) || port < 1 || port > 65535) throw new Error(`SPEC_FETCH_ALLOWED_HOSTS: invalid port in "${entry}"`);
  return port;
}

function parseEntry(entry: string): AllowEntry {
  const bad = (why: string): Error => new Error(`SPEC_FETCH_ALLOWED_HOSTS: invalid entry "${entry}" (${why})`);
  let target: string;
  let port: number | null;
  const bracketed = /^\[([^\]]+)\](?::(.*))?$/.exec(entry);
  if (bracketed) {
    target = bracketed[1];
    port = parsePort(bracketed[2], entry);
  } else if ((entry.match(/:/g) ?? []).length === 1) {
    const [head, tail] = entry.split(':');
    target = head;
    port = parsePort(tail, entry);
  } else {
    target = entry; // a bare IPv6 address or CIDR, or a name without a port
    port = null;
  }

  // Normalise a name the way the fetcher will see it, so a numeric spelling ("172.18.3", "0x7f.1")
  // is treated as the address it is — and gets the own-network overlap check — not as a name.
  if (!target.includes('/') && !ipaddr.isValid(target) && /^[\p{L}\p{N}.-]+$/u.test(target)) {
    try {
      const normalised = new URL(`http://${target}/`).hostname;
      if (isIP(normalised)) target = normalised;
    } catch {
      // not a valid host at all: refused below
    }
  }

  if (target.includes('/') || ipaddr.isValid(target)) {
    let range: Cidr;
    try {
      range = target.includes('/') ? ipaddr.parseCIDR(target) : [ipaddr.parse(target), ipaddr.parse(target).kind() === 'ipv4' ? 32 : 128];
    } catch {
      throw bad('not an IP address or CIDR');
    }
    return { kind: 'cidr', range, port };
  }

  // Letters (IDN included), digits, dots and hyphens only: no userinfo, path or other URL syntax.
  if (!/^[\p{L}\p{N}.-]+$/u.test(target)) throw bad('not a plain host name');
  let host: string;
  try {
    host = new URL(`http://${target}/`).hostname.replace(/\.$/, '');
  } catch {
    throw bad('not a host name');
  }
  if (!host) throw bad('not a host name');
  // The Compose-service denylist wins over the allow-list: refuse the configuration outright.
  if (platformNameDenied(host)) throw bad('the host is on the platform denylist');
  return { kind: 'host', host, port };
}

/** This container's own interface networks (loopback included), from `os.networkInterfaces()`. */
export function ownNetworks(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>): Cidr[] {
  const own: Cidr[] = [];
  for (const infos of Object.values(interfaces)) {
    for (const info of infos ?? []) {
      if (!info.cidr) continue;
      try {
        own.push(ipaddr.parseCIDR(info.cidr.replace(/%[^/]*/, '')));
      } catch {
        // an interface ipaddr cannot parse cannot be matched by an address either
      }
    }
  }
  return own;
}

function overlaps(a: Cidr, b: Cidr): boolean {
  return inCidr(a[0], b) || inCidr(b[0], a);
}

/**
 * Parse `SPEC_FETCH_ALLOWED_HOSTS`. Throws (naming the entry) on an invalid entry or on a CIDR that
 * overlaps one of this container's own interface networks — that CIDR would expose every service on
 * the platform's own networks by IP address.
 */
export function parseAllowList(
  raw: string | undefined,
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>,
): AllowEntry[] {
  const entries = (raw ?? '')
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean)
    .map(parseEntry);

  const own = ownNetworks(interfaces);
  for (const entry of entries) {
    if (entry.kind !== 'cidr') continue;
    const hit = own.find((net) => overlaps(entry.range, net));
    if (hit) {
      throw new Error(
        `SPEC_FETCH_ALLOWED_HOSTS: "${entry.range[0].toString()}/${String(entry.range[1])}" overlaps this container's own network ${hit[0].toString()}/${String(hit[1])}; allow-list the internal host by name instead`,
      );
    }
  }
  return entries;
}

// ── URL rules ─────────────────────────────────────────────────────────────────────────────────

/** WHATWG-parsed URL or BAD_URL: http(s), ≤ 2048 chars, a host, no userinfo. */
export function parseSpecUrl(raw: unknown): URL {
  if (typeof raw !== 'string' || raw.length > MAX_URL_LENGTH) throw new SpecFetchError('BAD_URL');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SpecFetchError('BAD_URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new SpecFetchError('BAD_URL');
  if (url.username || url.password || !url.hostname) throw new SpecFetchError('BAD_URL');
  return url;
}

/** Host without IPv6 brackets or the root label. */
export function bareHost(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
}

/** True when the platform's name denylist (`proxyUrlDenyReason`, used as a boolean only) refuses the host. */
export function nameDenied(url: URL): boolean {
  return proxyUrlDenyReason(url.href) !== null || extraNameDenied(bareHost(url));
}

/** No port on the entry = the scheme default only; an explicit port matches the effective port (WHATWG drops `:80`/`:443`). */
function portMatches(entryPort: number | null, url: URL): boolean {
  if (entryPort === null) return url.port === '';
  const effective = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  return effective === entryPort;
}

/** May the fetcher connect to `address` for `url`? */
export function addressAllowed(
  address: string,
  url: URL,
  allowList: readonly AllowEntry[],
  own: readonly Cidr[] = [],
): boolean {
  const ip = parseIp(address);
  // An address on this container's own networks (the Compose networks) is refused for every name,
  // allow-listed or not: a name entry must not become a way onto the platform's own services.
  if (ip && own.some((net) => inCidr(ip, net))) return false;
  const cls = classifyAddress(address);
  if (cls === 'public') return true;
  if (cls === 'denied') return false;
  const host = bareHost(url);
  return allowList.some((entry) =>
    entry.kind === 'host'
      ? entry.host === host && portMatches(entry.port, url)
      : ip !== null && inCidr(ip, entry.range) && portMatches(entry.port, url),
  );
}
