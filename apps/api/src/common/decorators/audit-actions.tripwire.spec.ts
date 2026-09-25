import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { AuditAction } from '@prisma/client';

/**
 * Tripwire: every `@Audit('<entity>:<action>')` label must map to a real `AuditAction`.
 *
 * `AuditLogInterceptor` upper-cases the part after the colon and writes it to `audit_logs.action`, an
 * enum column. A label with no matching enum value makes that write throw a Prisma error, which the
 * interceptor deliberately catches and logs — so the route works, the log line is easy to miss, and
 * the audit row is silently NEVER written. `api:imported` (WP24) and `plan:synced` (WP18) shipped
 * that way and were found only by looking for the missing row after a live import.
 *
 * Fix a failure here by using an existing action (`created`, `updated`, `sync_succeeded`, …) or by
 * adding the value to `AuditAction` in a forward-only migration — never by loosening this test.
 */

const LABEL = /@Audit\(\s*'([a-z_]+):([a-z_]+)'/g;
const ROOT = join(__dirname, '..', '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return name.endsWith('.ts') && !name.endsWith('.spec.ts') ? [path] : [];
  });
}

describe('@Audit action labels', () => {
  const valid = new Set<string>(Object.values(AuditAction));

  const labels = sourceFiles(ROOT).flatMap((path) =>
    [...readFileSync(path, 'utf8').matchAll(LABEL)].map((match) => ({
      file: path.slice(ROOT.length + 1),
      label: `${match[1]}:${match[2]}`,
      action: match[2].toUpperCase(),
    })),
  );

  it('finds the labels it is meant to check (a scan that finds nothing proves nothing)', () => {
    expect(labels.length).toBeGreaterThan(10);
    expect(labels.map((l) => l.label)).toContain('api:created');
  });

  it('maps every label to a value of the AuditAction enum', () => {
    const invalid = labels.filter((l) => !valid.has(l.action)).map((l) => `${l.file}: @Audit('${l.label}') -> ${l.action}`);

    expect(invalid).toEqual([]);
  });
});
