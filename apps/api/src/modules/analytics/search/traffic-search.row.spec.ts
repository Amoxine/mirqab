import { isStorable } from '../text-safety';
import {
  buildSearchRow,
  MULTIPART_PLACEHOLDER,
  OPAQUE_BODY_PLACEHOLDER,
  UNREDACTABLE_BODY_PLACEHOLDER,
  type CapturedRow,
} from './traffic-search.row';

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

/** A row's every text, header names and values included: each of them goes into one `unnest` insert. */
const allText = (row: ReturnType<typeof buildSearchRow>): string[] => [
  row.apiid,
  row.method,
  row.path,
  row.keyAlias,
  row.ip,
  row.reqBody,
  row.resBody,
  ...Object.entries(row.reqHeaders).flat(),
  ...Object.entries(row.resHeaders).flat(),
];
const everythingStorable = (row: ReturnType<typeof buildSearchRow>): boolean =>
  allText(row).every(isStorable) && isStorable(JSON.stringify(row.reqHeaders)) && isStorable(JSON.stringify(row.resHeaders));

describe('buildSearchRow: nothing Postgres would refuse', () => {
  const EMOJI = '😀';

  it('a header value cut at 1000 in the middle of an emoji is still well formed (the poison pill)', () => {
    const row = buildSearchRow({ ...base, rawrequest: req([`X-Cut: ${'v'.repeat(999)}${EMOJI}`], '{}') }, null);
    expect(row.reqHeaders['x-cut']).toHaveLength(1000);
    expect(everythingStorable(row)).toBe(true);
    expect(JSON.stringify(row.reqHeaders)).not.toMatch(/\\ud[89ab][0-9a-f]{2}/i);
  });

  it('a header name cut at 100 in the middle of an emoji is still well formed', () => {
    const row = buildSearchRow({ ...base, rawresponse: res([`${'n'.repeat(99)}${EMOJI}: x`], 'ok') }, null);
    const [name] = Object.keys(row.resHeaders);
    expect(name).toHaveLength(100);
    expect(everythingStorable(row)).toBe(true);
  });

  it('a body cut at 16384 in the middle of an emoji is still well formed', () => {
    const row = buildSearchRow(
      { ...base, rawrequest: req(['Content-Type: application/json'], `${'a'.repeat(16383)}${EMOJI}`), rawresponse: res(['Content-Type: application/json'], `${'b'.repeat(16383)}${EMOJI}`) },
      null,
    );
    expect(row.reqBody).toHaveLength(16384);
    expect(row.reqTruncated).toBe(true);
    expect(everythingStorable(row)).toBe(true);
  });

  it('no column keeps a NUL, wherever it was', () => {
    const row = buildSearchRow(
      {
        ...base,
        alias: 'qbus\u0000web',
        path: '/or\u0000ders',
        method: 'PO\u0000ST',
        ipaddress: '10.0\u0000.0.7',
        rawrequest: req(['X-A: a\u0000b', 'Content-Type: application/json'], '{"k":"v\u0000v"}'),
      },
      null,
    );
    expect(everythingStorable(row)).toBe(true);
    expect(row).toMatchObject({ keyAlias: 'qbusweb', path: '/orders', method: 'POST', ip: '10.0.0.7' });
    expect(row.reqHeaders['x-a']).toBe('ab');
    expect(row.reqBody).toBe('{"k":"vv"}');
  });

  it('a lone surrogate in a scalar column is replaced, not passed on', () => {
    const row = buildSearchRow({ ...base, alias: `k\uD83D`, path: `/p\uDE00` }, null);
    expect(everythingStorable(row)).toBe(true);
  });
});

describe('buildSearchRow: bodies whose structure the redaction cannot read are not indexed', () => {
  const planted = (type: string, body: string) =>
    buildSearchRow({ ...base, rawrequest: req([`Content-Type: ${type}`], body), rawresponse: res([`Content-Type: ${type}`], body) }, null);

  it.each([
    ['newline-separated key=value', 'text/plain', 'user=bob\npassword=PLANTED-NL-PW\nnote=hi'],
    ['space-separated pairs', 'text/plain', 'user=bob password=PLANTED-SP-PW'],
    ['an XML element', 'application/xml', '<user><Password>PLANTED-XML-PW</Password></user>'],
    ['XML under text/xml', 'text/xml', '<token>PLANTED-TEXTXML</token>'],
    ['a YAML line', 'application/yaml', 'password: PLANTED-YAML-PW\nname: bob'],
    ['HTML', 'text/html', '<p>password: PLANTED-HTML-PW</p>'],
    ['JSON sent as text/plain', 'text/plain', '{"password":"PLANTED-JSON-IN-TEXT"}'],
    ['an unknown type', 'application/octet-stream', 'password=PLANTED-OCTET'],
  ])('%s: the body is a placeholder on both sides, and the secret is in no column', (_name, type, body) => {
    const row = planted(type, body);
    expect(row.reqBody).toBe(OPAQUE_BODY_PLACEHOLDER);
    expect(row.resBody).toBe(OPAQUE_BODY_PLACEHOLDER);
    expect(JSON.stringify(row)).not.toMatch(/PLANTED/);
  });

  it.each([
    ['JSON', 'application/json'],
    ['JSON with a charset', 'application/json; charset=utf-8'],
    ['a +json type', 'application/vnd.api+json'],
    ['upper-case JSON', 'Application/JSON'],
    ['newline-delimited JSON', 'application/x-ndjson'],
    ['a form', 'application/x-www-form-urlencoded'],
  ])('%s stays searchable, with its secrets redacted by name', (_name, type) => {
    const row = planted(type, type.includes('form') ? 'user=bob&password=PLANTED-FORM&note=visible' : '{"password":"PLANTED-JSON","note":"visible"}');
    expect(row.reqBody).toContain('visible');
    expect(JSON.stringify(row)).not.toMatch(/PLANTED/);
  });

  it('with no Content-Type, a JSON-looking body is kept and anything else is not', () => {
    const json = buildSearchRow({ ...base, rawrequest: b64('POST / HTTP/1.1\r\n\r\n  {"password":"PLANTED-NOCT","note":"visible"}') }, null);
    expect(json.reqBody).toContain('visible');
    expect(JSON.stringify(json)).not.toMatch(/PLANTED/);
    const text = buildSearchRow({ ...base, rawrequest: b64('POST / HTTP/1.1\r\n\r\nuser=bob password=PLANTED-NOCT2') }, null);
    expect(text.reqBody).toBe(OPAQUE_BODY_PLACEHOLDER);
    expect(JSON.stringify(text)).not.toMatch(/PLANTED/);
  });

  it('an empty body stays empty whatever its type, so there is nothing to hide behind a placeholder', () => {
    const row = planted('text/plain', '');
    expect(row.reqBody).toBe('');
    expect(row.resBody).toBe('');
  });

  it('the multipart placeholder is unchanged', () => {
    expect(planted('multipart/form-data; boundary=x', 'PLANTED-MP').reqBody).toBe(MULTIPART_PLACEHOLDER);
  });
});

describe('buildSearchRow: a capture that could not be redacted is shown as such', () => {
  const unredactable = b64('[UNREDACTABLE: non-UTF8 body]');

  it('keeps a visible placeholder as the body and flags the row, so a negated header clause can skip it', () => {
    const row = buildSearchRow({ ...base, rawrequest: unredactable, rawresponse: res(['Content-Type: application/json'], '{"ok":true}') }, null);
    expect(row.unredactable).toBe(true);
    expect(row.reqBody).toBe(UNREDACTABLE_BODY_PLACEHOLDER);
    expect(row.reqHeaders).toEqual({});
    expect(row.resBody).toBe('{"ok":true}'); // the other side was readable
  });

  it('an unredactable response flags the row as well', () => {
    const row = buildSearchRow({ ...base, rawrequest: req([], '{}'), rawresponse: unredactable }, null);
    expect(row.unredactable).toBe(true);
    expect(row.resBody).toBe(UNREDACTABLE_BODY_PLACEHOLDER);
  });

  it('an ordinary row, and an empty capture, are not flagged', () => {
    expect(buildSearchRow({ ...base, rawrequest: req([], '{}'), rawresponse: res([], '{}') }, null).unredactable).toBe(false);
    expect(buildSearchRow(base, null).unredactable).toBe(false);
  });
});

describe('buildSearchRow: the path column', () => {
  it('hides a secret parameter in the path as well as a JWT, as defence in depth', () => {
    const row = buildSearchRow({ ...base, path: '/orders?access_token=PLANTED-PATH-TOKEN&page=2' }, null);
    expect(row.path).toBe('/orders?access_token=[REDACTED]&page=2');
    expect(JSON.stringify(row)).not.toMatch(/PLANTED/);
  });

  it('leaves an ordinary path as it was', () => {
    expect(buildSearchRow({ ...base, path: '/orders/42/items' }, null).path).toBe('/orders/42/items');
  });
});
