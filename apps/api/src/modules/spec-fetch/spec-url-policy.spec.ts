import type { NetworkInterfaceInfo } from 'node:os';
import { SpecFetchError, redactSpecUrl } from './spec-fetch.types';
import { addressAllowed, classifyAddress, nameDenied, ownNetworks, parseAllowList, parseSpecUrl } from './spec-url-policy';

const iface = (cidr: string): NetworkInterfaceInfo[] => [
  { address: cidr.split('/')[0] ?? '', netmask: '', family: cidr.includes(':') ? 'IPv6' : 'IPv4', mac: '', internal: false, cidr, scopeid: 0 } as NetworkInterfaceInfo,
];
const OWN = { lo: iface('127.0.0.1/8'), eth0: iface('172.18.0.5/16'), lo6: iface('::1/128') };

describe('classifyAddress (REV 2 M1 range table)', () => {
  // Every range the contract names, plus the IPv4-mapped form of the dangerous ones.
  it.each([
    ['127.0.0.1', 'loopback'],
    ['127.255.255.254', 'loopback'],
    ['0.0.0.0', 'unspecified'],
    ['0.1.2.3', '0.0.0.0/8'],
    ['169.254.169.254', 'metadata / link-local'],
    ['169.254.1.1', 'link-local'],
    ['224.0.0.1', 'multicast'],
    ['239.255.255.250', 'multicast'],
    ['255.255.255.255', 'broadcast'],
    ['240.0.0.1', '240/4 reserved'],
    ['192.0.0.8', '192.0.0.0/24'],
    ['192.0.2.1', 'TEST-NET-1'],
    ['198.51.100.1', 'TEST-NET-2'],
    ['203.0.113.1', 'TEST-NET-3'],
    ['198.18.0.1', '198.18/15 benchmarking'],
    ['198.19.255.254', '198.18/15 benchmarking'],
    ['192.88.99.1', '6to4 relay anycast'],
    ['::1', 'IPv6 loopback'],
    ['::', 'IPv6 unspecified'],
    ['fe80::1', 'IPv6 link-local'],
    ['fe80::1%eth0', 'IPv6 link-local with zone'],
    ['ff02::1', 'IPv6 multicast'],
    ['::ffff:127.0.0.1', 'IPv4-mapped loopback'],
    ['::ffff:169.254.169.254', 'IPv4-mapped metadata'],
    ['::ffff:0.0.0.0', 'IPv4-mapped unspecified'],
    ['::7f00:1', 'IPv4-compatible loopback'],
    ['::808:808', 'IPv4-compatible public'],
    ['64:ff9b::7f00:1', 'NAT64 (rfc6052) of loopback'],
    ['64:ff9b::808:808', 'NAT64 (rfc6052) of public'],
    ['64:ff9b:1::1', 'local-use NAT64'],
    ['::ffff:0:808:808', 'rfc6145 translated'],
    ['2002:7f00:1::1', '6to4 of loopback'],
    ['2002:c000:201::1', '6to4'],
    ['2001::1', 'Teredo'],
    ['2001:0:4136:e378:8000:63bf:3fff:fdd2', 'Teredo'],
    ['2001:db8::1', 'documentation'],
    ['3fff::1', 'documentation (RFC 9637)'],
    ['100::1', 'discard-only 100::/64'],
    ['fec0::1', 'site-local fec0::/10'],
    ['2001:10::1', 'ORCHID'],
    ['2001:2::1', 'benchmarking'],
    ['5f00::1', 'SRv6'],
    ['4000::1', 'outside 2000::/3'],
    ['100.100.100.200', 'Alibaba metadata (inside CGNAT)'],
    ['100.100.100.100', 'Alibaba DNS/metadata (inside CGNAT)'],
    ['fd00:ec2::254', 'AWS IPv6 IMDS (inside ULA)'],
    ['fd00:ec2::253', 'AWS IPv6 DNS (inside ULA)'],
    ['168.63.129.16', 'Azure WireServer (public by range)'],
    ['192.0.0.192', 'Oracle Cloud metadata'],
    ['::ffff:100.100.100.200', 'IPv4-mapped Alibaba metadata'],
    ['not-an-ip', 'garbage'],
    ['', 'empty'],
  ])('denies %s (%s)', (address) => {
    expect(classifyAddress(address)).toBe('denied');
  });

  it.each(['10.0.0.1', '172.16.0.1', '172.31.255.254', '192.168.1.1', '100.64.0.1', '100.127.255.254', 'fd00::1', 'fc00::1', '::ffff:10.0.0.1'])(
    'marks %s relaxable (private / ULA / CGNAT: allow-list only)',
    (address) => {
      expect(classifyAddress(address)).toBe('relaxable');
    },
  );

  it.each(['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700::1111', '2a00:1450:4007:80e::200e', '::ffff:8.8.8.8'])('allows public %s', (address) => {
    expect(classifyAddress(address)).toBe('public');
  });
});

describe('parseSpecUrl', () => {
  const code = (raw: unknown): string => {
    try {
      parseSpecUrl(raw);
      return 'OK';
    } catch (err) {
      return err instanceof SpecFetchError ? err.code : 'THREW';
    }
  };

  it.each([
    ['ftp://example.com/spec.json'],
    ['file:///etc/passwd'],
    ['javascript:alert(1)'],
    ['data:text/plain,openapi'],
    ['not a url'],
    ['//example.com/spec'],
    ['http://user@example.com/spec'],
    ['http://user:pw@example.com/spec'],
    ['https://:pw@example.com/spec'],
    [`https://example.com/${'a'.repeat(2049)}`],
    [42],
    [null],
  ])('refuses %s as BAD_URL', (raw) => {
    expect(code(raw)).toBe('BAD_URL');
  });

  it('accepts an https URL whose query carries a token (the supported way to pass a secret)', () => {
    expect(code('https://specs.example.com/openapi.yaml?token=abc')).toBe('OK');
  });

  it('normalises numeric IPv4 spellings to a dotted quad (then classified as an address)', () => {
    for (const raw of ['http://2130706433/', 'http://0x7f000001/', 'http://0177.0.0.1/', 'http://127.1/', 'http://0x7f.1/']) {
      expect(parseSpecUrl(raw).hostname).toBe('127.0.0.1');
    }
  });

  it('turns an IDN into punycode', () => {
    expect(parseSpecUrl('http://bücher.example/spec').hostname).toBe('xn--bcher-kva.example');
  });
});

describe('parseAllowList (REV 2 M2)', () => {
  it('is empty by default', () => {
    expect(parseAllowList(undefined, OWN)).toEqual([]);
    expect(parseAllowList(' , ', OWN)).toEqual([]);
  });

  it('parses names, IPs and CIDRs with and without ports', () => {
    const list = parseAllowList('specs.corp.example, specs2.corp.example:8443, 10.20.0.0/16, 10.30.0.7:8080, [fd12:3456::/32]:9000, fd99::1', OWN);
    expect(list.map((e) => (e.kind === 'host' ? `${e.host}:${String(e.port)}` : `${e.range[0].toString()}/${String(e.range[1])}:${String(e.port)}`))).toEqual([
      'specs.corp.example:null',
      'specs2.corp.example:8443',
      '10.20.0.0/16:null',
      '10.30.0.7/32:8080',
      'fd12:3456::/32:9000',
      'fd99::1/128:null',
    ]);
  });

  it.each(['http://x.example', 'a@b.example', 'x.example/path', '10.0.0.0/33', 'host:0', 'host:70000', 'host:abc', '[fd00::1'])(
    'fails loudly on the invalid entry %s, naming it',
    (entry) => {
      expect(() => parseAllowList(entry, OWN)).toThrow(entry);
    },
  );

  it.each(['postgres', 'hydra:4445', 'open-gateway-api', 'localhost', 'metadata.google.internal', 'foo.localhost', 'host.docker.internal', 'gateway.docker.internal', 'kubernetes.default.svc'])(
    'refuses a platform-denylisted name (%s) in the allow-list',
    (entry) => {
      expect(() => parseAllowList(entry, OWN)).toThrow(/denylist/);
    },
  );

  it.each(['172.16.0.0/12', '172.18.0.0/24', '172.18.0.5', '127.0.0.0/8', '0.0.0.0/0', '::/0'])(
    'refuses at startup a CIDR (%s) that overlaps this container’s own networks',
    (entry) => {
      expect(() => parseAllowList(entry, OWN)).toThrow(/overlaps this container/);
    },
  );

  it.each(['172.18.3', '172.18.3:8080', '0x7f.1', '2130706433', '0254.022.0.3'])(
    'normalises the numeric spelling %s to an address, so the own-network check applies',
    (entry) => {
      expect(() => parseAllowList(entry, OWN)).toThrow(/overlaps this container/);
    },
  );

  it('normalises a numeric spelling that is not on an own network into a CIDR entry', () => {
    expect(parseAllowList('10.1', OWN)).toEqual([expect.objectContaining({ kind: 'cidr' })]);
  });

  it('accepts a CIDR that does not overlap the own networks', () => {
    expect(parseAllowList('10.0.0.0/8', OWN)).toHaveLength(1);
  });
});

describe('addressAllowed', () => {
  const list = parseAllowList('specs.corp.example, alt.corp.example:8443, 10.20.0.0/16, 10.30.0.7:8080', OWN);
  const url = (s: string): URL => new URL(s);

  it('allows a public address for any name and port, with or without a list', () => {
    expect(addressAllowed('8.8.8.8', url('https://x.example:9443/'), [])).toBe(true);
  });

  it('refuses a private address when nothing allow-lists it', () => {
    expect(addressAllowed('10.1.2.3', url('https://x.example/'), [])).toBe(false);
    expect(addressAllowed('10.1.2.3', url('https://x.example/'), list)).toBe(false);
  });

  it('allows a private address for an allow-listed name on the default port only', () => {
    expect(addressAllowed('192.168.9.9', url('https://specs.corp.example/'), list)).toBe(true);
    expect(addressAllowed('192.168.9.9', url('http://specs.corp.example/'), list)).toBe(true);
    expect(addressAllowed('192.168.9.9', url('https://specs.corp.example:8443/'), list)).toBe(false);
  });

  it('honours an explicit port on a name entry', () => {
    expect(addressAllowed('192.168.9.9', url('https://alt.corp.example:8443/'), list)).toBe(true);
    expect(addressAllowed('192.168.9.9', url('https://alt.corp.example/'), list)).toBe(false);
  });

  it('matches CIDR entries by address and port', () => {
    expect(addressAllowed('10.20.3.4', url('http://anything.example/'), list)).toBe(true);
    expect(addressAllowed('10.20.3.4', url('http://anything.example:81/'), list)).toBe(false);
    expect(addressAllowed('10.30.0.7', url('http://anything.example:8080/'), list)).toBe(true);
    expect(addressAllowed('10.30.0.8', url('http://anything.example:8080/'), list)).toBe(false);
  });

  it('an explicit :443 / :80 entry matches the default-port URL (WHATWG drops default ports)', () => {
    const l = parseAllowList('tls.corp.example:443, plain.corp.example:80', OWN);
    expect(addressAllowed('10.1.1.1', url('https://tls.corp.example/'), l)).toBe(true);
    expect(addressAllowed('10.1.1.1', url('https://tls.corp.example:443/'), l)).toBe(true);
    expect(addressAllowed('10.1.1.1', url('http://plain.corp.example/'), l)).toBe(true);
    expect(addressAllowed('10.1.1.1', url('http://tls.corp.example/'), l)).toBe(false); // http default is 80
  });

  it('metadata stays refused inside an allow-listed CIDR; the rest of the CIDR is allowed', () => {
    const l = parseAllowList('100.64.0.0/10, fd00::/8', OWN);
    expect(addressAllowed('100.100.100.200', url('http://x.example/'), l)).toBe(false);
    expect(addressAllowed('100.100.100.100', url('http://x.example/'), l)).toBe(false);
    expect(addressAllowed('100.64.1.1', url('http://x.example/'), l)).toBe(true);
    expect(addressAllowed('fd00:ec2::254', url('http://x.example/'), l)).toBe(false);
    expect(addressAllowed('fd00::5', url('http://x.example/'), l)).toBe(true);
  });

  it('refuses an address on the container’s own networks even for an allow-listed name', () => {
    const own = ownNetworks(OWN);
    expect(addressAllowed('172.18.0.3', url('https://specs.corp.example/'), list, own)).toBe(false);
    expect(addressAllowed('172.18.0.3', url('https://specs.corp.example/'), list, [])).toBe(true);
    expect(addressAllowed('192.168.9.9', url('https://specs.corp.example/'), list, own)).toBe(true);
  });

  it.each(['169.254.169.254', '127.0.0.1', '::1', '0.0.0.0', '::ffff:127.0.0.1', 'fe80::1'])(
    'refuses an allow-listed name re-pointed to %s',
    (address) => {
      expect(addressAllowed(address, url('https://specs.corp.example/'), list)).toBe(false);
    },
  );
});

describe('nameDenied (defence in depth)', () => {
  it.each(['http://foo.localhost/', 'http://host.docker.internal/', 'http://gateway.docker.internal/', 'http://x.docker.internal/', 'http://kubernetes.default/', 'http://kubernetes.default.svc.cluster.local/', 'http://postgres/'])(
    'denies %s',
    (raw) => {
      expect(nameDenied(new URL(raw))).toBe(true);
    },
  );
  it.each(['http://specs.example.com/', 'http://localhost.example.com/', 'http://docker.internal.example/'])('allows %s', (raw) => {
    expect(nameDenied(new URL(raw))).toBe(false);
  });
});

describe('redactSpecUrl', () => {
  it('keeps scheme and host only', () => {
    expect(redactSpecUrl('https://u:p@specs.example.com:8443/a/b.yaml?token=s3cret#frag')).toBe('https://specs.example.com:8443/…');
  });
  it.each(['garbage', 'ftp://x/y', ''])('returns an empty string for %s', (raw) => {
    expect(redactSpecUrl(raw)).toBe('');
  });
});
