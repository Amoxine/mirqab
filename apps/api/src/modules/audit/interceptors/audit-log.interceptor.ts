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

/**
 * Header names that carry a credential even when they match no key pattern above (`Cookie`, an
 * `X-…-Key` / `-Token` / `-Secret` convention). Used only for the NAME of a `{ name, value }` pair.
 */
const SENSITIVE_HEADER_NAME = /^(authorization|proxy-authorization|cookie|set-cookie|x-.*(key|token|secret))$/i;

/**
 * A `{ name, value }` pair is how headers travel in a body (`config.transformRequestHeaders.add[]`),
 * so the secret sits under the key `value`, which no key pattern catches: its sensitivity is in the
 * sibling `name`. True when this object is such a pair with a sensitive name.
 */
function isSensitivePair(value: object): boolean {
  const { name } = value as { name?: unknown };
  return (
    typeof name === 'string' && 'value' in value && (SENSITIVE_KEY.test(name) || SENSITIVE_HEADER_NAME.test(name))
  );
}

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

/** Nesting kept in an audit row; anything deeper is replaced, so a hostile body cannot overflow the stack. */
const REDACT_MAX_DEPTH = 32;
/** Largest request body stored in an audit row; a longer one is kept as a marked, truncated preview. */
const AUDIT_BODY_MAX_BYTES = 16_384;

/** Longest string treated as one URL (the spec fetcher's own limit). */
const MAX_URL_LENGTH = 2048;
const URL_IN_TEXT = /https?:[^\s"'<>]+/gi;
const HAS_URL = /https?:[^\s"'<>]+/i;
/** The WHATWG parser deletes these anywhere in its input, so `ht\ttps://…` is a URL to it. */
const TAB_OR_NEWLINE = /[\t\n\r]/g;

/**
 * How a URL found in audited data is kept: `strip` = without userinfo, query and fragment (OAS-08 C1);
 * `origin` = `https://host/…` only, for routes whose URL is a spec URL (its path can carry the secret);
 * `drop` = `[URL]`, for error text.
 */
type UrlMode = 'strip' | 'origin' | 'drop';

/** The parser's own reading of `value` when it is an http(s) URL — the same `new URL()` the fetcher uses. */
function asHttpUrl(value: string): URL | null {
  if (value.length > MAX_URL_LENGTH) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

function keep(url: URL | null, mode: UrlMode): string {
  if (url === null || mode === 'drop') return '[URL]';
  if (mode === 'origin') return `${url.protocol}//${url.host}/…`;
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  return url.href;
}

/**
 * A string that parses as an http(s) URL (in any spelling the parser accepts: leading blanks,
 * `https:host`, backslashes, upper case), or that contains one, loses what `mode` removes. A secret can
 * sit under a key no name pattern would catch (`url`, `proxyUrl`, a free-text note).
 */
function redactUrls(value: string, mode: UrlMode): string {
  const whole = asHttpUrl(value);
  if (whole) return keep(whole, mode);
  const flat = value.replace(TAB_OR_NEWLINE, '');
  if (!HAS_URL.test(flat)) return value;
  return flat.replace(URL_IN_TEXT, (match) => keep(asHttpUrl(match), mode));
}

/** Audit rows are permanent and exportable: never store credentials from request bodies. */
function redact(value: unknown, mode: UrlMode, depth = 0): unknown {
  if (typeof value === 'string') return redactUrls(value, mode);
  if (depth >= REDACT_MAX_DEPTH && value !== null && typeof value === 'object') return '[TRUNCATED]';
  if (Array.isArray(value)) return value.map((item) => redact(item, mode, depth + 1));
  if (value && typeof value === 'object') {
    const sensitivePair = isSensitivePair(value);
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        SENSITIVE_KEY.test(k) || (sensitivePair && k === 'value') ? '[REDACTED]' : redact(v, mode, depth + 1),
      ]),
    );
  }
  return value;
}

/** OAS-08: the routes whose body carries a spec URL. Only its origin is kept. */
// Case-insensitive, optional trailing slash: Express routes `/Spec-Source/` to the same handler.
const SPEC_URL_ROUTE = /\/(spec-source|import\/url(\/preview)?)\/?$/i;

/** The redacted body, or — past the size cap — a marked preview of it (still redacted). */
function auditBody(body: unknown, mode: UrlMode): unknown {
  const redacted = redact(body, mode);
  const json = redacted === undefined ? 'null' : JSON.stringify(redacted);
  const bytes = Buffer.byteLength(json, 'utf8');
  if (bytes <= AUDIT_BODY_MAX_BYTES) return redacted;
  return { truncated: true, bytes, preview: json.slice(0, AUDIT_BODY_MAX_BYTES) };
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
      details.requestBody = auditBody(request.body, SPEC_URL_ROUTE.test(request.path) ? 'origin' : 'strip');
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
                  // A 5xx message may quote a URL (and its secret): never stored, whatever its shape.
                  error: redactUrls(error.message, 'drop'),
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
