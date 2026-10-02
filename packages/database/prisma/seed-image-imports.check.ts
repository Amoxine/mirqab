/**
 * Pins that everything the seed and the Kratos import load at RUN time is something the api image
 * actually contains.
 *
 * The seed is not run from the source tree in production: `docker compose run api npx prisma db seed`
 * runs it inside the built image, where apps/api/Dockerfile's production stage copies only the paths
 * its `COPY` lines name. `prisma/seed.ts` imports `../src/index`, and for a long time no `COPY` line
 * brought `src/` along, so the seed died with MODULE_NOT_FOUND before it reached the fail-closed
 * admin-credentials gate: every check of that gate (admin-credentials.check.ts, seed-refusal.check.ts)
 * ran from the SOURCE tree and was green while the image could not run the seed at all.
 *
 * So this walks the relative imports of the files the image runs, transitively, and requires each
 * resolved file to sit under a source path the production stage COPYs from the build context
 * (a `COPY --from=builder` brings built output and node_modules, never source, so it does not count).
 * Bare imports (`@prisma/client`, `bcrypt`) come from node_modules, which the image carries whole, and
 * are out of scope here.
 *
 * Plain assertions, tsx, non-zero exit on throw — same convention as the other checks in this package.
 * Two env overrides exist so the check itself can be shown to fail without editing tracked files:
 * DOCKERFILE_UNDER_TEST and RUNTIME_ENTRY_FILES (comma separated, repo-relative).
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative, resolve } from 'node:path';

const repoRoot = resolve(__dirname, '../../..');
const dockerfilePath = process.env.DOCKERFILE_UNDER_TEST ?? join(repoRoot, 'apps/api/Dockerfile');

// What the image runs from source: the seed (`npx prisma db seed`) and the Kratos import
// (install.sh runs `tsx scripts/migrate-users-to-kratos.ts` right after seeding). Both live in the image.
const entryFiles = (
  process.env.RUNTIME_ENTRY_FILES ??
  'packages/database/prisma/seed.ts,packages/database/prisma/admin-credentials.ts,packages/database/scripts/migrate-users-to-kratos.ts'
).split(',');

/** Source paths (repo-relative, no trailing slash) the production stage copies from the build context. */
function productionStageCopySources(dockerfile: string): string[] {
  const lines = dockerfile.split('\n');
  const start = lines.findIndex((l) => /^FROM\s+\S+\s+AS\s+production\s*$/i.test(l.trim()));
  assert.ok(start >= 0, `${dockerfilePath}: no "FROM ... AS production" stage found`);
  const sources: string[] = [];
  for (const raw of lines.slice(start + 1)) {
    const line = raw.trim();
    if (/^FROM\s/i.test(line)) break; // a later stage
    if (!/^COPY\s/i.test(line)) continue;
    const args = line.split(/\s+/).slice(1);
    if (args.some((a) => a.startsWith('--from='))) continue; // build output, not source
    const paths = args.filter((a) => !a.startsWith('--'));
    for (const src of paths.slice(0, -1)) sources.push(src.replace(/^\.\//, '').replace(/\/+$/, ''));
  }
  return sources;
}

const RELATIVE_IMPORT = /(?:\bfrom|\bimport|\brequire\s*\(|\bimport\s*\()\s*['"](\.{1,2}\/[^'"]*)['"]/g;

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"])\/\/.*$/gm, '$1');
}

function resolveRelative(fromFile: string, specifier: string): string | null {
  const base = resolve(dirname(fromFile), specifier);
  const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.json`, join(base, 'index.ts'), join(base, 'index.js')];
  return candidates.find((c) => existsSync(c) && statSync(c).isFile()) ?? null;
}

const sources = productionStageCopySources(readFileSync(dockerfilePath, 'utf8'));
assert.ok(sources.length > 0, 'the production stage copies no source paths at all — the parser found nothing');
const isCopied = (repoRelative: string) => sources.some((s) => repoRelative === s || repoRelative.startsWith(`${s}/`));

const missing: string[] = [];
const seen = new Set<string>();
const queue = entryFiles.map((f) => resolve(repoRoot, f));
for (const entry of queue) assert.ok(existsSync(entry), `entry file ${relative(repoRoot, entry)} does not exist`);

while (queue.length > 0) {
  const file = queue.pop() as string;
  if (seen.has(file)) continue;
  seen.add(file);
  const rel = normalize(relative(repoRoot, file)).split('\\').join('/');
  if (!isCopied(rel)) {
    missing.push(`${rel} is loaded at run time but no production-stage COPY brings it into the image`);
    continue;
  }
  const code = stripComments(readFileSync(file, 'utf8'));
  for (const match of code.matchAll(RELATIVE_IMPORT)) {
    const resolved = resolveRelative(file, match[1]);
    if (resolved === null) {
      missing.push(`${rel} imports '${match[1]}', which resolves to no file in the repository`);
    } else if (!file.endsWith('.json')) {
      queue.push(resolved);
    }
  }
}

assert.deepEqual(
  missing,
  [],
  `The api image cannot run the seed / Kratos import: ${missing.join('; ')}.\n` +
    `Production stage COPY sources (apps/api/Dockerfile): ${sources.join(', ')}.\n` +
    'Add a COPY line for the missing path to the production stage, or stop importing it from the seed.',
);

console.log(
  `✅ seed and Kratos import: ${String(seen.size)} source files, all under the production stage's COPY sources`,
);
