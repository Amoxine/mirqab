import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { DebugRequestDto } from './debug-request.dto';
import {
  parseDebugEnvelope,
  stripSecrets,
} from '../../tyk-integration/services/tyk-client.service';

jest.mock('@open-gateway/database', () => ({ prisma: {} }));

const validate = (v: Record<string, unknown>) =>
  validateSync(plainToInstance(DebugRequestDto, v), { whitelist: true, forbidNonWhitelisted: true });

describe('Test-request DTO reuses the SSRF deny list', () => {
  it('accepts a plain external target', () => {
    expect(validate({ method: 'GET', path: '/x', targetUrl: 'https://staging.example.com' })).toHaveLength(0);
  });

  it('rejects a target on the deny list — the same list proxyUrl uses, not a second one', () => {
    // If this ever passes, someone has written a second SSRF check that has already drifted.
    for (const host of ['http://tyk-gateway:8080', 'http://redis:6379', 'http://127.0.0.1:8080']) {
      const errors = validate({ method: 'GET', path: '/x', targetUrl: host });
      expect(errors).toHaveLength(1);
      expect(errors[0].property).toBe('targetUrl');
    }
  });

  it('is usable with no override at all — the stored upstream is the default', () => {
    expect(validate({ method: 'GET', path: '/x' })).toHaveLength(0);
  });

  it('requires a leading slash on the path and a known method', () => {
    expect(validate({ method: 'GET', path: 'no-slash' })).toHaveLength(1);
    expect(validate({ method: 'TRACE', path: '/x' })).toHaveLength(1);
  });
});

describe('Test-request headers are checked here, not left for Tyk to reject as "Request malformed"', () => {
  const headerErrors = (headers: unknown) =>
    validate({ method: 'GET', path: '/x', headers }).filter((e) => e.property === 'headers');

  it('accepts a plain name -> string map', () => {
    expect(headerErrors({ 'X-Trace': 'abc', Authorization: 'Bearer t' })).toHaveLength(0);
  });

  it('rejects a value that is not a string', () => {
    for (const value of [['abc'], 42, { a: 'b' }, null])
      expect(headerErrors({ 'X-Trace': value })).toHaveLength(1);
  });

  it('rejects a name that is not an RFC 7230 token and a value carrying CR, LF or NUL', () => {
    expect(headerErrors({ 'X Trace': 'abc' })).toHaveLength(1);
    expect(headerErrors({ 'X-Trace': 'a\r\nX-Evil: 1' })).toHaveLength(1);
    expect(headerErrors({ 'X-Trace': 'a\0' })).toHaveLength(1);
  });

  it('caps the header count and each name/value length', () => {
    const many = Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`X-H${String(i)}`, 'v']));
    expect(headerErrors(many)).toHaveLength(1);
    expect(headerErrors({ 'X-Trace': 'v'.repeat(256) })).toHaveLength(1);
    expect(headerErrors({ ['X-' + 'n'.repeat(254)]: 'v' })).toHaveLength(1);
  });
});

describe('stripSecrets keeps the gateway secret out of the browser', () => {
  const SECRET = 'super-secret-admin-key';

  it('redacts the secret anywhere it appears, however deeply nested', () => {
    const raw = {
      logs: [{ msg: `auth header was ${SECRET}` }],
      response: { headers: { 'x-tyk-authorization': SECRET } },
    };
    const out = stripSecrets(raw, SECRET);
    expect(JSON.stringify(out)).not.toContain(SECRET);
    expect(out.logs[0].msg).toContain('[redacted]');
    expect(out.response.headers['x-tyk-authorization']).toBe('[redacted]');
  });

  it('leaves a clean payload untouched and identical', () => {
    const clean = { response: { code: 200, body: 'ok' } };
    expect(stripSecrets(clean, SECRET)).toEqual(clean);
  });

  it('does nothing when no secret is configured, rather than redacting the empty string', () => {
    // Splitting on '' would shred every character of the response.
    const payload = { response: { body: 'abc' } };
    expect(stripSecrets(payload, '')).toEqual(payload);
  });
});

// Tyk 5.15.0 answers /debug with two STRINGS — a raw HTTP dump and NDJSON logs — not the objects the
// Designer reads. Fixtures below are trimmed captures from the live 5.15.0 gateway.
describe('parseDebugEnvelope turns the 5.15.0 /debug strings into the declared result', () => {
  const dump = (response: string) =>
    '====== Request ======\nGET /health HTTP/1.1\r\nHost: api-qbus.qbot.ma\r\nX-Trace: abc\r\n\r\n\n' +
    `====== Response ======\n${response}`;

  it('reads code, headers and body out of the response dump', () => {
    const out = parseDebugEnvelope({
      message: 'ok',
      response: dump(
        'HTTP/1.1 200 OK\r\nContent-Length: 30\r\nContent-Type: application/json; charset=utf-8\r\n' +
          'Vary: Accept-Encoding\r\nVary: Origin\r\n\r\n{"status":"ok","checks":{"a":1}}',
      ),
    });
    expect(out.response).toEqual({
      code: 200,
      headers: {
        'Content-Length': '30',
        'Content-Type': 'application/json; charset=utf-8',
        Vary: 'Accept-Encoding, Origin',
      },
      body: '{"status":"ok","checks":{"a":1}}',
    });
  });

  it('keeps a gateway-generated error response and a body with its own blank lines intact', () => {
    const out = parseDebugEnvelope({
      response: dump(
        'HTTP/1.1 500 Internal Server Error\r\nX-Generator: tyk.io\r\n\r\n{\n    "error": "There was a problem proxying the request"\n}',
      ),
    });
    expect(out.response?.code).toBe(500);
    expect(out.response?.body).toBe(
      '{\n    "error": "There was a problem proxying the request"\n}',
    );
  });

  it('turns NDJSON logs into entries, keeping only level/msg/mw and skipping junk lines', () => {
    const logs =
      '{"level":"warning","msg":"Legacy path detected! Upgrade to extended.","time":"t"}\n' +
      'not json\n' +
      '{"api_id":"a","level":"error","msg":"http: proxy error","mw":"ReverseProxy","server_name":"127.0.0.1:1"}\n';
    expect(parseDebugEnvelope({ logs }).logs).toEqual([
      { level: 'warning', msg: 'Legacy path detected! Upgrade to extended.' },
      { level: 'error', msg: 'http: proxy error', mw: 'ReverseProxy' },
    ]);
  });

  it('treats upstream header names like constructor and __proto__ as plain names', () => {
    const out = parseDebugEnvelope({
      response: dump('HTTP/1.1 204 No Content\r\nconstructor: a\r\n__proto__: b\r\n\r\n'),
    });
    expect(out.response?.headers?.constructor).toBe('a');
    expect(Object.getOwnPropertyDescriptor(out.response?.headers, '__proto__')?.value).toBe('b');
  });

  it('never throws on shapes it does not recognise', () => {
    expect(parseDebugEnvelope(null)).toEqual({});
    expect(parseDebugEnvelope({ response: 'no response section here' })).toEqual({});
    expect(parseDebugEnvelope({ response: { code: 204 }, logs: 7 })).toEqual({});
  });
});
