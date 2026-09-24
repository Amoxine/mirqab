import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { DebugRequestDto } from './debug-request.dto';
import { stripSecrets } from '../../tyk-integration/services/tyk-client.service';

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
