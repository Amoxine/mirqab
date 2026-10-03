// Shared by the docs tests (docs.test.ts, contextual.test.ts); not a test file itself.
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const ROOT = join(__dirname, '../../..');
export const CONTENT = join(ROOT, 'content/docs');

/**
 * The heading ids of a page as the real pipeline renders them: the page compiled with the plugin
 * fumadocs-mdx puts first (`remarkHeading`: explicit ids are `## Text [#id]`, every other heading is
 * slugged from its text). `@mdx-js/mdx` is not a direct dependency of this app, so it is read from where
 * fumadocs-mdx's own copy sits in the pnpm store.
 */
export async function renderedHeadingIds(locale: string, slug: string): Promise<string[]> {
  const mdxDir = join(realpathSync(join(ROOT, 'node_modules/fumadocs-mdx')), '..', '@mdx-js', 'mdx', 'index.js');
  const { compile } = (await import(pathToFileURL(mdxDir).href)) as {
    compile: (source: string, options: object) => Promise<{ toString(): string }>;
  };
  const { remarkHeading } = await import('fumadocs-core/mdx-plugins');
  const source = readFileSync(join(CONTENT, locale, `${slug}.mdx`), 'utf8');
  const code = String(
    await compile(source, { remarkPlugins: [[remarkHeading, { generateToc: false }]], outputFormat: 'function-body' }),
  );
  if (code.includes('[#')) throw new Error(`${locale}/${slug}: a custom id was left in the heading text`);
  return [...code.matchAll(/\bid: "([^"]+)"/g)].map((match) => String(match[1]));
}
