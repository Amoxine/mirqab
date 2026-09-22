import { ForbiddenException, UnauthorizedException, NotFoundException, GoneException } from '@nestjs/common';
import type { ArgumentsHost } from '@nestjs/common';
import { AllExceptionsFilter, type ErrorResponse } from './all-exceptions.filter';

/** Minimal ArgumentsHost double that records what the filter wrote. */
function hostFor(): {
  host: ArgumentsHost;
  sent: () => { status: number; body: ErrorResponse; headers: Record<string, string> };
} {
  let status = 0;
  let body = {} as ErrorResponse;
  const headers: Record<string, string> = {};
  const response = {
    status(code: number) {
      status = code;
      return this;
    },
    json(payload: ErrorResponse) {
      body = payload;
    },
    setHeader(name: string, value: string) {
      headers[name] = value;
    },
  };

  return {
    host: {
      switchToHttp: () => ({
        getResponse: () => response,
        getRequest: () => ({ headers: {} }),
      }),
    } as unknown as ArgumentsHost,
    sent: () => ({ status, body, headers }),
  };
}

describe('AllExceptionsFilter', () => {
  const filter = new AllExceptionsFilter();

  it('derives error.code from the status when the exception body has no `error` field', () => {
    // What passport's AuthGuard throws: `{ statusCode: 401, message: 'Unauthorized' }`, no `error`.
    const { host, sent } = hostFor();
    filter.catch(new UnauthorizedException(), host);

    expect(sent().status).toBe(401);
    expect(sent().body.error.code).toBe('UNAUTHORIZED');
  });

  it('keeps Nest\'s own `error` string when one is present', () => {
    const { host, sent } = hostFor();
    filter.catch(new ForbiddenException('Missing permissions: audit:read'), host);

    expect(sent().status).toBe(403);
    expect(sent().body.error.code).toBe('Forbidden');
    expect(sent().body.error.message).toBe('Missing permissions: audit:read');
  });

  it('never reports a non-500 as INTERNAL_SERVER_ERROR', () => {
    const { host, sent } = hostFor();
    filter.catch(new NotFoundException(), host);

    expect(sent().status).toBe(404);
    expect(sent().body.error.code).not.toBe('INTERNAL_SERVER_ERROR');
  });

  it('hides the detail of an unexpected error behind a 500', () => {
    const { host, sent } = hostFor();
    filter.catch(new Error('connect ECONNREFUSED 10.0.0.5:5432'), host);

    expect(sent().status).toBe(500);
    expect(sent().body.error.code).toBe('INTERNAL_SERVER_ERROR');
    expect(sent().body.error.message).toBe('Internal server error');
  });

  it('adds a Sunset header for an exception carrying a sunsetAt date (WP16 retired versions)', () => {
    const { host, sent } = hostFor();
    class RetiredVersionException extends GoneException {
      constructor(readonly sunsetAt: Date) {
        super('gone');
      }
    }
    filter.catch(new RetiredVersionException(new Date('2026-01-01T00:00:00Z')), host);

    expect(sent().status).toBe(410);
    expect(sent().headers.Sunset).toBe('Thu, 01 Jan 2026 00:00:00 GMT');
  });

  it('adds no Sunset header for an ordinary exception', () => {
    const { host, sent } = hostFor();
    filter.catch(new NotFoundException(), host);

    expect(sent().headers.Sunset).toBeUndefined();
  });
});
