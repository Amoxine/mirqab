import { registerDecorator, type ValidationArguments, type ValidationOptions } from 'class-validator';

/**
 * Upstream host denylist for `proxyUrl` (B2).
 *
 * A tenant admin can publish a keyless route to any upstream, so without this an API could be
 * pointed at the cloud metadata service or at the platform's own internals and the gateway would
 * proxy the answer back out. This is a DENYLIST, not SSRF protection: self-hosted upstreams
 * (`http://orders:8080`, RFC1918 addresses, unique-local IPv6) are the product's main use case and
 * stay allowed. Out of scope, by design: DNS rebinding, and public names that resolve to a private
 * address — both need resolve-time enforcement at the proxy, which Tyk OSS does not offer.
 */
const DENIED_HOSTS = new Set([
  // loopback / unspecified, by name
  'localhost',
  // cloud metadata by name (GCP and Alibaba also answer to the bare `metadata`)
  'metadata',
  'metadata.google.internal',
  // ── Every service name in infra/docker-compose.yml ──────────────────────────────────────────
  // KEEP IN SYNC WITH THAT FILE. Each name resolves on the shared compose network, so a service
  // added there is a new upstream target here the moment it exists — this list has already drifted
  // behind an infra change twice. `proxy-url.validator.spec.ts` parses the compose file and fails
  // if a name is missing, so the drift is caught in CI rather than by a reviewer.
  //
  // Hydra's (4445), Kratos's (4434) and Keto's (4467) ADMIN APIs are UNAUTHENTICATED by design:
  // "only reachable inside the compose network" is the whole of their protection, and an API
  // proxying to one of them punches a hole straight through it (Kratos admin mints recovery links
  // for any identity, Hydra admin owns every OAuth2 client, Keto admin writes tenant membership).
  //
  // `edge` (WP26b) is the TLS terminator and the only service that publishes a port. Proxying to
  // it is worse than reaching any single service: its five listeners fan back out to web, api,
  // tyk-gateway, hydra and kratos, so one allowed upstream would re-enter the whole stack — and
  // the request would arrive at the edge from the gateway, which then stamps
  // `X-Forwarded-For: <gateway>` over it. The container name `open-gateway-edge` is already
  // covered by DENIED_HOST_PREFIX below; this is the short compose alias.
  'edge',
  'postgres',
  'redis',
  'tyk-gateway',
  'tyk-gateway-init',
  // The `multinode` profile's extra nodes (WP13a). Denied for the same reason as `tyk-gateway`
  // itself — and they are NOT exempt for being profile-gated: the deny list is evaluated at
  // runtime against whatever the operator actually started, and a proxy pointed at
  // `http://tyk-gateway-2:8080/` would loop back into the data plane exactly like node 1.
  'tyk-gateway-2',
  'tyk-gateway-3',
  'tyk-gateway-multinode-init',
  'tyk-pump',
  'tyk-healthcheck',
  'api',
  'web',
  'ory-db-init',
  'hydra',
  'hydra-migrate',
  'kratos',
  'kratos-migrate',
  'keto',
  'keto-migrate',
]);

/**
 * Docker's embedded DNS resolves CONTAINER names on a user-defined network as well as compose's
 * service aliases (verified: `open-gateway-hydra` and `hydra` answer with the same address), and
 * every container this stack starts is named `open-gateway-*` — explicitly via `container_name`,
 * or as `<project>-<service>-<n>` if one is ever dropped. Denying the prefix covers both forms and
 * needs no maintenance when a service is added.
 */
const DENIED_HOST_PREFIX = 'open-gateway-';

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** Extra hosts from `PROXY_DENY_HOSTS` (comma separated). Read per call so config changes need no restart. */
function extraDeniedHosts(): Set<string> {
  const raw = process.env.PROXY_DENY_HOSTS ?? '';
  return new Set(
    raw
      .split(',')
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** Dotted-quad octets, or null when the string is not one (then it is a name, not an address). */
function ipv4Octets(host: string): number[] | null {
  const match = IPV4.exec(host);
  if (!match) return null;
  const octets = match.slice(1, 5).map(Number);
  return octets.every((octet) => octet <= 255) ? octets : null;
}

function ipv4Reason(octets: number[]): string | null {
  const [a, b] = octets;
  if (a === 127) return 'loopback addresses are not allowed';
  if (a === 0) return 'the unspecified address (0.0.0.0/8) is not allowed';
  if (a === 169 && b === 254) return 'link-local / cloud metadata addresses (169.254.0.0/16) are not allowed';
  return null;
}

/** Expand a (possibly compressed) IPv6 literal into its 8 groups; null when it is not a valid one. */
function ipv6Groups(literal: string): number[] | null {
  const halves = literal.split('::');
  if (halves.length > 2) return null;

  const parse = (part: string): number[] | null => {
    if (part === '') return [];
    const groups: number[] = [];
    for (const piece of part.split(':')) {
      // Trailing dotted-quad form, e.g. ::ffff:127.0.0.1
      const octets = ipv4Octets(piece);
      if (octets) {
        groups.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(piece)) return null;
      groups.push(parseInt(piece, 16));
    }
    return groups;
  };

  const head = parse(halves[0] ?? '');
  const tail = halves.length === 2 ? parse(halves[1] ?? '') : [];
  if (!head || !tail) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;

  const zeros = 8 - head.length - tail.length;
  return zeros < 1 ? null : [...head, ...new Array<number>(zeros).fill(0), ...tail];
}

function ipv6Reason(groups: number[]): string | null {
  const [first, , , , , marker, high, low] = groups;

  if (groups.every((group, i) => group === (i === 7 ? 1 : 0))) return 'loopback addresses are not allowed';
  if (groups.every((group) => group === 0)) return 'the unspecified address (::) is not allowed';
  if ((first & 0xffc0) === 0xfe80) return 'link-local addresses (fe80::/10) are not allowed';

  // ::ffff:a.b.c.d (IPv4-mapped) and ::a.b.c.d (IPv4-compatible) carry an IPv4 address.
  const prefixIsZero = groups.slice(0, 5).every((group) => group === 0);
  if (prefixIsZero && (marker === 0xffff || marker === 0)) {
    return ipv4Reason([high >> 8, high & 0xff, low >> 8, low & 0xff]);
  }
  return null;
}

/**
 * Why `value` may not be used as an upstream URL, or null when it may.
 *
 * Works off the parsed host, so userinfo (`http://evil@127.0.0.1`) and the decimal / hex / octal
 * IPv4 forms the WHATWG parser normalises (`http://2130706433`, `http://0x7f000001`) are covered.
 */
export function proxyUrlDenyReason(value: unknown): string | null {
  if (typeof value !== 'string') return 'proxyUrl must be a string';

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'proxyUrl must be an absolute http(s) URL';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'proxyUrl must use http or https';

  // Strip the IPv6 brackets and the root label ("localhost." is the same host as "localhost").
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (!host) return 'proxyUrl must include a host';

  const reasonFor = (why: string): string => `proxyUrl host "${host}" is not allowed: ${why}`;

  if (DENIED_HOSTS.has(host) || host.startsWith(DENIED_HOST_PREFIX)) {
    return reasonFor('it points at the platform itself or at a metadata service');
  }
  if (extraDeniedHosts().has(host)) return reasonFor('it is listed in PROXY_DENY_HOSTS');

  const octets = ipv4Octets(host);
  if (octets) {
    const reason = ipv4Reason(octets);
    return reason ? reasonFor(reason) : null;
  }

  const groups = ipv6Groups(host);
  if (groups) {
    const reason = ipv6Reason(groups);
    return reason ? reasonFor(reason) : null;
  }

  return null;
}

/** class-validator constraint around {@link proxyUrlDenyReason}; the message is the reason itself. */
export function IsAllowedProxyUrl(validationOptions?: ValidationOptions) {
  return function (target: object, propertyName: string): void {
    registerDecorator({
      name: 'isAllowedProxyUrl',
      target: target.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate: (value: unknown): boolean => proxyUrlDenyReason(value) === null,
        defaultMessage: (args?: ValidationArguments): string =>
          proxyUrlDenyReason(args?.value) ?? 'proxyUrl is not an allowed upstream',
      },
    });
  };
}
