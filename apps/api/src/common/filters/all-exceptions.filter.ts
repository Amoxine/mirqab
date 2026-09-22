import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

/** A header can arrive repeated, in which case express hands back an array. */
const firstHeader = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

/**
 * An exception that also wants an RFC 8594 `Sunset` header on the response — WP16's retired API
 * versions (`GET /apis/:id` on a RETIRED row, `RetiredVersionException`). Duck-typed rather than an
 * `instanceof` check so this filter (common/) never has to import a feature module's exception class.
 */
interface HasSunsetHeader {
  sunsetAt: Date;
}
const hasSunsetHeader = (x: unknown): x is HasSunsetHeader =>
  typeof x === 'object' && x !== null && (x as { sunsetAt?: unknown }).sunsetAt instanceof Date;

export interface ErrorResponse {
  success: false;
  error: {
    code: string;
    /** A string, or the array of messages Nest's ValidationPipe produces for a 400. */
    message: string | string[];
    details?: Record<string, string[]>;
    traceId?: string;
  };
}

/** The shape Nest puts in an HttpException's response body. Every field is optional in practice. */
interface HttpExceptionBody {
  message?: string | string[];
  error?: string;
  details?: Record<string, string[]>;
}

/**
 * Fallback `error.code` for an exception whose body carries no `error` field.
 *
 * `new UnauthorizedException()` (what passport's AuthGuard throws) produces `{ statusCode, message }`
 * and nothing else, so the code used to stay at its INTERNAL_SERVER_ERROR initialiser and every 401
 * was reported to clients as a server error.
 */
export function statusCodeName(status: number): string {
  return HttpStatus[status] ?? 'HTTP_ERROR';
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = 'INTERNAL_SERVER_ERROR';
    let message: string | string[] = 'Internal server error';
    let details: Record<string, string[]> | undefined;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      code = statusCodeName(status);
      const responseBody = exception.getResponse();

      if (typeof responseBody === 'string') {
        message = responseBody;
      } else {
        const body = responseBody as HttpExceptionBody;
        message = body.message ?? message;
        code = body.error ?? code;
        details = body.details;
      }
    }

    // Don't expose internal errors in production
    if (status === HttpStatus.INTERNAL_SERVER_ERROR) {
      message = 'Internal server error';
      this.logger.error(
        `Internal error: ${exception instanceof Error ? (exception.stack ?? exception.message) : String(exception)}`,
      );
    }

    const errorResponse: ErrorResponse = {
      success: false,
      error: {
        code,
        message,
        details,
        traceId: firstHeader(request.headers['x-correlation-id']),
      },
    };

    if (hasSunsetHeader(exception)) {
      response.setHeader('Sunset', exception.sunsetAt.toUTCString());
    }
    response.status(status).json(errorResponse);
  }
}
