import 'reflect-metadata';
import { certificateExpiry, parseInfoField } from './metrics.service';

jest.mock('@open-gateway/database', () => ({ prisma: {} }));

// Redis answers INFO with CRLF line endings and `# Section` headers; the regex has to survive both.
const MEMORY_INFO = ['# Memory', 'used_memory:1048576', 'used_memory_human:1.00M', 'maxmemory:536870912', 'maxmemory_policy:noeviction', ''].join('\r\n');

describe('parseInfoField', () => {
  it('reads a field out of an INFO section', () => {
    expect(parseInfoField(MEMORY_INFO, 'used_memory')).toBe(1048576);
    expect(parseInfoField(MEMORY_INFO, 'maxmemory')).toBe(536870912);
  });

  it('does not match a longer field that merely starts with the name — maxmemory vs maxmemory_policy', () => {
    // Without the \b this returns null (maxmemory_policy:noeviction has no digits) or, worse for
    // used_memory, the value of used_memory_human. Both would silently break the R3 ratio alert.
    expect(parseInfoField(['# Memory', 'maxmemory_policy:noeviction', 'maxmemory:42'].join('\r\n'), 'maxmemory')).toBe(42);
  });

  it('is null for a field the section does not carry, rather than NaN', () => {
    expect(parseInfoField(MEMORY_INFO, 'evicted_keys')).toBeNull();
  });
});

describe('certificateExpiry', () => {
  // A real self-signed ECC root, shaped like the one Caddy's `tls internal` writes:
  // `openssl req -x509 -newkey ec ... -subj /CN=Open Gateway Test Root`, valid 2026-01-01 → 2036-01-01.
  const ROOT_PEM = `-----BEGIN CERTIFICATE-----
MIIBlzCCAT2gAwIBAgIUc/N3oFU6fDHdNQK9AUFDMBQ62H4wCgYIKoZIzj0EAwIw
ITEfMB0GA1UEAwwWT3BlbiBHYXRld2F5IFRlc3QgUm9vdDAeFw0yNjAxMDEwMDAw
MDBaFw0zNjAxMDEwMDAwMDBaMCExHzAdBgNVBAMMFk9wZW4gR2F0ZXdheSBUZXN0
IFJvb3QwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAAQ9Cke7yzvSo/7jOY2/YGZ8
mPNnIntV64OeIKWHbKhKck9bhsD8zKUkQLR24NdRJK3H414dcLyaFnDLmbV9HSi7
o1MwUTAdBgNVHQ4EFgQUrJRZw0/JHCQt9ZdrUW2jlSQOa4QwHwYDVR0jBBgwFoAU
rJRZw0/JHCQt9ZdrUW2jlSQOa4QwDwYDVR0TAQH/BAUwAwEB/zAKBggqhkjOPQQD
AgNIADBFAiEA5AsDl3Gptf38ksdFER0wu4034t8GGktc7KpUkp8060QCIEgs4mVr
NBNq3De4/8Jolg7qIL5r1ILFbTWFQ1N1bKkZ
-----END CERTIFICATE-----`;

  it('reads the CN and the expiry as a unix timestamp — the units the R14 rule compares to time()', () => {
    expect(certificateExpiry(ROOT_PEM)).toEqual({
      cn: 'Open Gateway Test Root',
      expiry: Date.UTC(2036, 0, 1) / 1000,
      lifetime: (Date.UTC(2036, 0, 1) - Date.UTC(2026, 0, 1)) / 1000,
      selfSigned: true,
    });
  });

  // WP29a: the leaf/intermediate rule divides remaining by THIS, so a wrong lifetime is a rule that
  // fires on a healthy certificate or never fires on a dead one. 10 years, from the dates above.
  it('reports the issued-for lifetime, which is what the fraction-of-lifetime rule divides by', () => {
    const { lifetime, expiry } = certificateExpiry(ROOT_PEM);
    expect(lifetime).toBe(3652 * 24 * 3600);
    // A certificate exactly at Caddy's renewal point has a third of its life left; the rule's 0.25
    // threshold must sit below that or it fires on every healthy renewal cycle.
    const atRenewal = expiry - lifetime / 3;
    expect((expiry - atRenewal) / lifetime).toBeGreaterThan(0.25);
  });

  it('marks a self-signed certificate, so a served root cannot overwrite the file-derived series', () => {
    expect(certificateExpiry(ROOT_PEM).selfSigned).toBe(true);
  });

  it('accepts DER as well as PEM — the TLS probe hands over raw bytes, not a file', () => {
    const der = Buffer.from(ROOT_PEM.replace(/-----[^-]+-----|\s/g, ''), 'base64');
    expect(certificateExpiry(der).cn).toBe('Open Gateway Test Root');
  });

  it('throws on something that is not a certificate rather than reporting a bogus expiry', () => {
    // A metric that silently read 0 would make the R14 rule fire forever; refreshCertificates()
    // turns this throw into an ABSENT series instead.
    expect(() => certificateExpiry('not a certificate')).toThrow();
  });
});
