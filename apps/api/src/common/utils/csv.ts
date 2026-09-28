/**
 * RFC4180 cell: always quoted, embedded quotes doubled.
 *
 * A cell starting with `=`, `+`, `-` or `@` is executed as a formula when the file is opened in
 * Excel or Sheets, so an attacker who gets a crafted string into an exported field (a resource name,
 * a user agent) could run it on whoever downloads the export. A leading apostrophe defuses it.
 *
 * Dependency-free on purpose: both `AuditService`'s and `AnalyticsService`'s CSV exports use it, and
 * each used to import it from the other's module (`analytics.service.ts` from `audit.service.ts`) —
 * once `AuditService` also gained a constructor dependency on `AnalyticsService` (V1-LOG-01), that
 * became a real two-file import cycle. Nest's DI happened to still resolve it under this app's
 * current bootstrap import order, but that was order-dependent, not structurally safe. Living here,
 * with no imports of its own, removes the cycle outright rather than papering over it.
 */
export function csvCell(value: string | null | undefined): string {
  const raw = value ?? '';
  const safe = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return `"${safe.replace(/"/g, '""')}"`;
}
