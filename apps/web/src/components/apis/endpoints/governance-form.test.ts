import { describe, expect, it } from 'vitest';
import { makeGovernanceSchema, parseSchema, toFormValues, toPatch } from './governance-form';

const t = (key: string) => key;
const all = () => true;

describe('parseSchema', () => {
  it('accepts an inline object schema', () => {
    expect(parseSchema('{"type":"object"}')).toEqual({ schema: { type: 'object' } });
  });
  it.each([
    ['not json', 'schemaInvalidJson'],
    ['[1]', 'schemaNotObject'],
    ['null', 'schemaNotObject'],
    ['{"items":[{"$ref":"#/a"}]}', 'schemaHasRef'],
    [`{"d":"${'x'.repeat(64 * 1024)}"}`, 'schemaTooLarge'],
  ])('refuses %s', (input, error) => {
    expect(parseSchema(input)).toEqual({ error });
  });
});

describe('toPatch', () => {
  it('an untouched form sends nothing', () => {
    const g = { rateLimit: { rate: 1, per: 2 }, enabled: false as const };
    expect(toPatch(toFormValues(g), g, all)).toEqual({ set: {}, clear: [] });
  });

  it('sets what was turned on, clears only what is stored and turned off', () => {
    const v = { ...toFormValues({ timeoutSeconds: 5 }), timeoutOn: false, isPublic: true, cacheOn: true, cacheCodes: '200, 204' };
    expect(toPatch(v, { timeoutSeconds: 5 }, all)).toEqual({
      set: { auth: 'public', cache: { timeoutSeconds: 60, cacheResponseCodes: [200, 204] } },
      clear: ['timeoutSeconds'],
    });
  });

  it('clears a stored control even when it is not offered', () => {
    const v = { ...toFormValues({ mock: { code: 500, body: 'x' } }), mockOn: false };
    expect(toPatch(v, { mock: { code: 500, body: 'x' } }, () => false)).toEqual({ set: {}, clear: ['mock'] });
  });

  it('never sends a control that is not offered', () => {
    const v = { ...toFormValues(null), mockOn: true, mockHeaders: 'X-A: 1' };
    expect(toPatch(v, null, (c) => c !== 'mock')).toEqual({ set: {}, clear: [] });
    expect(toPatch(v, null, all).set.mock).toEqual({ code: 200, body: '', headers: [{ name: 'X-A', value: '1' }] });
  });
});

describe('makeGovernanceSchema', () => {
  const schema = makeGovernanceSchema(t);
  it('ignores the fields of a control that is off', () => {
    expect(schema.safeParse({ ...toFormValues(null), rate: 'abc' }).success).toBe(true);
  });
  it('mirrors the API caps: mock body 64,000 chars, 20 cache codes', () => {
    const body = schema.safeParse({ ...toFormValues(null), mockOn: true, mockBody: 'x'.repeat(64_001) });
    expect(body.error?.issues.map((i) => i.path[0])).toEqual(['mockBody']);
    expect(schema.safeParse({ ...toFormValues(null), mockOn: true, mockBody: 'x'.repeat(64_000) }).success).toBe(true);
    const codes = Array.from({ length: 21 }, (_, i) => String(200 + i)).join(',');
    expect(schema.safeParse({ ...toFormValues(null), cacheOn: true, cacheCodes: codes }).error?.issues.map((i) => i.path[0])).toEqual(['cacheCodes']);
  });

  it('validates the fields of a control that is on', () => {
    const r = schema.safeParse({ ...toFormValues(null), timeoutOn: true, timeoutSeconds: '601', mockOn: true, mockHeaders: 'nocolon' });
    expect(r.success).toBe(false);
    expect(r.error?.issues.map((i) => i.path[0])).toEqual(['timeoutSeconds', 'mockHeaders']);
  });
});
