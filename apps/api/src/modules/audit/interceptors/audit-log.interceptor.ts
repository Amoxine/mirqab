import { HttpException, Injectable, Logger } from '@nestjs/common';
import type { NestInterceptor, ExecutionContext, CallHandler } from '@nestjs/common';
import type { Observable } from 'rxjs';
import { tap } from 'rxjs';
import { Reflector } from '@nestjs/core';
import type { AuditAction } from '@prisma/client';
import type { Request } from 'express';
import { AuditService } from '../services/audit.service';
import { AUDIT_KEY } from '../../../common/decorators/audit.decorator';

const SENSITIVE_KEY = /pass(word)?|secret|token|authorization|api[-_]?key|credential/i;

/** A header can arrive repeated, in which case express hands back an array. */
const firstHeader = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

/** What JwtAuthGuard and TenantIsolationGuard attach to the request before this interceptor runs. */
interface AuditRequest extends Request {
  user?: { sub?: string };
  tenantId?: string;
}

/**
 * The part of a mutation's response body this interceptor reads: the id of a just-created entity,
 * and the sync outcome that `POST /apis/:id/sync` reports in the body instead of in its status.
 */
interface MutationResponse {
  id?: unknown;
  syncStatus?: unknown;
  syncError?: string | null;
}

/**
 * Express types `params` as a total record, so `params.id` looks like a `string` even on a route that
 * has no `:id` segment — at runtime it is simply absent.
 */
const routeId = (request: AuditRequest): string | undefined =>
  (request.params as Record<string, string | undefined>).id;

/** Audit rows are permanent and exportable: never store credentials from request bodies. */
function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, SENSITIVE_KEY.test(k) ? '[REDACTED]' : redact(v)]),
    );
  }
  return value;
}

@Injectable()
export class AuditLogInterceptor implements NestInterceptor {
  private readonly logger = new Logger(AuditLogInterceptor.name);

  constructor(
    private readonly auditService: AuditService,
    private readonly reflector: Reflector,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<AuditRequest>();
    const method = request.method;

    // Only log mutations
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      return next.handle();
    }

    const auditMeta = this.reflector.get<{ action: string } | undefined>(AUDIT_KEY, context.getHandler());
    if (!auditMeta?.action) {
      return next.handle();
    }

    // @Audit('api:created') -> AuditAction.CREATED
    const auditAction = (auditMeta.action.split(':').pop() ?? '').toUpperCase();

    const { user, tenantId } = request;
    const resource = request.path.replace(/^\/api\//, '').split('/')[0];
    const ipAddress = request.ip ?? firstHeader(request.headers['x-forwarded-for']);
    const correlationId = firstHeader(request.headers['x-correlation-id']);

    const details: Record<string, unknown> = {};
    if (method === 'PATCH' || method === 'PUT') {
      details.requestBody = redact(request.body);
    }

    return next.handle().pipe(
      tap({
        next: (body: unknown) => {
          const responseBody = (body ?? {}) as MutationResponse;

          // Rows used to read "keys / UPDATED" with nothing to identify the row that changed: the id
          // came from the route for DELETE only. A POST has no :id, so the created entity's own id is
          // used instead.
          const resourceId =
            routeId(request) ?? (typeof responseBody.id === 'string' ? responseBody.id : undefined);

          // `POST /apis/:id/sync` is decorated @Audit('api:sync_succeeded') and always answers 200,
          // reporting the real outcome in the body — a failed sync was recorded as SYNC_SUCCEEDED.
          const syncFailed = auditAction === 'SYNC_SUCCEEDED' && responseBody.syncStatus === 'FAILED';

          setImmediate(async () => {
            try {
              await this.auditService.record({
                tenantId,
                userId: user?.sub,
                // @Audit()'s suffix is contractually an AuditAction value; a typo surfaces as a
                // Prisma error caught just below rather than a silent skip.
                action: (syncFailed ? 'SYNC_FAILED' : auditAction) as AuditAction,
                resource,
                details: {
                  ...details,
                  ...(resourceId === undefined ? {} : { resourceId }),
                  ...(syncFailed ? { syncError: responseBody.syncError ?? null } : {}),
                },
                ipAddress,
                correlationId,
              });
            } catch (err) {
              this.logger.error(`Audit log write failed: ${(err as Error).message}`);
            }
          });
        },
        error: (error: Error) => {
          // A 4xx means the request was rejected before anything changed — a validation error or a
          // missing row is not a gateway sync failure, and logging it as one filled the audit trail
          // and the dashboard's recent activity with red SYNC_FAILED rows for ordinary 400s/404s.
          if (error instanceof HttpException && error.getStatus() < 500) return;

          setImmediate(async () => {
            try {
              await this.auditService.record({
                tenantId,
                userId: user?.sub,
                action: 'SYNC_FAILED',
                resource,
                details: {
                  error: error.message,
                  action: auditAction,
                  ...(routeId(request) === undefined ? {} : { resourceId: routeId(request) }),
                },
                ipAddress,
                correlationId,
              });
            } catch (err) {
              this.logger.error(`Audit log error write failed: ${(err as Error).message}`);
            }
          });
        },
      }),
    );
  }
}
