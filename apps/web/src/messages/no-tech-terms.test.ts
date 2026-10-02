import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ALLOWED_CONTEXTS, allowedReasons, findBanned, proseLiterals, reachesBrowser } from './tech-term-scan';

/**
 * The dashboard is a product surface, not an ops console: nothing a browser user can read may name
 * the infrastructure behind it. OpenAPI, JWT and OAuth stay — they are standards customers work with.
 * The matcher and the source reader live in `tech-term-scan.ts`; this file walks the files and holds
 * the fixtures that prove what each of them catches and leaves alone.
 */

const webRoot = fileURLToPath(new URL('../..', import.meta.url));
const apiSrc = join(webRoot, '../api/src');

function filesUnder(dir: string, matches: (path: string) => boolean): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return filesUnder(path, matches);
    return matches(path) ? [path] : [];
  });
}

/** String leaves only: keys are code identifiers (`emptyState.pump`), never shown. */
function stringValues(node: unknown): string[] {
  if (typeof node === 'string') return [node];
  if (Array.isArray(node)) return node.flatMap(stringValues);
  if (node !== null && typeof node === 'object') return Object.values(node).flatMap(stringValues);
  return [];
}

function hits(file: string, texts: string[]): string[] {
  return texts.flatMap((text) => {
    const word = findBanned(text);
    return word ? [`${relative(webRoot, file)}: "${word}" in ${JSON.stringify(text.slice(0, 120))}`] : [];
  });
}

/** Zero files or zero strings would pass every scan vacuously (a moved folder, a wrong path). */
function expectScanned(scanned: { files: number; texts: number }, min: { files: number; texts: number }): void {
  expect(scanned.files).toBeGreaterThanOrEqual(min.files);
  expect(scanned.texts).toBeGreaterThanOrEqual(min.texts);
}

describe('the matcher', () => {
  it.each([
    'Tyk Pump',
    'tyk_gateway',
    'TykGateway',
    'start the tyk-pump service',
    'Redis7',
    'Postgres16',
    'Pumps',
    'built on NestJS',
    'NESTJS',
    'Ory Kratos and Keto',
    'OAS document',
    'valid OAS3',
    'PostgreSQL',
    'postgresql 16',
    'POSTGRESQL',
    'tykgateway',
    'TYKGATEWAY',
    'redispump',
    'the RedisPumps',
  ])('flags %s', (text) => {
    expect(findBanned(text)).toBeDefined();
  });

  it.each([
    'redistribute the load',
    'hydrate the list',
    'hydrangea',
    'nested menus',
    'ketone',
    'a story in the category directory',
    'history, memory and factory',
    'oasis',
    'pumpkin',
    'tyke',
    'prismatic',
    'an API server with a cache and a host',
    'OpenAPI 3.1 with OAuth and a JWT',
  ])('leaves %s alone', (text) => {
    expect(findBanned(text)).toBeUndefined();
  });
});

/** The prose of a source snippet that is allowed to reach a browser, i.e. what the API scan checks. */
const reaching = (source: string) => proseLiterals(source).filter(reachesBrowser).map((literal) => literal.text);

describe('the source reader', () => {
  it('reads prose only: comments, identifiers, paths and machine codes are not prose', () => {
    const source = `
      // Tyk is down
      /* the Tyk gateway */
      import { TykClient } from './tyk-client.service';
      const key = 'x-tyk-api-gateway';
      const code = 'OAS_LINT_FAILED';
      fetch('/tyk/apis/oas');
    `;
    expect(proseLiterals(source)).toEqual([]);
  });

  // `${...}` interpolations are replaced by `…`: only the text typed in the source is scanned. An
  // interpolated value that is itself upstream text is neutralised where it is forwarded
  // (`neutraliseUpstreamMessage`, covered in upstream-message.spec.ts), not here.
  it('replaces interpolations and keeps the typed text around them', () => {
    expect(proseLiterals('const m = `Too big: ${String(limit)} MB limit`;').map((l) => l.text)).toEqual([
      'Too big: … MB limit',
    ]);
  });

  it('does not take a template that is only an interpolation and a path for prose', () => {
    expect(proseLiterals('const uri = `tyk://${host}/mcp`; const p = `/apis/oas/${id}`;')).toEqual([]);
  });

  it('is not thrown off by a quote inside a regular expression', () => {
    const source = `const q = s.replace(/'/g, "''"); const r = /[()"]/.test(s) ? 1 : 2 / 3; show('Tyk is down');`;
    expect(proseLiterals(source).map((l) => l.text)).toEqual(['Tyk is down']);
  });

  it.each([
    ['an unterminated string', "const a = 'Tyk is down;"],
    ['a ")" with no "("', 'a); b'],
    ['a "(" never closed', "show('x y'"],
  ])('throws on %s rather than guessing', (_what, source) => {
    expect(() => proseLiterals(source)).toThrow();
  });

  it('records every call a literal sits inside, outermost first', () => {
    const [literal] = proseLiterals("@ApiOperation({ summary: tidy('Needs a key') })");
    expect(literal?.callers).toEqual(['@ApiOperation', 'tidy']);
  });

  it.each([
    ['an exception message', "throw new BadRequestException('Needs the Tyk gateway');"],
    ['a subclass of an exception', 'throw new UpstreamError(`Tyk error: ${message}`, 400);'],
    ['a returned error field', "return { error: 'Tyk gateway URL is not configured' };"],
    ['a helper argument', "return unreachableHealth('Tyk gateway URL is not configured');"],
    ['a DTO validation message', "@IsString({ message: 'The Tyk id is required' })"],
    ['a template literal', 'const text = `Tyk says no ${reason}`;'],
    ['a literal beside, not inside, a logger call', "this.logger.warn(error); show('Tyk is down');"],
    ['a literal that merely sounds like a logger', "report('Tyk is down');"],
    ['prose that merely starts like SQL', "show('Select a Tyk key to continue');"],
  ])('lets %s through to the scan', (_context, source) => {
    expect(reaching(source).some((text) => findBanned(text))).toBe(true);
  });

  // One fixture per allowed context, each holding prose that names the infrastructure.
  const ALLOWED_FIXTURES = [
    "this.logger.warn(`Tyk node ${url} failed`);",
    "this.logger[level](`Tyk gateway health probe failed: ${why}`);",
    "console.log('Tyk is down');",
    "log(`Tyk API ${status}: ${message}`);",
    "@ApiOperation({ summary: 'Readiness of the Tyk Pump pipeline' })",
    "throw new Error('Kratos whoami failed');",
    "new Counter({ name: 'x', help: 'Per-node outcome of each Tyk fan-out write' });",
    'return prisma.$queryRaw`SELECT * FROM public.tyk_analytics WHERE apiid = ${id}`;',
    'const COUNT_SQL = `\\n  DELETE FROM public.tyk_aggregated WHERE ts < ${cutoff}`;',
  ];

  it.each(ALLOWED_FIXTURES)('skips the allowed context in %s', (source) => {
    expect(proseLiterals(source).length).toBeGreaterThan(0);
    expect(reaching(source)).toEqual([]);
  });

  it('has a fixture for every allowed context, each with a reason', () => {
    const exercised = new Set(ALLOWED_FIXTURES.flatMap((source) => proseLiterals(source).flatMap(allowedReasons)));
    expect([...exercised].sort()).toEqual(ALLOWED_CONTEXTS.map((allowed) => allowed.reason).sort());
    expect(ALLOWED_CONTEXTS.every((allowed) => allowed.reason.length > 0)).toBe(true);
  });
});

describe('no infrastructure names in anything a browser user can read', () => {
  it('message values (all locales)', () => {
    const files = filesUnder(join(webRoot, 'src/messages'), (path) => path.endsWith('.json'));
    const values = files.map((file) => ({ file, texts: stringValues(JSON.parse(readFileSync(file, 'utf8'))) }));
    expectScanned(
      { files: files.length, texts: values.reduce((n, v) => n + v.texts.length, 0) },
      { files: 50, texts: 1000 },
    );
    expect(values.flatMap(({ file, texts }) => hits(file, texts))).toEqual([]);
  });

  it('docs pages (all locales)', () => {
    const files = filesUnder(join(webRoot, 'content/docs'), (path) => path.endsWith('.mdx'));
    const lines = files.map((file) => ({ file, texts: readFileSync(file, 'utf8').split('\n') }));
    expectScanned({ files: files.length, texts: lines.reduce((n, v) => n + v.texts.length, 0) }, { files: 25, texts: 500 });
    expect(lines.flatMap(({ file, texts }) => hits(file, texts))).toEqual([]);
  });

  it('API prose a browser can receive: every string literal outside the allowed contexts', () => {
    const files = filesUnder(apiSrc, (path) => path.endsWith('.ts') && !/\.(db-)?spec\.ts$/.test(path));
    const found = files.map((file) => {
      try {
        return { file, texts: proseLiterals(readFileSync(file, 'utf8')).filter(reachesBrowser).map((literal) => literal.text) };
      } catch (error) {
        throw new Error(`${relative(webRoot, file)}: the scan lost its place (${(error as Error).message})`);
      }
    });
    expectScanned({ files: files.length, texts: found.reduce((n, v) => n + v.texts.length, 0) }, { files: 150, texts: 300 });
    // `CLASSIC` is the definition-format enum's own name; lower-case "a classic definition" is plain English.
    const offenders = found.flatMap(({ file, texts }) => [
      ...hits(file, texts),
      ...texts
        .filter((text) => /\bCLASSIC\b/.test(text))
        .map((text) => `${relative(webRoot, file)}: "CLASSIC" in ${JSON.stringify(text.slice(0, 120))}`),
    ]);
    expect(offenders).toEqual([]);
  });
});
