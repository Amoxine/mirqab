import { MAX_BODY_CHARS, parseHttpDump } from './http-dump-parser';
import { TRUNCATED_DUMP_MARKER } from './pump-query.builder';

const b64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64');

/** Postgres `encode(..., 'base64')` (what the trigger writes back) wraps every 76 characters. */
const pgB64 = (text: string): string => b64(text).replace(/(.{76})/g, '$1\n');

/**
 * A request as it sits in `tyk_analytics.rawrequest` AFTER the insert trigger ran: `Authorization`
 * is already `[REDACTED]` (on the trigger's fixed list), but the API's own configured auth header
 * (`X-Tenant-Key`, not on that list) and the query-string token are still there.
 */
const TRIGGER_OUTPUT_REQUEST = [
  'GET /orders?access_token=qs-secret-456&page=2 HTTP/1.1',
  'Host: gateway.local',
  'Authorization: [REDACTED]',
  'X-Tenant-Key: tenant-key-abc123',
  'Referer: https://app.example/cb?code=oauth-code-789&lang=en',
  'Content-Type: application/json',
  '',
  '{"orderId":42}',
].join('\r\n');

describe('parseHttpDump', () => {
  describe('second-layer redaction (AC-LOG02.2)', () => {
    it('the trigger alone leaves the tenant auth header and the query-string secret in place', () => {
      // The gap this parser exists for: without the second layer, both secrets reach the browser.
      const triggerOnly = Buffer.from(pgB64(TRIGGER_OUTPUT_REQUEST), 'base64').toString('utf8');
      expect(triggerOnly).toContain('tenant-key-abc123');
      expect(triggerOnly).toContain('qs-secret-456');
    });

    it('strips the API’s own auth header and query-string secrets from the trigger output', () => {
      const parsed = parseHttpDump(pgB64(TRIGGER_OUTPUT_REQUEST), { authHeaderName: 'X-Tenant-Key' });
      const shown = JSON.stringify(parsed);

      expect(shown).not.toContain('tenant-key-abc123');
      expect(shown).not.toContain('qs-secret-456');
      expect(shown).not.toContain('oauth-code-789');
      expect(parsed?.headers['X-Tenant-Key']).toBe('[REDACTED]');
      expect(parsed?.startLine).toBe('GET /orders?access_token=[REDACTED]&page=2 HTTP/1.1');
    });

    it('keeps what is not a secret', () => {
      const parsed = parseHttpDump(b64(TRIGGER_OUTPUT_REQUEST), { authHeaderName: 'X-Tenant-Key' });

      expect(parsed?.headers.Host).toBe('gateway.local');
      expect(parsed?.headers['Content-Type']).toBe('application/json');
      expect(parsed?.headers.Referer).toBe('https://app.example/cb?code=[REDACTED]&lang=en');
      expect(parsed?.body).toBe('{"orderId":42}');
    });

    it('matches the auth header name case-insensitively', () => {
      const parsed = parseHttpDump(b64(TRIGGER_OUTPUT_REQUEST), { authHeaderName: 'x-tenant-key' });
      expect(parsed?.headers['X-Tenant-Key']).toBe('[REDACTED]');
    });

    it('still redacts credential headers if the trigger never ran (its install only warns on failure)', () => {
      const unredacted = [
        'GET / HTTP/1.1',
        'Authorization: Bearer live-token',
        'Cookie: sid=live-cookie',
        'X-Api-Key: live-api-key',
        '',
        '',
      ].join('\r\n');
      const shown = JSON.stringify(parseHttpDump(b64(unredacted)));

      expect(shown).not.toContain('live-token');
      expect(shown).not.toContain('live-cookie');
      expect(shown).not.toContain('live-api-key');
    });

    it.each([
      ['api_key', 'GET /x?api_key=S1 HTTP/1.1'],
      ['apiKey', 'GET /x?apiKey=S1 HTTP/1.1'],
      ['key', 'GET /x?key=S1 HTTP/1.1'],
      ['client_secret', 'GET /x?a=1&client_secret=S1 HTTP/1.1'],
      ['password', 'GET /x?password=S1 HTTP/1.1'],
      ['sig', 'GET /x?sig=S1 HTTP/1.1'],
      ['url-encoded name', 'GET /x?access%5Ftoken=S1 HTTP/1.1'],
      ['base64 value with padding', 'GET /x?token=S1S1== HTTP/1.1'],
    ])('redacts a %s query parameter', (_label, requestLine) => {
      const parsed = parseHttpDump(b64(`${requestLine}\r\nHost: h\r\n\r\n`));
      expect(parsed?.startLine).not.toContain('S1');
      expect(parsed?.startLine).toContain('=[REDACTED]');
    });

    it('does not redact look-alike names that are not secrets', () => {
      const parsed = parseHttpDump(b64('GET /x?author=bob&monkey=1&keyword=k HTTP/1.1\r\n\r\n'));
      expect(parsed?.startLine).toBe('GET /x?author=bob&monkey=1&keyword=k HTTP/1.1');
    });
  });

  describe('secrets by name pattern (security review of T4)', () => {
    const shown = (dump: string, authHeaderName?: string): string =>
      JSON.stringify(parseHttpDump(b64(dump), { authHeaderName }));

    it.each([
      ['request', 'POST /token HTTP/1.1\r\nContent-Type: application/json\r\n\r\n'],
      ['response', 'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n'],
    ])('redacts JSON keys by pattern, camelCase and snake_case, in a %s body', (_kind, head) => {
      const out = shown(
        `${head}{"access_token":"AT-1","refresh_token":"RT-1","client_secret":"CS-1","newPassword":"NP-1",` +
          `"apiKey":"AK-1","private_key":"PK-1","Authorization":"AZ-1","nested":{"idToken":"IT-1"}}`,
      );
      for (const leaked of ['AT-1', 'RT-1', 'CS-1', 'NP-1', 'AK-1', 'PK-1', 'AZ-1', 'IT-1']) {
        expect(out).not.toContain(leaked);
      }
    });

    it('consumes escaped quotes, so the tail of a secret value cannot leak', () => {
      const out = shown('HTTP/1.1 200 OK\r\n\r\n{"token":"ab\\"TAIL","ok":"yes"}');
      expect(out).not.toContain('TAIL');
      expect(out).toContain('yes');
    });

    it.each([
      // Verbatim from the real trigger on PG16: its `"[^"]*"` stops at the escaped quote, so the rest
      // of the value lands after `"[REDACTED]"`, outside any JSON string.
      ['one escaped quote', '{"token":"[REDACTED]"TAIL-1","name":"widget"}'],
      ['several escaped quotes', '{"token":"[REDACTED]"b\\"TAIL-2\\"c","name":"widget"}'],
      ['cut off by the clip', '{"name":"widget","token":"[REDACTED]"TAIL-3'],
    ])('removes the tail the trigger leaves after an escaped quote (%s)', (_label, stored) => {
      const out = shown(`HTTP/1.1 200 OK\r\n\r\n${stored}`);
      expect(out).not.toMatch(/TAIL-\d/);
      expect(out).toContain('widget');
    });

    it('redacts a numeric secret value, not only strings', () => {
      expect(shown('HTTP/1.1 200 OK\r\n\r\n{"pin":1234,"passphrase":"PP-1"}')).not.toMatch(/1234|PP-1/);
    });

    describe('JWT-shaped values, found by value', () => {
      const JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
      const shown = (head: string, body = '') => JSON.stringify(parseHttpDump(b64(`${head}\r\n\r\n${body}`)));

      it('hides a token in a JSON field whose name looks harmless', () => {
        expect(shown('HTTP/1.1 200 OK', `{"payload":"${JWT}","keep":"visible"}`)).not.toContain('eyJ');
        expect(shown('HTTP/1.1 200 OK', `{"payload":"${JWT}","keep":"visible"}`)).toContain('visible');
      });

      it('hides it in a header with an innocent name, a query parameter, a path and a form body', () => {
        expect(shown(`GET /callback/${JWT}?data=${JWT} HTTP/1.1\r\nX-Trace: ${JWT}\r\nReferer: https://a/?x=${JWT}`)).not.toContain('eyJ');
        expect(shown('POST /x HTTP/1.1', `note=${JWT}&keep=visible`)).not.toContain('eyJ');
      });

      it('hides an unsecured token (empty signature) and leaves ordinary base64 alone', () => {
        expect(shown('HTTP/1.1 200 OK', 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJ4In0.')).not.toContain('eyJ');
        expect(shown('HTTP/1.1 200 OK', '{"img":"iVBORw0KGgoAAAANSUhEUgAA","v":"eyJ"}')).toContain('iVBORw0KGgoAAAANSUhEUgAA');
      });

      it('stays linear on a body of repeated eyJ', () => {
        const hostile = 'eyJ'.repeat(5_000);
        const start = performance.now();
        shown('HTTP/1.1 200 OK', hostile);
        shown('HTTP/1.1 200 OK', 'eyJabcd.'.repeat(2_000));
        expect(performance.now() - start).toBeLessThan(400);
      });
    });

    describe('a secret-named key holding an object or array', () => {
      const body = (json: string) => parseHttpDump(b64(`HTTP/1.1 200 OK\r\n\r\n${json}`))?.body ?? '';

      it('redacts the whole container, not only inner keys that look secret (an upstream echoing cookies)', () => {
        const out = body('{"id":1,"cookies":{"sid":"SECRETCOOKIE77bd","theme":"dark"},"ok":true}');
        expect(out).not.toMatch(/SECRETCOOKIE77bd|dark/);
        expect(out).toBe('{"id":1,"cookies":"[REDACTED]","ok":true}');
      });

      it('handles arrays, deep nesting and brackets inside strings', () => {
        const out = body('{"credentials":[{"a":{"b":["}","]","x\\"}]"]}}],"after":"kept","session":{"n":{"m":"DEEP"}}}');
        expect(out).not.toMatch(/DEEP|"a"/);
        expect(out).toBe('{"credentials":"[REDACTED]","after":"kept","session":"[REDACTED]"}');
      });

      it('redacts to the end when the clip cut the container open', () => {
        expect(body('{"id":1,"cookies":{"sid":"CUT-COOK')).not.toContain('CUT-COOK');
      });

      it('leaves a container under a harmless key readable, redacting only its secret fields', () => {
        expect(body('{"user":{"name":"bob","token":"T-1"}}')).toBe('{"user":{"name":"bob","token":"[REDACTED]"}}');
      });

      it('stays linear on 16 KB of nested brackets', () => {
        const start = performance.now();
        const out = body(`{"session":${'['.repeat(8_000)}${']'.repeat(8_000)},"k":1}`);
        expect(performance.now() - start).toBeLessThan(200);
        expect(out).toBe('{"session":"[REDACTED]","k":1}');
      });
    });

    it('redacts a secret value the column clip cut off mid-string', () => {
      const parsed = parseHttpDump(b64('HTTP/1.1 200 OK\r\n\r\n{"id":1,"password":"CUT-SEC'), { clipped: true });
      expect(JSON.stringify(parsed)).not.toContain('CUT-SEC');
    });

    it('redacts headers by name pattern, including a key header from before authHeaderName changed', () => {
      const out = shown(
        [
          'GET / HTTP/1.1',
          'X-Auth-Token: XAT-1',
          'X-Api-Key: XAK-1',
          'X-Old-Key: XOK-1',
          'Cookie: sid=CK-1',
          'Set-Cookie: sid=SC-1',
          'X-Hub-Signature: SIG-1',
          '',
          '',
        ].join('\r\n'),
        'X-New-Key',
      );
      for (const leaked of ['XAT-1', 'XAK-1', 'XOK-1', 'CK-1', 'SC-1', 'SIG-1']) expect(out).not.toContain(leaked);
    });

    it('redacts a token in a URL fragment (an OAuth implicit-flow redirect), keeping what is not secret', () => {
      const parsed = parseHttpDump(b64('HTTP/1.1 302 Found\r\nLocation: https://app/cb#access_token=OPAQUE-FRAG&state=s1\r\n\r\n'));
      expect(parsed?.headers.Location).toBe('https://app/cb#access_token=[REDACTED]&state=s1');
    });

    it('redacts authorization=, private_key= and key= query parameters', () => {
      const parsed = parseHttpDump(b64('GET /x?authorization=Q1&private_key=Q2&key=Q3&page=2 HTTP/1.1\r\n\r\n'));
      expect(parsed?.startLine).toBe(
        'GET /x?authorization=[REDACTED]&private_key=[REDACTED]&key=[REDACTED]&page=2 HTTP/1.1',
      );
    });

    it('redacts a form-encoded body (an OAuth token request) by the same pattern', () => {
      const out = shown(
        'POST /token HTTP/1.1\r\nContent-Type: application/x-www-form-urlencoded\r\n\r\n' +
          'grant_type=authorization_code&code=FC-1&client_secret=FS-1&redirect_uri=https%3A%2F%2Fapp',
      );
      expect(out).not.toMatch(/FC-1|FS-1/);
      expect(out).toContain('grant_type=authorization_code');
    });

    it('leaves clearly harmless fields alone', () => {
      const parsed = parseHttpDump(
        b64(
          'GET /items?page=2&name=widget&status=active&author=bob&keyword=k HTTP/1.1\r\n' +
            'Content-Type: application/json\r\nX-Request-Id: r-1\r\n\r\n' +
            '{"name":"widget","status":"active","page":2,"code":"E_NOT_FOUND","author":"bob",' +
            '"passenger":"p","className":"c","monkey":"m","keyword":"k"}',
        ),
      );

      expect(parsed?.startLine).toBe('GET /items?page=2&name=widget&status=active&author=bob&keyword=k HTTP/1.1');
      expect(parsed?.headers).toEqual({ 'Content-Type': 'application/json', 'X-Request-Id': 'r-1' });
      expect(parsed?.body).toBe(
        '{"name":"widget","status":"active","page":2,"code":"E_NOT_FOUND","author":"bob",' +
          '"passenger":"p","className":"c","monkey":"m","keyword":"k"}',
      );
    });
  });

  describe('stays linear on hostile bodies (ReDoS, codereview-v1)', () => {
    /** Budget per parse. Linear is single-digit ms here; the quadratic patterns took seconds to tens of seconds. */
    const BUDGET_MS = 200;
    const ESC = '\\"';

    /** Best of up to 3 runs, stopping at the first under budget: load can stall one run, a quadratic pattern stalls all. */
    function bestMs(run: () => void): number {
      let best = Infinity;
      for (let i = 0; i < 3 && best >= BUDGET_MS; i++) {
        const start = performance.now();
        run();
        best = Math.min(best, performance.now() - start);
      }
      return best;
    }

    it.each([
      ['48 KB of escaped quotes, unterminated', `{"token":"${ESC.repeat(24_000)}`, true],
      ['48 KB of escaped quotes, closed', `{"token":"${ESC.repeat(24_000)}"}`, true],
      ['16 KB of escaped quotes, closed', `{"token":"${ESC.repeat(8_000)}"}`, true],
      // `\` + newline: `\\.` cannot consume it (`.` skips newlines), which would restart the match inside the string.
      ['48 KB of escaped quotes, then a backslash-newline', `{"a":"${ESC.repeat(24_000)}\\\n"}`, false],
      ['a 48 KB trigger tail of escaped quotes', `{"token":"[REDACTED]"a${ESC.repeat(24_000)}\\\n`, true],
    ])('%s: parses in under the budget and still redacts', (_label, body, secret) => {
      const dump = b64(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n${body}`);
      let parsed: ReturnType<typeof parseHttpDump> = null;

      expect(bestMs(() => (parsed = parseHttpDump(dump)))).toBeLessThan(BUDGET_MS);
      if (secret) expect(parsed).toMatchObject({ body: '{"token":"[REDACTED]"' + (body.endsWith('"}') ? '}' : '') });
    });
  });

  describe('parsing', () => {
    it('splits a response dump into status line, headers and body', () => {
      const parsed = parseHttpDump(
        b64('HTTP/1.1 201 Created\r\nContent-Type: application/json\r\nSet-Cookie: s=1\r\n\r\n{"ok":true}'),
      );

      expect(parsed).toEqual({
        startLine: 'HTTP/1.1 201 Created',
        headers: { 'Content-Type': 'application/json', 'Set-Cookie': '[REDACTED]' },
        body: '{"ok":true}',
        truncated: false,
      });
    });

    it('joins repeated headers and treats a __proto__ header as a plain key', () => {
      const parsed = parseHttpDump(b64('HTTP/1.1 200 OK\r\nVia: a\r\nVia: b\r\n__proto__: x\r\n\r\n'));

      expect(parsed?.headers.Via).toBe('a, b');
      expect(Object.getOwnPropertyDescriptor(parsed?.headers, '__proto__')?.value).toBe('x');
      expect(Object.getPrototypeOf(parsed?.headers)).toBe(Object.prototype);
    });

    it('accepts bare LF line endings', () => {
      const parsed = parseHttpDump(b64('HTTP/1.1 200 OK\nContent-Type: text/plain\n\nhello'));
      expect(parsed).toMatchObject({ headers: { 'Content-Type': 'text/plain' }, body: 'hello' });
    });

    it('truncates a body over the bound and says so', () => {
      const parsed = parseHttpDump(b64(`HTTP/1.1 200 OK\r\n\r\n${'x'.repeat(MAX_BODY_CHARS + 10)}`));

      expect(parsed?.body).toHaveLength(MAX_BODY_CHARS);
      expect(parsed?.truncated).toBe(true);
    });

    it('a dump the trigger cut in the body: marker line dropped, truncated set', () => {
      const parsed = parseHttpDump(b64(`HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\nhello\n${TRUNCATED_DUMP_MARKER}`));
      expect(parsed).toMatchObject({ headers: { 'Content-Type': 'text/plain' }, body: 'hello', truncated: true });
    });

    it('a dump the trigger cut inside the headers: no bogus marker header, truncated set', () => {
      const parsed = parseHttpDump(b64(`GET / HTTP/1.1\r\nHost: h\r\nX-Big: aaa\n${TRUNCATED_DUMP_MARKER}`));
      expect(parsed).toEqual({ startLine: 'GET / HTTP/1.1', headers: { Host: 'h', 'X-Big': 'aaa' }, body: '', truncated: true });
    });

    it('marks a dump the query already clipped as truncated even when the body looks short', () => {
      expect(parseHttpDump(b64('HTTP/1.1 200 OK\r\n\r\nshort'), { clipped: true })?.truncated).toBe(true);
    });
  });

  describe('malformed input never throws', () => {
    it.each([null, undefined, ''])('returns null for %p (nothing captured)', (input) => {
      expect(parseHttpDump(input)).toBeNull();
    });

    it('returns null for a non-string value', () => {
      expect(parseHttpDump(42 as unknown as string)).toBeNull();
    });

    it.each([
      ['not base64 at all', '%%%not-base64%%%'],
      ['a truncated base64 quad', b64('GET /x?token=abc HTTP/1.1\r\nHost: h').slice(0, -3)],
      ['invalid UTF-8 bytes', Buffer.from([0xff, 0xfe, 0x00, 0xc3, 0x28]).toString('base64')],
      ['the trigger’s non-UTF8 placeholder', b64('[UNREDACTABLE: non-UTF8 body]')],
      ['a header line with no colon', b64('GET / HTTP/1.1\r\nnot a header\r\n: empty name\r\n\r\n')],
      ['a malformed percent escape in a parameter name', b64('GET /x?%E0%A4%A=1&token=abc HTTP/1.1\r\n\r\n')],
    ])('%s', (_label, input) => {
      expect(() => parseHttpDump(input, { authHeaderName: 'X-Key' })).not.toThrow();
      expect(JSON.stringify(parseHttpDump(input))).not.toContain('token=abc');
    });
  });
});
