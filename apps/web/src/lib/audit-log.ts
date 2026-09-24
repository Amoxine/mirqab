import { prisma } from '@open-gateway/database';
import { Prisma, type AuditAction } from '@open-gateway/database';

/**
 * Writes an `AuditLog` row directly (no NestJS `AuditService` here — this runs in apps/web's own
 * process, not apps/api's). Same shape `AuditService.record` writes in apps/api, so both apps'
 * rows read identically in `GET /audit-logs`. Used for LOGIN/LOGOUT (WP21): the only two audit
 * events whose actual moment of truth is a Next.js route handler, not a NestJS controller — Hydra
 * and Kratos own the auth flow, and this app is where their callbacks land (see oauth2/login and
 * oauth2/session-logout).
 *
 * Best-effort: an audit-log failure must never turn a successful login/logout into a visible error.
 */
export async function recordAuditLog(entry: {
  userId: string;
  action: AuditAction;
  resource: string;
  details?: Record<string, unknown>;
  ipAddress?: string | null;
}): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        tenantId: null, // login/logout happen before a tenant is selected for this session
        userId: entry.userId,
        action: entry.action,
        resource: entry.resource,
        details: entry.details ? (entry.details as Prisma.InputJsonObject) : Prisma.DbNull,
        ipAddress: entry.ipAddress ?? null,
        corrId: null,
      },
    });
  } catch (err) {
    // No NestJS Logger in this process; console.error is allowed by eslint.config.js for exactly this.
    console.error(`Failed to write audit log (${entry.action}):`, err);
  }
}
