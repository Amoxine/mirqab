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
