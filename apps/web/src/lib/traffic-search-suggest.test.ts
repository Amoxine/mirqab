import { describe, expect, it } from 'vitest';
import enAnalytics from '@/messages/en/analytics.json';
import frAnalytics from '@/messages/fr/analytics.json';
import arAnalytics from '@/messages/ar/analytics.json';
import { SEARCH_FIELDS, parseToken, tokenize } from './traffic-search';
import {
  MAX_DYNAMIC_SUGGESTIONS,
  STATUS_VALUES,
  draftHint,
  suggest,
  valueField,
  type SuggestContext,
} from './traffic-search-suggest';

const ctx: SuggestContext = {
  fieldDescription: (field) => `about ${field}`,
  statusMeaning: (value) => `meaning of ${value}`,
  latencyOver: (ms) => `slower than ${String(ms)} ms`,
  apis: [
    { slug: 'payments', name: 'Payments API' },
    { slug: 'orders-api', name: 'Orders' },
    { slug: 'quoted"slug', name: 'Quoted' },
    { slug: 'my api', name: 'Spaced' },
  ],
  keys: [
    { name: 'wp3 key', apiName: 'Payments API' },
    { name: 'qbus-web', apiName: null },
    { name: 'bad"name', apiName: null },
    { name: 'wp3 key', apiName: 'Orders' },
  ],
  paths: ['/orders', '/v1', '/', '/health', '/a b/items', '/with"quote'],
};

const labels = (draft: string, c: SuggestContext = ctx) => suggest(draft, c).map((s) => s.label);
const applies = (draft: string, c: SuggestContext = ctx) => suggest(draft, c).map((s) => s.apply);

describe('suggest: keywords (no colon yet)', () => {
  it('lists every field, in grammar order, each with its description, for an empty draft', () => {
    const list = suggest('', ctx);
    expect(list.map((s) => s.label)).toEqual(SEARCH_FIELDS.map((f) => `${f}:`));
    expect(list.map((s) => s.apply)).toEqual(SEARCH_FIELDS.map((f) => `${f}:`));
    expect(list.map((s) => s.description)).toEqual(SEARCH_FIELDS.map((f) => `about ${f}`));
    expect(list.some((s) => s.commit)).toBe(false);
  });

  it('offers the same list after a space, keeping the words already typed in `apply`', () => {
    expect(applies('status:>=500 ')[0]).toBe('status:>=500 status:');
    expect(labels('status:>=500 ')).toHaveLength(SEARCH_FIELDS.length);
  });

  it('matches the field being typed and keeps what came before it', () => {
    expect(labels('sta')).toEqual(['status:']);
    expect(applies('foo bar sta')).toEqual(['foo bar status:']);
  });

  it('keeps a leading minus, on the apply and for the match', () => {
    expect(labels('-met')).toEqual(['method:']);
    expect(applies('-met')).toEqual(['-method:']);
    expect(labels('-')).toHaveLength(SEARCH_FIELDS.length);
    expect(applies('-')[0]).toBe('-status:');
  });

  it('ranks fields that start with the text above fields that merely contain it', () => {
    expect(labels('a')).toEqual(['api:', 'status:', 'latency:', 'path:']);
  });

  it('says which characters matched, so the row can emphasise them', () => {
    const [first, second] = suggest('a', ctx);
    expect(first?.match).toEqual({ start: 0, end: 1 });
    expect(second?.match).toEqual({ start: 2, end: 3 });
    expect(suggest('', ctx)[0]?.match).toBeUndefined();
  });

  it('offers nothing for text that is no field, and never suggests the unsupported ~', () => {
    expect(labels('zzz')).toEqual([]);
    expect(labels('status~')).toEqual([]);
    expect(labels('~')).toEqual([]);
  });

  it('offers nothing for a field name that is not one', () => {
    expect(labels('foo:')).toEqual([]);
    expect(labels('foo:bar')).toEqual([]);
  });

  it('offers nothing inside an unterminated quote, but offers fields after a closed one', () => {
    expect(labels('"sta')).toEqual([]);
    expect(labels('foo "sta')).toEqual([]);
    expect(labels('body:"two words" sta')).toEqual(['status:']);
    expect(applies('body:"two words" sta')).toEqual(['body:"two words" status:']);
  });
});

describe('suggest: values commit the token', () => {
  it('lists the status classes, the thresholds, then the common codes, with their meanings', () => {
    const list = suggest('status:', ctx);
    expect(list.map((s) => s.label)).toEqual([...STATUS_VALUES]);
    expect(list.slice(0, 6).map((s) => s.label)).toEqual(['2xx', '3xx', '4xx', '5xx', '>=400', '>=500']);
    expect(list.map((s) => s.description)).toEqual(STATUS_VALUES.map((v) => `meaning of ${v}`));
    expect(list.every((s) => s.commit === true)).toBe(true);
    expect(list[0]?.apply).toBe('status:2xx');
  });

  it('ranks status values that start with the text above those that contain it', () => {
    expect(labels('status:5')).toEqual(['5xx', '500', '502', '503', '504', '>=500']);
    expect(labels('status:>')).toEqual(['>=400', '>=500']);
    expect(applies('-status:4').slice(0, 2)).toEqual(['-status:4xx', '-status:400']);
  });

  it('keeps the words typed before the token when it commits', () => {
    expect(applies('foo method:P')).toEqual(['foo method:POST', 'foo method:PUT', 'foo method:PATCH', 'foo method:OPTIONS']);
  });

  it('lists the methods, and completes the segment after the last comma without repeating a chosen one', () => {
    expect(labels('method:')).toEqual(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
    expect(labels('method:GET,P')).toEqual(['POST', 'PUT', 'PATCH', 'OPTIONS']);
    expect(applies('method:GET,P')[0]).toBe('method:GET,POST');
    expect(labels('method:get,')).toEqual(['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
    expect(applies('method:get,po')).toEqual(['method:get,POST']);
  });

  it('lists latency thresholds with a translated meaning', () => {
    const list = suggest('latency:', ctx);
    expect(list.map((s) => s.label)).toEqual(['>200', '>500', '>1000', '>2000']);
    expect(list[1]?.description).toBe('slower than 500 ms');
    expect(labels('latency:>5')).toEqual(['>500']);
    expect(labels('latency:1')).toEqual(['>1000']);
  });

  it('lists common header names for both header fields, and nothing once a value follows =', () => {
    expect(labels('reqh:con')).toEqual(['content-type', 'content-length', 'content-encoding', 'cache-control']);
    expect(labels('resh:ret')).toEqual(['retry-after']);
    expect(applies('resh:ret')).toEqual(['resh:retry-after']);
    expect(labels('reqh:content-type=')).toEqual([]);
    expect(labels('reqh:content-type=app')).toEqual([]);
    expect(labels('reqh:').length).toBeGreaterThan(10);
  });

  it('never lists a header whose value is redacted before storage, however it is approached', () => {
    const secret = ['authorization', 'cookie', 'set-cookie', 'x-api-key', 'x-tyk-authorization'];
    for (const field of ['reqh', 'resh']) {
      expect(labels(`${field}:`).filter((l) => secret.includes(l))).toEqual([]);
      for (const name of secret) {
        for (let length = 1; length <= name.length; length += 1) {
          expect(labels(`${field}:${name.slice(0, length)}`).filter((l) => secret.includes(l))).toEqual([]);
        }
      }
    }
  });

  it('offers no list for body words: a term is typed, not picked', () => {
    expect(labels('body:')).toEqual([]);
    expect(labels('body:fund')).toEqual([]);
    expect(labels('-res:x')).toEqual([]);
    expect(labels('req:')).toEqual([]);
  });

  it('offers nothing for a static field while a quote is open', () => {
    expect(labels('status:"5')).toEqual([]);
    expect(labels('method:"P')).toEqual([]);
    expect(labels('reqh:"con')).toEqual([]);
  });
});

describe('suggest: values from the lists', () => {
  it('lists API slugs, naming the API when it differs, and matches the name as well as the slug', () => {
    const list = suggest('api:', ctx);
    expect(list.map((s) => s.label)).toEqual(['payments', 'orders-api', '"my api"']);
    expect(list[0]?.description).toBe('Payments API');
    expect(list[0]?.apply).toBe('api:payments');
    expect(list.every((s) => s.commit === true)).toBe(true);
    expect(labels('api:pay')).toEqual(['payments']);
    expect(labels('api:Orders')).toEqual(['orders-api']);
  });

  it('writes a slug with spaces quoted and drops one that cannot be written at all', () => {
    expect(applies('api:my')).toEqual(['api:"my api"']);
    expect(labels('api:quoted')).toEqual([]);
  });

  it('lists key names exactly as they must be typed: quoted when spaced, once each, unwritable ones dropped', () => {
    expect(labels('key:')).toEqual(['"wp3 key"', 'qbus-web']);
    expect(applies('key:wp')).toEqual(['key:"wp3 key"']);
    expect(suggest('key:wp', ctx)[0]?.description).toBe('Payments API');
    expect(labels('key:bad')).toEqual([]);
  });

  it('corrects the case of a key, because the server matches the alias exactly', () => {
    expect(applies('key:WP')).toEqual(['key:"wp3 key"']);
    expect(applies('key:QBUS')).toEqual(['key:qbus-web']);
  });

  it('finds a value while its opening quote is still open, and when it is closed', () => {
    expect(applies('key:"wp3 k')).toEqual(['key:"wp3 key"']);
    expect(applies('key:"wp3 key"')).toEqual(['key:"wp3 key"']);
    expect(applies('a key:"qb')).toEqual(['a key:qbus-web']);
  });

  it('lists top paths that can be searched, matching by prefix first and anywhere second', () => {
    expect(labels('path:')).toEqual(['/orders', '/health', '"/a b/items"']);
    expect(labels('path:/o')).toEqual(['/orders']);
    expect(labels('path:ord')).toEqual(['/orders']);
    expect(applies('path:ord')).toEqual(['path:/orders']);
    expect(labels('path:"/a b')).toEqual(['"/a b/items"']);
  });

  it('lists the same paths for route:, which is an exact path, so even a one-segment path is offered', () => {
    expect(labels('route:')).toEqual(['/orders', '/v1', '/', '/health', '"/a b/items"']);
    expect(applies('route:ord')).toEqual(['route:/orders']);
    expect(applies('-route:/h')).toEqual(['-route:/health']);
    expect(labels('route:/')).toEqual(['/orders', '/v1', '/', '/health', '"/a b/items"']);
    expect(labels('route:', { ...ctx, paths: undefined })).toEqual([]);
  });

  it('finds the route field, ranked above the fields that only contain the text', () => {
    expect(labels('rou')).toEqual(['route:']);
    expect(labels('t')).toEqual(['status:', 'method:', 'latency:', 'path:', 'route:']);
    expect(labels('route')).toEqual(['route:']);
  });

  it('caps a long list', () => {
    const paths = Array.from({ length: 60 }, (_, i) => `/route-${String(i)}`);
    expect(suggest('path:', { ...ctx, paths })).toHaveLength(MAX_DYNAMIC_SUGGESTIONS);
    expect(suggest('path:/route-5', { ...ctx, paths }).map((s) => s.label)).toContain('/route-59');
  });

  it('survives a null name, slug or path in what the API sent, and still offers the rest', () => {
    // The API's types promise strings; a row with a hole must not break the page it is shown on.
    const dirty = {
      ...ctx,
      apis: [
        { slug: 'ok', name: null },
        { slug: null, name: 'Named' },
      ],
      keys: [
        { name: null, apiName: null },
        { name: 'fine', apiName: null },
      ],
      paths: [null, '/orders'],
    } as unknown as SuggestContext;
    expect(labels('api:', dirty)).toEqual(['ok']);
    expect(labels('key:', dirty)).toEqual(['fine']);
    expect(labels('path:', dirty)).toEqual(['/orders']);
    expect(labels('api:nam', dirty)).toEqual([]);
  });

  it('offers nothing while a list has not loaded, failed, or is empty', () => {
    const bare: SuggestContext = { ...ctx, apis: undefined, keys: undefined, paths: undefined };
    expect(labels('api:', bare)).toEqual([]);
    expect(labels('key:', bare)).toEqual([]);
    expect(labels('path:', bare)).toEqual([]);
    expect(labels('api:', { ...ctx, apis: [] })).toEqual([]);
    // The static suggestions are unaffected.
    expect(labels('status:5', bare)).toHaveLength(6);
    expect(labels('', bare)).toHaveLength(SEARCH_FIELDS.length);
  });
});

describe('suggest: every row is something the parser accepts', () => {
  const drafts = [
    'status:',
    'status:4',
    'method:',
    'method:GET,',
    'latency:',
    'reqh:',
    'resh:x',
    'api:',
    'key:',
    'path:',
    'route:',
    '-route:/o',
    '-status:',
    'a b method:P',
  ];
  it.each(drafts)('%s', (draft) => {
    const list = suggest(draft, ctx);
    expect(list.length).toBeGreaterThan(0);
    for (const row of list) {
      expect(row.commit).toBe(true);
      const token = tokenize(row.apply).at(-1) ?? '';
      expect(parseToken(token).ok, `${row.apply} parses`).toBe(true);
    }
  });

});

describe('the fields it offers are the fields the parser has', () => {
  it('offers every parser field, and the parser accepts every field offered', () => {
    const offered = suggest('', ctx).map((row) => row.label.replace(/:$/, ''));
    expect(offered).toEqual([...SEARCH_FIELDS]);
    for (const field of offered) {
      const parsed = parseToken(`${field}:abc`);
      expect(parsed.ok || parsed.error.code !== 'unknownField', field).toBe(true);
    }
    expect(parseToken('nofield:abc')).toEqual({ ok: false, error: { code: 'unknownField', params: { field: 'nofield' } } });
  });

  it.each([
    ['en', enAnalytics],
    ['fr', frAnalytics],
    ['ar', arAnalytics],
  ])('%s describes each field the parser has, and no other', (_locale, messages) => {
    expect(Object.keys(messages.search.suggest.fields).sort()).toEqual([...SEARCH_FIELDS].sort());
  });

  it.each([
    ['en', enAnalytics],
    ['fr', frAnalytics],
    ['ar', arAnalytics],
  ])('%s explains each status value that is offered, and no other', (_locale, messages) => {
    const key = (value: string) => value.replace('>=', 'gte');
    expect(Object.keys(messages.search.suggest.status).sort()).toEqual(STATUS_VALUES.map(key).sort());
  });
});

describe('valueField', () => {
  it.each([
    ['status:5', 'status'],
    ['-api:p', 'api'],
    ['a b key:"x y', 'key'],
    ['path:', 'path'],
    ['-route:/o', 'route'],
    ['sta', null],
    ['', null],
    ['foo:bar', null],
    ['status:5 ', null],
  ])('%j -> %j', (draft, field) => {
    expect(valueField(draft)).toBe(field);
  });
});

describe('draftHint', () => {
  it('asks for a real word on the body fields', () => {
    expect(draftHint('body:')).toEqual({ kind: 'term' });
    expect(draftHint('res:fund')).toEqual({ kind: 'term' });
    expect(draftHint('-req:"two wo')).toEqual({ kind: 'term' });
  });

  it('warns when the term typed is a word found in almost every body', () => {
    expect(draftHint('body:data')).toEqual({ kind: 'commonWord', term: 'data' });
    expect(draftHint('-req:"data"')).toEqual({ kind: 'commonWord', term: 'data' });
    // A quote still open is not part of the word.
    expect(draftHint('body:"data')).toEqual({ kind: 'commonWord', term: 'data' });
    expect(draftHint('a b res:name')).toEqual({ kind: 'commonWord', term: 'name' });
    expect(draftHint('body:id')).toEqual({ kind: 'term' });
  });

  it('says nothing for other fields, bare words, or an empty draft', () => {
    expect(draftHint('')).toBeNull();
    expect(draftHint('status:5')).toBeNull();
    expect(draftHint('id')).toBeNull();
    expect(draftHint('body:fund ')).toBeNull();
  });
});
