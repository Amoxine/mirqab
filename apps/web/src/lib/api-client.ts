import type { ApiSuccessResponse, ApiErrorResponse } from '@/types';
import { fetchWithRefresh } from './refresh-retry';
import { getActiveTenantId } from './active-tenant';
// Relative, not `@/...`: this file has no other alias imports at runtime (only `import type`s,
// which vanish at compile time) and stays that way so it keeps working under vitest, which has no
// `@` alias configured.
import { toast } from '../components/ui/sonner';

// An unset OR empty NEXT_PUBLIC_API_URL must fall back, so this is not a `??`.
const configuredApiUrl = process.env.NEXT_PUBLIC_API_URL ?? '';
const API_URL = configuredApiUrl === '' ? 'http://localhost:33001/api' : configuredApiUrl;

const PRE_AUTH_PREFIXES = ['/auth', '/oauth2'];
/** A page a signed-out visitor is allowed to see a 401 on without being bounced mid-flow. Segment-
 * aware (not a bare `startsWith`) so a future route like `/authors` isn't swept in by accident. */
const isPreAuthPage = (pathname: string): boolean =>
  PRE_AUTH_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));

/** sessionStorage key + window for the re-auth loop guard below. */
const REAUTH_ATTEMPT_KEY = 'reauth-attempted-at';
const REAUTH_WINDOW_MS = 5000;

/**
 * True once per `REAUTH_WINDOW_MS` (and records the attempt); false on any further call within
 * the window. Without this, a 401 that survives a full, freshly-completed `/oauth2/authorize`
 * round trip (deleted user row, JWKS rotation, issuer mismatch, clock skew...) would send the
 * browser straight back through the same redirect at network speed, forever, with nothing on
 * screen. Exported for its unit test.
 */
export function canAttemptReauth(): boolean {
  try {
    const last = sessionStorage.getItem(REAUTH_ATTEMPT_KEY);
    if (last !== null && Date.now() - Number(last) < REAUTH_WINDOW_MS) return false;
    sessionStorage.setItem(REAUTH_ATTEMPT_KEY, String(Date.now()));
    return true;
  } catch {
    return true; // sessionStorage unavailable (private mode, etc.) — don't block re-auth over it
  }
}

/** A non-2xx API answer. Callers branch on `status` (404, 403, 409...), never on the message text. */
export class ApiRequestError extends Error {
  status: number;
  /** The API's machine code (`error.code`, e.g. `SPEC_VERSION_STALE`) when the body carried one. */
  code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    if (code) this.code = code;
  }
}

/**
 * Turns a non-2xx response into an `ApiRequestError`. A 401 that survives the silent refresh (see
 * `fetchWithRefresh`) also sends the user back through sign-in. On a pre-auth page itself a 401 is
 * just "wrong credentials" or "not signed in yet": no redirect (it would reload the page and drop
 * the error), so the API's own message is shown instead.
 */
async function toRequestError(res: Response): Promise<ApiRequestError> {
  if (res.status === 401 && typeof window !== 'undefined' && !isPreAuthPage(window.location.pathname)) {
    if (canAttemptReauth()) {
      // Re-runs the full OAuth2 dance, not a bare redirect to /auth/login: a dead access token also
      // means the Hydra session is gone, and only /oauth2/authorize can mint a fresh one. Carries
      // `return_to` so the user lands back where they were, same as `middleware.ts`.
      const authorizeUrl = new URL('/oauth2/authorize', window.location.origin);
      authorizeUrl.searchParams.set('return_to', window.location.pathname + window.location.search);
      window.location.href = authorizeUrl.toString();
    } else {
      // We already redirected through a full re-auth round trip moments ago and landed right back
      // on a 401: re-authenticating isn't fixing this, so stop looping and say something instead of
      // bouncing the user through Hydra silently forever.
      toast.error('Your session could not be renewed. Please sign in again.');
    }
    return new ApiRequestError('Unauthorized', 401);
  }
  // Not every error body carries `{ error: { message } }` (proxies, framework defaults): never throw a TypeError over it.
  const body = (await res.json().catch(() => null)) as Partial<ApiErrorResponse> | null;
  // class-validator failures arrive as a list of messages.
  const raw: unknown = body?.error?.message;
  const message = Array.isArray(raw) ? raw.join('; ') : raw;
  const code: unknown = body?.error?.code;
  return new ApiRequestError(
    typeof message === 'string' && message !== '' ? message : `HTTP ${String(res.status)}`,
    res.status,
    typeof code === 'string' ? code : undefined,
  );
}

/** The active-tenant header, or nothing — an absent header falls back to the caller's default
 * tenant server-side (`AuthService.resolveSession`'s `pickActiveTenant`), so omitting it is safe. */
function withTenantHeader(headers: Headers): void {
  const tenantId = getActiveTenantId();
  if (tenantId) headers.set('X-Tenant-ID', tenantId);
}

async function request<T>(path: string, options: RequestInit = {}): Promise<ApiSuccessResponse<T>> {
  // Built through Headers, not an object spread: HeadersInit may be a Headers instance or an
  // array of pairs, and spreading either of those yields numeric indices instead of headers.
  const headers = new Headers({ 'Content-Type': 'application/json' });
  new Headers(options.headers).forEach((value, key) => {
    headers.set(key, value);
  });
  withTenantHeader(headers);

  const res = await fetchWithRefresh(API_URL, path, { ...options, credentials: 'include', headers });

  if (!res.ok) throw await toRequestError(res);

  const body: unknown = await res.json();
  // The API is not uniform: some routes return { success, data }, others the bare payload
  // ({ data, meta } lists, plain objects). Normalise so callers can always read `.data`.
  if (typeof body === 'object' && body !== null && 'success' in body) {
    return body as ApiSuccessResponse<T>;
  }
  return { success: true, data: body as T };
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  /** `signal` lets a caller that no longer wants the answer (a query that was cancelled) abort the request itself. */
  post: <T>(path: string, body: unknown, options: { signal?: AbortSignal } = {}) =>
    request<T>(path, { method: 'POST', body: JSON.stringify(body), ...(options.signal ? { signal: options.signal } : {}) }),
  put: <T>(path: string, body: unknown) => request<T>(path, { method: 'PUT', body: JSON.stringify(body) }),
  patch: <T>(path: string, body: unknown) => request<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
  /** POST a raw text body (an OpenAPI document, JSON or YAML) instead of a JSON-encoded value. */
  postRaw: <T>(path: string, body: string, contentType: string) =>
    request<T>(path, { method: 'POST', body, headers: { 'Content-Type': contentType } }),
  /** GET a non-JSON body (e.g. a CSV export); `request()` always parses JSON, so it cannot carry one. */
  getBlob: async (path: string): Promise<Blob> => {
    const headers = new Headers();
    withTenantHeader(headers);
    const res = await fetchWithRefresh(API_URL, path, { credentials: 'include', headers });
    if (!res.ok) throw await toRequestError(res);
    return res.blob();
  },
};
