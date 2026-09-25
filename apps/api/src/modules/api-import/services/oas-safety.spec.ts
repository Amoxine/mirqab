import {
  findExternalRefs,
  MAX_ALIAS_DOCUMENT_BYTES,
  MAX_YAML_ALIASES,
  yamlAliasHazard,
} from './oas-safety';

describe('yamlAliasHazard', () => {
  it('passes a document with no alias at all', () => {
    expect(yamlAliasHazard('openapi: 3.0.3\ninfo:\n  title: X\n')).toBeNull();
  });

  it('does not count markdown asterisks in prose', () => {
    // More emphasised words than the alias budget: a rule that counted every `*word` would reject
    // this document, so the test can only pass if aliases are recognised by POSITION.
    const prose = [
      'info:',
      '  description: |',
      '    **Bold** text and a list:',
      '    * first item',
      '    * second item',
      '    It is *not* *really* *ever* *safe* to *skip* the *review* of an *upstream* change.',
      '    2 * 3 = 6',
    ].join('\n');

    expect(yamlAliasHazard(prose)).toBeNull();
  });

  it('exempts a document that parses as JSON, whatever its strings contain', () => {
    const json = JSON.stringify({ description: 'Status: *a*, *b*, *c*, *d*, *e*, *f*, *g*, *h*' });

    expect(yamlAliasHazard(json)).toBeNull();
  });

  it('does NOT exempt a YAML flow document that merely starts with a brace', () => {
    const bomb = '{a: &a [1,2], b: [*a,*a,*a,*a,*a,*a]}';

    expect(yamlAliasHazard(bomb)).toMatchObject({ reason: 'too-many-aliases', aliases: 6 });
  });

  it.each([
    ['a mapping value', 'a: &x [1]\nb: *x\n'],
    ['a sequence item', 'a: &x [1]\nb:\n  - *x\n'],
    ['a flow sequence', 'a: &x [1]\nb: [*x]\n'],
    ['a merge key', 'a: &x {k: 1}\nb:\n  <<: *x\n'],
  ])('counts an alias used as %s', (_label, yaml) => {
    // One alias is allowed; assert it is COUNTED by exceeding the budget with copies of it.
    const many = `${yaml}${yaml.split('\n').filter((line) => line.includes('*')).join('\n')}\n`.repeat(MAX_YAML_ALIASES + 1);

    expect(yamlAliasHazard(many)).toMatchObject({ reason: 'too-many-aliases' });
  });

  it('allows up to the alias budget in a small document', () => {
    const yaml = `a: &x [1]\n${Array.from({ length: MAX_YAML_ALIASES }, (_, i) => `b${String(i)}: *x`).join('\n')}\n`;

    expect(yamlAliasHazard(yaml)).toBeNull();
  });

  it('rejects one alias more than the budget, and reports the line of the first alias', () => {
    const yaml = `a: &x [1]\n${Array.from({ length: MAX_YAML_ALIASES + 1 }, (_, i) => `b${String(i)}: *x`).join('\n')}\n`;

    expect(yamlAliasHazard(yaml)).toEqual({ aliases: MAX_YAML_ALIASES + 1, line: 2, reason: 'too-many-aliases' });
  });

  it('rejects any alias in a document larger than the alias size ceiling', () => {
    const filler = `x-pad: ${'a'.repeat(MAX_ALIAS_DOCUMENT_BYTES)}\n`;
    const yaml = `a: &x [1]\nb: *x\n${filler}`;

    expect(yamlAliasHazard(yaml)).toMatchObject({ reason: 'document-too-large-for-aliases', aliases: 1 });
  });

  it('allows a large document that uses no alias', () => {
    expect(yamlAliasHazard(`x-pad: ${'a'.repeat(MAX_ALIAS_DOCUMENT_BYTES * 2)}\n`)).toBeNull();
  });
});

/**
 * Security review (OAS-00 follow-up): anchor and alias names may be any run of non-space characters
 * other than the flow indicators, and aliases may appear in every node position. Inputs stay SMALL and
 * only `yamlAliasHazard` is called: a regression must fail the assertion, never freeze the suite.
 */
describe('yamlAliasHazard — any anchor name, any node position', () => {
  /** `levels` of `lN: &<name>N [*<name>(N-1) × fan]`: the classic billion-laughs shape. */
  const laughs = (name: string, levels = 4, fan = 9): string =>
    [`l0: &${name}0 [a,a,a,a,a,a,a,a,a]`, ...Array.from({ length: levels - 1 }, (_, i) =>
      `l${String(i + 1)}: &${name}${String(i + 1)} [${Array.from({ length: fan }, () => `*${name}${String(i)}`).join(',')}]`,
    )].join('\n');

  it('the reported 184-byte non-ASCII document is refused', () => {
    const doc = laughs('é');
    expect(Buffer.byteLength(doc)).toBeLessThan(200);

    expect(yamlAliasHazard(doc)).toMatchObject({ reason: 'too-many-aliases', aliases: 27 });
  });

  it.each([
    ['an emoji name', '😈'],
    ['a CJK name', '笑'],
    ['a name with punctuation', 'a.b:c/d'],
    ['a name with a quote', "x'"],
  ])('refuses the same shape with %s', (_label, name) => {
    expect(yamlAliasHazard(laughs(name))).toMatchObject({ reason: 'too-many-aliases' });
  });

  it.each([
    ['a flow sequence without spaces', 'a: &x [1]\nb: [*x,*x,*x,*x,*x,*x]\n'],
    ['a flow mapping', 'a: &x [1]\nb: {p: *x, q: *x, r: *x, s: *x, t: *x, u: *x}\n'],
    ['a JSON-style flow mapping (no space after the colon)', 'a: &x [1]\nb: {"p":*x,"q":*x,"r":*x,"s":*x,"t":*x,"u":*x}\n'],
    ['explicit keys (?)', 'a: &x [1]\nb:\n' + '  ? *x\n  : 1\n'.repeat(6)],
    ['alias mapping keys', 'a: &x [1]\n' + Array.from({ length: 6 }, (_, i) => `*x : ${String(i)}`).join('\n')],
    ['merge keys', 'a: &x {k: 1}\n' + Array.from({ length: 6 }, (_, i) => `b${String(i)}:\n  <<: *x`).join('\n')],
    ['an anchor after a verbatim tag', 'a: !<tag:yaml.org,2002:seq> &x [1]\nb: [*x, *x, *x, *x, *x, *x]\n'],
    ['an anchor after a shorthand tag in a flow sequence', 'a: [!!seq &x [1]]\nb: [*x, *x, *x, *x, *x, *x]\n'],
    ['CRLF line endings', 'a: &x [1]\r\n' + Array.from({ length: 6 }, (_, i) => `b${String(i)}: *x`).join('\r\n')],
  ])('counts aliases in %s', (_label, yaml) => {
    expect(yamlAliasHazard(yaml)).toMatchObject({ reason: 'too-many-aliases' });
  });

  it('passes a normal specification with two aliases', () => {
    const spec = [
      'openapi: 3.0.3',
      'info: {title: T, version: "1"}',
      'components:',
      '  schemas:',
      '    Id: &id {type: string}',
      'paths:',
      '  /a:',
      '    get:',
      '      parameters:',
      '        - {name: a, in: query, schema: *id}',
      '        - {name: b, in: query, schema: *id}',
      '      responses: {"200": {description: ok}}',
    ].join('\n');

    expect(yamlAliasHazard(spec)).toBeNull();
  });

  it('does not count *bold* or &amp; in prose as aliases, even next to a real anchor', () => {
    const spec = [
      'x-shared: &shared {a: 1}',
      'x-use: *shared',
      'info:',
      '  description: Tom &amp; Jerry are *bold*, *very* *bold*, *so* *very* *bold* and &copy; ok',
      '  summary: "*a* *b* *c* *d* *e* *f*"',
    ].join('\n');

    expect(yamlAliasHazard(spec)).toBeNull();
  });

  it('a document with no anchor at all never trips, whatever looks like an alias', () => {
    // `Tom&Jerry` has an ampersand that is not in an anchor position, so the cheap `includes('&')` prefilter cannot decide this.
    const noAnchor = `title: Tom&Jerry\n${Array.from({ length: 50 }, (_, i) => `k${String(i)}: *x`).join('\n')}`;

    expect(yamlAliasHazard(noAnchor)).toBeNull();
  });

  it('exempts a JSON document with many *x strings', () => {
    expect(yamlAliasHazard(JSON.stringify({ a: Array.from({ length: 50 }, () => '*x &x') }))).toBeNull();
  });

  it('refuses one non-ASCII alias in a document over the size ceiling, quickly', () => {
    const doc = `a: &é [1]\nb: *é\nx-pad: ${'a'.repeat(MAX_ALIAS_DOCUMENT_BYTES)}\n`;
    const started = Date.now();

    expect(yamlAliasHazard(doc)).toMatchObject({ reason: 'document-too-large-for-aliases', aliases: 1 });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('scans a 5 MB document of *prose* &amp; ampersands in well under a second, and passes it', () => {
    const doc = `x-a: &a 1\ndescription: ${'word *a &amp; '.repeat((5 * 1024 * 1024) / 14)}`;
    const started = Date.now();

    expect(yamlAliasHazard(doc)).toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('findExternalRefs', () => {
  it('ignores local references', () => {
    expect(findExternalRefs({ a: { $ref: '#/components/schemas/X' }, b: { $ref: '#' } })).toEqual([]);
  });

  it.each([
    'http://127.0.0.1/x',
    'https://example.invalid/x',
    'file:///etc/passwd',
    '../x.yaml',
    'other.yaml#/a',
    ' #/leading-space',
    '',
  ])('flags %j', (ref) => {
    expect(findExternalRefs({ schema: { $ref: ref } })).toEqual([{ path: ['schema'], ref }]);
  });

  it('reports the path of every external reference, through arrays and nesting', () => {
    const found = findExternalRefs({
      paths: { '/a': { $ref: 'http://x/y' } },
      list: [{ deep: { $ref: 'file:///z' } }],
    });

    expect(found).toEqual(
      expect.arrayContaining([
        { path: ['paths', '/a'], ref: 'http://x/y' },
        { path: ['list', '0', 'deep'], ref: 'file:///z' },
      ]),
    );
    expect(found).toHaveLength(2);
  });

  it('leaves a schema property that is merely named $ref alone (its value is an object)', () => {
    expect(findExternalRefs({ properties: { $ref: { type: 'string' } } })).toEqual([]);
  });

  it('ignores a non-string $ref value', () => {
    expect(findExternalRefs({ a: { $ref: 5 }, b: { $ref: null }, c: { $ref: ['http://x'] } })).toEqual([]);
  });

  it('survives a very deep document without a stack overflow', () => {
    let node: Record<string, unknown> = { $ref: 'http://deep.invalid/x' };
    for (let i = 0; i < 20_000; i += 1) node = { n: node };

    expect(findExternalRefs(node)).toHaveLength(1);
  });

  it.each([null, undefined, 'a string', 42, true])('accepts a non-object root (%p)', (root) => {
    expect(findExternalRefs(root)).toEqual([]);
  });
});
