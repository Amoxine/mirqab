import { buildSearchRow, MULTIPART_PLACEHOLDER, type CapturedRow } from './traffic-search.row';

const b64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64');

const base: CapturedRow = {
  ts_iso: '2026-09-29T10:06:17.159317Z',
  apiid: 'tyk-a',
  apikey: 'hash1',
  alias: 'qbus-web',
  ipaddress: '10.0.0.7',
  method: 'POST',
  path: '/orders',
  responsecode: 402n,
  latency_total: 340n,
  rawrequest: null,
  rawresponse: null,
  dedupe_key: 'd'.repeat(64),
};

const req = (headers: string[], body: string) =>
  b64(['POST /orders?access_token=QS-SECRET HTTP/1.1', 'Host: gw', ...headers, '', body].join('\r\n'));
const res = (headers: string[], body: string) => b64(['HTTP/1.1 402 Payment Required', ...headers, '', body].join('\r\n'));

describe('buildSearchRow', () => {
  it('copies the scalar columns, turning bigint and NULL into numbers and empty strings', () => {
    const row = buildSearchRow({ ...base, alias: null, ipaddress: null, method: null, path: null, responsecode: null, latency_total: null }, null);
    expect(row).toMatchObject({ ts: base.ts_iso, apiid: 'tyk-a', method: '', path: '', status: 0, latencyMs: 0, keyAlias: '', ip: '', dedupeKey: base.dedupe_key });
    expect(buildSearchRow(base, null)).toMatchObject({ status: 402, latencyMs: 340, keyAlias: 'qbus-web', ip: '10.0.0.7' });
  });

  it('hides a JWT in the path column, which never goes through the dump parser', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJQTEFOVEVEIn0.c2lnbmF0dXJlLXZhbHVl';
    expect(buildSearchRow({ ...base, path: `/verify/${jwt}/done` }, null).path).toBe('/verify/[REDACTED]/done');
  });

  it('keeps the microseconds of the timestamp, as text', () => {
    expect(buildSearchRow(base, null).ts).toBe('2026-09-29T10:06:17.159317Z');
  });

  it('lower-cases header names and keeps values, for header: clauses', () => {
    const row = buildSearchRow({ ...base, rawrequest: req(['X-Request-Id: abc-123', 'Content-Type: application/json'], '{}') }, null);
    expect(row.reqHeaders).toMatchObject({ 'x-request-id': 'abc-123', 'content-type': 'application/json' });
    expect(Object.keys(row.reqHeaders).every((k) => k === k.toLowerCase())).toBe(true);
  });

  it('bounds a huge header value and a huge header name', () => {
    const row = buildSearchRow({ ...base, rawresponse: res([`X-Big: ${'v'.repeat(5000)}`, `${'N'.repeat(300)}: x`], 'ok') }, null);
    expect(row.resHeaders['x-big']).toHaveLength(1000);
    expect(Object.keys(row.resHeaders).every((k) => k.length <= 100)).toBe(true);
  });

  it('stores a header called __proto__ as data, not as a prototype', () => {
    const row = buildSearchRow({ ...base, rawrequest: req(['__proto__: polluted'], '{}') }, null);
    expect(Object.getPrototypeOf(row.reqHeaders)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('flags a body the parser had to cut, per side', () => {
    const cut = b64('POST / HTTP/1.1\r\n\r\n{"a":1}\n[TRUNCATED: capture cut at 16384 characters before redaction]');
    const row = buildSearchRow({ ...base, rawrequest: cut, rawresponse: res([], 'fine') }, null);
    expect(row.reqTruncated).toBe(true);
    expect(row.resTruncated).toBe(false);
  });

  it('indexes a multipart body as a fixed placeholder, whichever side it is on', () => {
    const multipart = ['Content-Type: multipart/form-data; boundary=xyz'];
    const row = buildSearchRow(
      { ...base, rawrequest: req(multipart, '--xyz\r\nContent-Disposition: form-data; name="f"\r\n\r\nPLANTED-MULTIPART-SECRET\r\n--xyz--'), rawresponse: res(multipart, 'PLANTED-RES-MULTIPART') },
      null,
    );
    expect(row.reqBody).toBe(MULTIPART_PLACEHOLDER);
    expect(row.resBody).toBe(MULTIPART_PLACEHOLDER);
    expect(JSON.stringify(row)).not.toMatch(/PLANTED/);
  });

  it('an empty capture on one side gives an empty side, not a failure', () => {
    const row = buildSearchRow({ ...base, rawrequest: req([], '{"a":1}'), rawresponse: null }, null);
    expect(row.resHeaders).toEqual({});
    expect(row.resBody).toBe('');
    expect(row.reqBody).toBe('{"a":1}');
  });

  /**
   * The leak oracle: everything the parser redacts on screen must also be absent from every column of
   * the row, because every column is searchable. Planted values are unique strings that appear nowhere
   * else, so a single hit means a leak.
   */
  describe('planted secrets are in no column', () => {
    const SECRETS = ['PLANTED-BEARER', 'PLANTED-COOKIE', 'PLANTED-PASSWORD', 'PLANTED-NESTED-SID', 'PLANTED-TENANT-HDR', 'PLANTED-QS-TOKEN', 'PLANTED-RES-TOKEN', 'PLANTED-SETCOOKIE'];
    const row = buildSearchRow(
      {
        ...base,
        rawrequest: b64(
          [
            'POST /orders?access_token=PLANTED-QS-TOKEN&page=2 HTTP/1.1',
            'Host: gw',
            'Authorization: Bearer PLANTED-BEARER',
            'Cookie: sid=PLANTED-COOKIE',
            'X-Tenant-Ref: PLANTED-TENANT-HDR',
            'Content-Type: application/json',
            '',
            '{"user":"bob","password":"PLANTED-PASSWORD","keep":"visible"}',
          ].join('\r\n'),
        ),
        rawresponse: res(['Set-Cookie: s=PLANTED-SETCOOKIE', 'Content-Type: application/json'], '{"cookies":{"sid":"PLANTED-NESTED-SID"},"refresh_token":"PLANTED-RES-TOKEN","ok":true}'),
      },
      'X-Tenant-Ref',
    );
    const everything = JSON.stringify(row);

    it.each(SECRETS)('%s is not in any column', (secret) => {
      expect(everything).not.toContain(secret);
    });

    it('negative control: without the API\'s auth header name, a header that matches no secret pattern WOULD leak', () => {
      const unaware = buildSearchRow(
        { ...base, rawrequest: b64(['GET / HTTP/1.1', 'X-Tenant-Ref: PLANTED-TENANT-HDR', '', ''].join('\r\n')) },
        null,
      );
      expect(JSON.stringify(unaware)).toContain('PLANTED-TENANT-HDR');
    });

    it('still keeps what is not secret, so the row is useful', () => {
      expect(row.reqBody).toContain('"keep":"visible"');
      expect(row.resBody).toContain('"ok":true');
      expect(row.reqHeaders['content-type']).toBe('application/json');
    });

    it('keeps the header names of redacted headers, so header: can ask whether one was sent', () => {
      expect(row.reqHeaders.authorization).toBe('[REDACTED]');
      expect(row.reqHeaders['x-tenant-ref']).toBe('[REDACTED]');
    });
  });
});
