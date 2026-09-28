import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { proxyUrlDenyReason } from './proxy-url.validator';
import { CreateApiDto } from './create-api.dto';
import { UpdateApiDto } from './update-api.dto';

describe('proxyUrlDenyReason', () => {
  const allowed = [
    // Self-hosted upstreams are the product's main use case and must keep working.
    'http://my-backend:8080/v1',
    'http://orders.default.svc.cluster.local/api',
    'https://httpbin.org/anything',
    'http://10.0.0.5:3000',
    'http://192.168.1.10',
    'http://172.16.4.4:8080',
    'https://1.1.1.1',
    'http://[fd00::1]:8080',
    'http://user:pass@backend.example.com/api',
    // 169.253/169.255 neighbour the link-local block without being in it
    'http://169.253.0.1',
    'http://169.255.0.1',
  ];

  it.each(allowed)('allows %s', (url) => {
    expect(proxyUrlDenyReason(url)).toBeNull();
  });

  const denied: [string, RegExp][] = [
    ['http://localhost:3000', /loopback|platform itself/],
    ['http://LOCALHOST/api', /platform itself/],
    ['http://localhost./api', /platform itself/],
    ['http://127.0.0.1:8080/tyk', /loopback/],
    ['http://127.1', /loopback/],
    ['http://0.0.0.0:4000', /unspecified/],
    ['http://0', /unspecified/],
    ['http://169.254.169.254/latest/meta-data/', /link-local/],
    ['http://169.254.170.2/v2/credentials', /link-local/],
    ['http://metadata.google.internal/computeMetadata/v1/', /platform itself|metadata/],
    ['http://metadata/computeMetadata/v1/', /platform itself|metadata/],
    // Not a compose service name, an IP, or a literal loopback address — but a Docker
    // `extra_hosts: host-gateway` entry resolves this to the host itself, so it's denied at the
    // policy layer independent of whether that network wiring exists anywhere today.
    ['http://host.docker.internal:3001/', /platform itself/],
    ['http://gateway.docker.internal:3001/', /platform itself/],
    ['http://tyk-gateway:8080/tyk/apis', /platform itself/],
    ['http://tyk-pump:8083/health', /platform itself/],
    ['http://postgres:5432', /platform itself/],
    ['http://redis:6379', /platform itself/],
    // The three Ory admin APIs are UNAUTHENTICATED; reaching any of them through a proxied API is
    // a full installation takeover (this is the hole the denylist missed until now).
    ['http://kratos:4434/admin/recovery/link', /platform itself/],
    ['http://hydra:4445/admin/clients', /platform itself/],
    ['http://keto:4467/admin/relation-tuples', /platform itself/],
    // The platform's own API and dashboard are upstreams too.
    ['http://api:4000/api/users', /platform itself/],
    ['http://web:3000', /platform itself/],
    // Docker resolves container names as well as compose service aliases.
    ['http://open-gateway-kratos:4434/admin/identities', /platform itself/],
    ['http://open-gateway-api:4000', /platform itself/],
    // userinfo cannot smuggle a denied host past the check: the parsed host is what counts
    ['http://evil@127.0.0.1/', /loopback/],
    ['http://backend.example.com@localhost/', /platform itself/],
    // decimal / hex / octal / short IPv4 forms all normalise to 127.0.0.1
    ['http://2130706433/', /loopback/],
    ['http://0x7f000001/', /loopback/],
    ['http://0177.0.0.1/', /loopback/],
    // IPv6 loopback, link-local, unspecified and IPv4-mapped forms
    ['http://[::1]:9000/', /loopback/],
    ['http://[0:0:0:0:0:0:0:1]/', /loopback/],
    ['http://[::]/', /unspecified/],
    ['http://[fe80::1]/', /link-local/],
    ['http://[febf::dead:beef]/', /link-local/],
    ['http://[::ffff:127.0.0.1]/', /loopback/],
    ['http://[::ffff:169.254.169.254]/', /link-local/],
    // protocol / shape
    ['ftp://backend.example.com/x', /http or https/],
    ['file:///etc/passwd', /http or https/],
    ['not a url', /absolute http/],
  ];

  it.each(denied)('denies %s', (url, reason) => {
    const denial = proxyUrlDenyReason(url);
    expect(denial).not.toBeNull();
    expect(denial).toMatch(reason);
  });

  /**
   * The denylist is hand-maintained and has twice fallen behind an infra change — most recently
   * leaving all three Ory admin APIs reachable. Reading the compose file here turns that class of
   * drift into a failing test the moment a service is added, which is the only reason the list is
   * allowed to stay hand-maintained at all.
   */
  describe('compose service names', () => {
    // src/modules/api-management/dto -> repo root
    const composePath = join(__dirname, '../../../../../../infra/docker-compose.yml');
    const compose = readFileSync(composePath, 'utf8');

    // Top-level `services:` block; its direct children are the two-space-indented keys.
    const serviceBlock = compose.slice(compose.indexOf('\nservices:'), compose.indexOf('\nvolumes:'));
    const serviceNames = [...serviceBlock.matchAll(/^ {2}([a-z0-9][a-z0-9_.-]*):$/gm)].map((m) => m[1]);

    it('finds the services to check (guards the parser itself)', () => {
      expect(serviceNames).toEqual(
        expect.arrayContaining(['postgres', 'redis', 'tyk-gateway', 'api', 'web', 'hydra', 'kratos', 'keto']),
      );
      expect(serviceNames.length).toBeGreaterThanOrEqual(14);
    });

    it.each(serviceNames)('denies the compose service %s', (name) => {
      expect(proxyUrlDenyReason(`http://${name}:8080/`)).toMatch(/platform itself/);
    });

    const containerNames = [...compose.matchAll(/^\s*container_name:\s*(\S+)$/gm)].map((m) => m[1]);

    it.each(containerNames)('denies the container name %s', (name) => {
      expect(proxyUrlDenyReason(`http://${name}:8080/`)).toMatch(/platform itself/);
    });
  });

  it('rejects a non-string value', () => {
    expect(proxyUrlDenyReason(undefined)).toMatch(/string/);
    expect(proxyUrlDenyReason(42)).toMatch(/string/);
  });

  it('never echoes the path or credentials of the URL back to the caller', () => {
    const denial = proxyUrlDenyReason('http://admin:s3cret@127.0.0.1/tyk/keys');
    expect(denial).not.toMatch(/s3cret|tyk\/keys/);
  });

  describe('PROXY_DENY_HOSTS', () => {
    const original = process.env.PROXY_DENY_HOSTS;
    afterEach(() => {
      if (original === undefined) delete process.env.PROXY_DENY_HOSTS;
      else process.env.PROXY_DENY_HOSTS = original;
    });

    it('denies the extra hosts it lists, case- and space-insensitively', () => {
      process.env.PROXY_DENY_HOSTS = ' Vault.internal , 10.1.2.3';
      expect(proxyUrlDenyReason('http://vault.internal/v1')).toMatch(/PROXY_DENY_HOSTS/);
      expect(proxyUrlDenyReason('http://10.1.2.3:8200')).toMatch(/PROXY_DENY_HOSTS/);
      expect(proxyUrlDenyReason('http://other.internal')).toBeNull();
    });

    it('is inert when empty', () => {
      process.env.PROXY_DENY_HOSTS = '';
      expect(proxyUrlDenyReason('http://my-backend:8080')).toBeNull();
    });
  });
});

describe('proxyUrl validation on the DTOs', () => {
  const errorsFor = async (dto: object) =>
    (await validate(dto)).filter((e) => e.property === 'proxyUrl');

  it('rejects a denied upstream on CreateApiDto with the reason as the message', async () => {
    const dto = plainToInstance(CreateApiDto, {
      name: 'Meta',
      slug: 'meta',
      listenPath: '/meta/',
      proxyUrl: 'http://169.254.169.254/',
    });

    const errors = await errorsFor(dto);
    expect(errors).toHaveLength(1);
    expect(JSON.stringify(errors[0]?.constraints)).toMatch(/link-local/);
  });

  // PartialType must carry the custom constraint over, or PATCH would be a way around it.
  it('rejects a denied upstream on UpdateApiDto too', async () => {
    const errors = await errorsFor(plainToInstance(UpdateApiDto, { proxyUrl: 'http://127.0.0.1:8080/tyk' }));
    expect(errors).toHaveLength(1);
  });

  it('accepts an internal service upstream on UpdateApiDto', async () => {
    expect(await errorsFor(plainToInstance(UpdateApiDto, { proxyUrl: 'http://my-backend:8080' }))).toHaveLength(0);
  });
});
