import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * A translation that loses or renames a `{placeholder}`, or drops a `<b>` tag, fails at runtime in that
 * language only: next-intl throws (or prints the raw key) the first time the string is shown. The key
 * guard (`infra/scripts/check-locale-keys.mjs`) proves every key exists in every locale; this proves
 * each French and Arabic message takes the same arguments and tags as its English source.
 *
 * `intl-messageformat` is what next-intl formats with, but it is not a dependency of this package, so it
 * is reached the way next-intl reaches it (next-intl, then use-intl, then it): the same parser, at the
 * version the app ships.
 */

interface Element {
  type: number;
  value?: string;
  options?: Record<string, { value: Element[] }>;
  children?: Element[];
}
type MessageFormatClass = new (message: string, locale: string) => { getAst: () => Element[] };

const fromWeb = createRequire(import.meta.url);
const fromNextIntl = createRequire(fromWeb.resolve('next-intl'));
const fromUseIntl = createRequire(fromNextIntl.resolve('use-intl'));
const { IntlMessageFormat } = fromUseIntl('intl-messageformat') as { IntlMessageFormat: MessageFormatClass };

// The parser's element kinds (`TYPE` in @formatjs/icu-messageformat-parser).
const TAG = 8;
const LITERAL = 0;
const POUND = 7;

interface Signature {
  /** Names of the `{arguments}`, whatever their format (`{n}`, `{n, number}`, `{n, plural, ...}`). */
  args: string[];
  /** Names of the `<tags>` the message wraps text in. */
  tags: string[];
}

/** What a message needs from the caller, gathered from every branch of every plural, select and tag. */
function signature(message: string, locale = 'en'): Signature {
  const args = new Set<string>();
  const tags = new Set<string>();
  const walk = (elements: Element[]): void => {
    for (const element of elements) {
      if (element.type === LITERAL || element.type === POUND) continue;
      if (element.type === TAG) {
        if (element.value !== undefined) tags.add(element.value);
        walk(element.children ?? []);
        continue;
      }
      if (element.value !== undefined) args.add(element.value);
      for (const option of Object.values(element.options ?? {})) walk(option.value);
    }
  };
  walk(new IntlMessageFormat(message, locale).getAst());
  return { args: [...args].sort(), tags: [...tags].sort() };
}

/** How `translated` differs from `source` in what it takes, in words; empty when it takes the same. */
function differences(source: string, translated: string, locale: string): string[] {
  const want = signature(source);
  const got = signature(translated, locale);
  const out: string[] = [];
  for (const arg of want.args.filter((a) => !got.args.includes(a))) out.push(`missing {${arg}}`);
  for (const arg of got.args.filter((a) => !want.args.includes(a))) out.push(`unknown {${arg}}`);
  for (const tag of want.tags.filter((a) => !got.tags.includes(a))) out.push(`missing <${tag}>`);
  for (const tag of got.tags.filter((a) => !want.tags.includes(a))) out.push(`unknown <${tag}>`);
  return out;
}

describe('the comparison itself', () => {
  it('reads plain arguments, formatted ones and those inside plural and select branches', () => {
    expect(signature('{a} and {b, number}').args).toEqual(['a', 'b']);
    expect(signature('{n, plural, one {# item of {owner}} other {# items}}').args).toEqual(['n', 'owner']);
    expect(signature('{kind, select, a {x {who}} other {y}}').args).toEqual(['kind', 'who']);
  });

  it('reads tags, and the arguments inside them', () => {
    expect(signature('<b>{count}</b> requests')).toEqual({ args: ['count'], tags: ['b'] });
  });

  it('accepts a translation that takes the same arguments in another word order, and other plural forms', () => {
    expect(differences('{index} of {count}: {request}', '{request} :{count} من {index}', 'ar')).toEqual([]);
    expect(
      differences(
        '{n, plural, one {# key} other {# keys}}',
        '{n, plural, zero {لا مفاتيح} one {مفتاح} two {مفتاحان} few {# مفاتيح} many {# مفتاحًا} other {# مفتاح}}',
        'ar',
      ),
    ).toEqual([]);
  });

  it('catches a dropped, a renamed and an invented argument, and a dropped or invented tag', () => {
    expect(differences('{count} requests', 'requêtes', 'fr')).toEqual(['missing {count}']);
    expect(differences('{count} requests', '{nombre} requêtes', 'fr')).toEqual(['missing {count}', 'unknown {nombre}']);
    expect(differences('requests', '{count} requêtes', 'fr')).toEqual(['unknown {count}']);
    expect(differences('<b>{count}</b> requests', '{count} requêtes', 'fr')).toEqual(['missing <b>']);
    expect(differences('{count} requests', '<i>{count}</i> requêtes', 'fr')).toEqual(['unknown <i>']);
  });

  it('catches an argument that survives in only one branch of a plural', () => {
    expect(differences('{n, plural, one {{who} has # key} other {{who} has # keys}}', '{n, plural, one {a # clé} other {{who} a # clés}}', 'fr')).toEqual([]);
    expect(differences('{n, plural, one {# key} other {# keys of {who}}}', '{n, plural, one {# clé} other {# clés}}', 'fr')).toEqual(['missing {who}']);
  });
});

const messagesDir = fileURLToPath(new URL('.', import.meta.url));
const LOCALES = ['fr', 'ar'];

/** Every message with the path it lives at (`charts.statusCodes.title`); arrays and objects are walked, keys are never shown. */
function messagesOf(node: unknown, path = ''): [string, string][] {
  if (typeof node === 'string') return [[path, node]];
  if (Array.isArray(node)) return node.flatMap((item, i) => messagesOf(item, `${path}[${String(i)}]`));
  if (node !== null && typeof node === 'object') {
    return Object.entries(node).flatMap(([key, value]) => messagesOf(value, path ? `${path}.${key}` : key));
  }
  return [];
}

const files = readdirSync(join(messagesDir, 'en')).filter((file) => file.endsWith('.json'));

describe('every French and Arabic message takes what its English source takes', () => {
  it('has files to compare (a moved folder would otherwise pass for nothing)', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it.each(files.flatMap((file) => LOCALES.map((locale) => [file, locale] as const)))('%s in %s', (file, locale) => {
    const source = messagesOf(JSON.parse(readFileSync(join(messagesDir, 'en', file), 'utf8')));
    const translated = new Map(messagesOf(JSON.parse(readFileSync(join(messagesDir, locale, file), 'utf8'))));
    const problems: string[] = [];
    for (const [path, english] of source) {
      const text = translated.get(path);
      // A missing key is the key guard's to report; it has no placeholders to compare.
      if (text === undefined) continue;
      try {
        for (const difference of differences(english, text, locale)) problems.push(`${path}: ${difference}`);
      } catch (error) {
        problems.push(`${path}: does not parse (${error instanceof Error ? error.message : String(error)})`);
      }
    }
    expect(problems).toEqual([]);
  });
});
