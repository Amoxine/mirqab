import 'reflect-metadata';
import { BadGatewayException, ConflictException, Logger } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { of, throwError } from 'rxjs';
import type { Observable } from 'rxjs';
import { AuditLogInterceptor } from './audit-log.interceptor';
import type { AuditEntry, AuditService } from '../services/audit.service';

const flushSetImmediate = () => new Promise<void>((resolve) => setImmediate(resolve));

function contextFor(method: string, params: Record<string, string> = {}, path = '/api/keys', body: unknown = {}) {
  const request = {
    method,
    path,
    ip: '10.0.0.1',
    headers: {},
    body,
    params,
    user: { sub: 'user-1' },
    tenantId: 'tenant-1',
  };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => () => undefined,
  } as unknown as ExecutionContext;
}

/** The single entry the interceptor recorded, typed so assertions need no `any`. */
function recorded(record: jest.Mock<Promise<void>, [AuditEntry]>): AuditEntry {
  expect(record).toHaveBeenCalledTimes(1);
  return record.mock.calls[0][0];
}

/** Runs one request through an interceptor and waits for the deferred audit write. */
async function run(
  interceptor: AuditLogInterceptor,
  context: ExecutionContext,
  result: Observable<unknown>,
): Promise<void> {
  await new Promise<void>((resolve) => {
    interceptor.intercept(context, { handle: () => result }).subscribe({
      complete: () => { resolve(); },
      error: () => { resolve(); },
    });
  });
  await flushSetImmediate();
}

describe('AuditLogInterceptor', () => {
  beforeAll(() => {
    Logger.overrideLogger(false);
  });

  const record = jest.fn((_entry: AuditEntry) => Promise.resolve());
  const audit = { record } as unknown as AuditService;
  const reflector = { get: () => ({ action: 'key:created' }) } as unknown as Reflector;
  const interceptor = new AuditLogInterceptor(audit, reflector);

  beforeEach(() => {
    record.mockClear();
  });

  it('records the action once the handler succeeds', async () => {
    await new Promise<void>((resolve) => {
      interceptor.intercept(contextFor('POST'), { handle: () => of('ok') }).subscribe({ complete: () => { resolve(); } });
    });
    await flushSetImmediate();

    expect(record).toHaveBeenCalledWith(expect.objectContaining({ action: 'CREATED', resource: 'keys' }));
  });

  // A rejected request changed nothing: logging it as SYNC_FAILED filled the audit trail and the
  // dashboard's recent activity with red rows for ordinary validation errors.
  it.each([
    ['409', new ConflictException('already revoked')],
    ['400-family', new ConflictException('bad input')],
  ])('does not record a SYNC_FAILED row for a %s client error', async (_label, error) => {
    await new Promise<void>((resolve) => {
      interceptor
        .intercept(contextFor('PATCH'), { handle: () => throwError(() => error) })
        .subscribe({ error: () => { resolve(); } });
    });
    await flushSetImmediate();

    expect(record).not.toHaveBeenCalled();
  });

  it('still records SYNC_FAILED when the gateway itself fails (5xx)', async () => {
    await new Promise<void>((resolve) => {
      interceptor
        .intercept(contextFor('PATCH'), { handle: () => throwError(() => new BadGatewayException('gateway down')) })
        .subscribe({ error: () => { resolve(); } });
    });
    await flushSetImmediate();

    expect(record).toHaveBeenCalledWith(expect.objectContaining({ action: 'SYNC_FAILED' }));
  });

  it('ignores read-only methods entirely', async () => {
    await new Promise<void>((resolve) => {
      interceptor.intercept(contextFor('GET'), { handle: () => of('ok') }).subscribe({ complete: () => { resolve(); } });
    });
    await flushSetImmediate();

    expect(record).not.toHaveBeenCalled();
  });

  // A9(b): rows read "keys / UPDATED" with nothing identifying the row that changed.
  describe('resourceId in details', () => {
    it.each([['PATCH'], ['PUT'], ['DELETE'], ['POST']])(
      'takes the route id for a %s',
      async (method) => {
        await run(interceptor, contextFor(method, { id: 'key-7' }), of({}));

        expect(recorded(record).details).toMatchObject({ resourceId: 'key-7' });
      },
    );

    it('falls back to the created entity’s id for a POST with no route id', async () => {
      await run(interceptor, contextFor('POST'), of({ id: 'key-new' }));

      expect(recorded(record).details).toMatchObject({ resourceId: 'key-new' });
    });

    it('omits resourceId when neither is available', async () => {
      await run(interceptor, contextFor('POST'), of('ok'));

      expect(recorded(record).details).not.toHaveProperty('resourceId');
    });

    it('still redacts the request body it records', async () => {
      await run(interceptor, contextFor('PATCH', { id: 'key-7' }), of({}));

      expect(recorded(record).details).toMatchObject({ requestBody: {} });
    });

    it('L8: survives a deeply nested body (no stack overflow) and cuts it at the depth guard', async () => {
      let deep: Record<string, unknown> = { password: 'hunter2' };
      for (let i = 0; i < 20_000; i += 1) deep = { not: deep };
      await run(interceptor, contextFor('PATCH', { id: 'api-1' }, '/api/apis', deep), of({}));
      const stored = JSON.stringify(recorded(record).details);
      expect(stored).toContain('[TRUNCATED]');
      expect(stored).not.toContain('hunter2');
    });

    it('L8: truncates a large body and marks it', async () => {
      const big = { set: { mock: { code: 200, body: 'x'.repeat(100_000) } }, apiKey: 'k' };
      await run(interceptor, contextFor('PATCH', { id: 'api-1' }, '/api/apis', big), of({}));
      const { requestBody } = recorded(record).details as { requestBody: { truncated: boolean; bytes: number; preview: string } };
      expect(requestBody.truncated).toBe(true);
      expect(requestBody.bytes).toBeGreaterThan(100_000);
      expect(requestBody.preview.length).toBeLessThanOrEqual(16_384);
      expect(requestBody.preview).not.toContain('"k"');
    });

    // OAS-08 C1: `redact()` matched key names only, so a spec URL's secret was stored in clear.
    it('strips userinfo, query and fragment from any http(s) URL value in a PUT body', async () => {
      const body = {
        url: 'https://user:pw@specs.example.com:8443/v1/openapi.json?token=s3cr3t-tok&x=1#frag',
        intervalMinutes: 60,
        nested: [{ proxyUrl: 'http://backend.example.com/base?apiKey=nested-secret' }],
        note: 'not a url ?token=kept-because-not-a-url',
      };
      await run(interceptor, contextFor('PUT', { id: 'api-1' }, '/api/apis/api-1', body), of({}));

      const stored = JSON.stringify(recorded(record).details);
      expect(stored).not.toContain('s3cr3t-tok');
      expect(stored).not.toContain('nested-secret');
      expect(stored).not.toContain('user:pw');
      expect(stored).not.toContain('frag');
      expect(recorded(record).details).toMatchObject({
        requestBody: {
          url: 'https://specs.example.com:8443/v1/openapi.json',
          intervalMinutes: 60,
          nested: [{ proxyUrl: 'http://backend.example.com/base' }],
          note: 'not a url ?token=kept-because-not-a-url',
        },
      });
    });

    // Review H1: `new URL()` (and so the fetcher) accepts these spellings; a `^https?://` test did not.
    const SPELLINGS: [string, string][] = [
      ['leading space', ' https://h.example/x?token=S1'],
      ['leading tab', '\thttps://h.example/x?token=S2'],
      ['no slashes', 'https:h.example/x?token=S3'],
      ['backslashes', 'https:\\\\h.example\\x?token=S4'],
      ['upper-case scheme', 'HTTPS://h.example/x?token=S5'],
      ['tab inside the scheme', 'ht\ttps://h.example/x?token=S6'],
    ];

    it.each(SPELLINGS)('redacts a URL spelt with a %s (not the spec-source route: path kept)', async (_label, url) => {
      await run(interceptor, contextFor('PATCH', { id: 'api-1' }, '/api/apis/api-1', { proxyUrl: url }), of({}));

      const stored = JSON.stringify(recorded(record).details);
      expect(stored).not.toMatch(/token|S[1-6]/);
      expect(recorded(record).details).toMatchObject({ requestBody: { proxyUrl: 'https://h.example/x' } });
    });

    it.each(SPELLINGS)('redacts a %s URL embedded in a longer string', async (_label, url) => {
      await run(interceptor, contextFor('PATCH', { id: 'api-1' }, '/api/apis/api-1', { note: `see ${url} for details` }), of({}));

      expect(JSON.stringify(recorded(record).details)).not.toMatch(/token|S[1-6]/);
    });

    it.each(SPELLINGS)('PUT spec-source stores only the origin of a %s URL (a path can carry the secret)', async (_label, url) => {
      await run(interceptor, contextFor('PUT', { id: 'api-1' }, '/api/apis/api-1/spec-source', { url, intervalMinutes: 60 }), of({}));

      expect(recorded(record).details).toMatchObject({ requestBody: { url: 'https://h.example/…', intervalMinutes: 60 } });
    });

    // Express routes a trailing slash and any letter case to the same handler: the mode must follow.
    it.each([
      ['/api/apis/api-1/spec-source/'],
      ['/api/apis/api-1/SPEC-SOURCE'],
      ['/api/apis/api-1/Spec-Source/'],
    ])('origin only on %s too', async (path) => {
      await run(interceptor, contextFor('PUT', { id: 'api-1' }, path, { url: 'https://h.example/t0ken-in-path/spec.json' }), of({}));

      expect(JSON.stringify(recorded(record).details)).not.toContain('t0ken-in-path');
    });

    it('PUT spec-source: a secret in the PATH is not stored', async () => {
      await run(interceptor, contextFor('PUT', { id: 'api-1' }, '/api/apis/api-1/spec-source', { url: 'https://h.example/t0ken-in-path/spec.json' }), of({}));

      expect(JSON.stringify(recorded(record).details)).not.toContain('t0ken-in-path');
    });

    it.each(SPELLINGS)('never stores a %s URL from a 5xx error message', async (_label, url) => {
      await run(interceptor, contextFor('PUT', { id: 'api-1' }, '/api/apis/api-1', {}), throwError(() => new BadGatewayException(`fetch of ${url} failed`)));

      const stored = JSON.stringify(recorded(record).details);
      expect(stored).not.toMatch(/token|S[1-6]|h\.example/);
    });

    it('never stores a URL from a 5xx error message', async () => {
      const error = new BadGatewayException('fetch of https://specs.example.com/openapi.json?token=err-secret failed');
      await run(interceptor, contextFor('PUT', { id: 'api-1' }, '/api/apis/api-1/spec-source', {}), throwError(() => error));

      const stored = JSON.stringify(recorded(record).details);
      expect(stored).not.toContain('err-secret');
      expect(stored).not.toContain('specs.example.com');
      expect(stored).toContain('[URL]');
    });
  });
});

// A9(a): POST /apis/:id/sync is decorated @Audit('api:sync_succeeded') and answers 200 even when the
// sync failed, so every failed sync was recorded as SYNC_SUCCEEDED.
describe('AuditLogInterceptor sync outcome', () => {
  beforeAll(() => {
    Logger.overrideLogger(false);
  });

  const record = jest.fn((_entry: AuditEntry) => Promise.resolve());
  const audit = { record } as unknown as AuditService;
  const syncReflector = { get: () => ({ action: 'api:sync_succeeded' }) } as unknown as Reflector;
  const interceptor = new AuditLogInterceptor(audit, syncReflector);
  const syncContext = () => contextFor('POST', { id: 'api-1' }, '/api/apis/api-1/sync');

  beforeEach(() => {
    record.mockClear();
  });

  it('records SYNC_FAILED with the error when the body reports a failed sync', async () => {
    await run(interceptor, syncContext(), of({ id: 'api-1', syncStatus: 'FAILED', syncError: 'tyk down' }));

    const entry = recorded(record);
    expect(entry.action).toBe('SYNC_FAILED');
    expect(entry.resource).toBe('apis');
    expect(entry.details).toMatchObject({ resourceId: 'api-1', syncError: 'tyk down' });
  });

  it('records SYNC_SUCCEEDED when the sync really succeeded', async () => {
    await run(interceptor, syncContext(), of({ id: 'api-1', syncStatus: 'SYNCED' }));

    expect(recorded(record).action).toBe('SYNC_SUCCEEDED');
  });

  it('records a null syncError when the body reports a failure without one', async () => {
    await run(interceptor, syncContext(), of({ syncStatus: 'FAILED' }));

    const entry = recorded(record);
    expect(entry.action).toBe('SYNC_FAILED');
    expect(entry.details).toMatchObject({ syncError: null });
  });
});
