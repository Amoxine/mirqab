import { ApiRequestError } from './api-client';

/**
 * The portal's own API client — a separate, smaller sibling of `api-client.ts`, not a reuse of it.
 * Three real differences: no `X-Tenant-ID` header (a developer's tenant comes from their Kratos
 * session, never a header a caller could set), no Hydra-refresh-and-retry dance on 401
 * (`DeveloperAuthGuard` reads a Kratos session directly — there is no access/refresh token pair to
 * rotate), and a 401 sends the browser to `/portal/auth/login`, never `/oauth2/authorize` (the
 * dashboard's Hydra login). `ApiRequestError` itself IS reused — same shape, same meaning.
 */

// An unset OR empty NEXT_PUBLIC_API_URL must fall back, so this is not a `??`.
const configuredApiUrl = process.env.NEXT_PUBLIC_API_URL ?? '';
const API_URL = configuredApiUrl === '' ? 'https://localhost:33001/api' : configuredApiUrl;

interface ApiSuccessResponse<T> {
  success: true;
  data: T;
}
interface ApiErrorResponse {
  success: false;
  error: { message: string | string[] };
}

async function toRequestError(res: Response): Promise<ApiRequestError> {
  if (res.status === 401 && typeof window !== 'undefined') {
    window.location.href = `/portal/auth/login?return_to=${encodeURIComponent(window.location.pathname)}`;
  }
  const body = (await res.json().catch(() => null)) as Partial<ApiErrorResponse> | null;
  const raw: unknown = body?.error?.message;
  const message = Array.isArray(raw) ? raw.join('; ') : raw;
  return new ApiRequestError(
    typeof message === 'string' && message !== '' ? message : `HTTP ${String(res.status)}`,
    res.status,
  );
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  new Headers(options.headers).forEach((value, key) => {
    headers.set(key, value);
  });

  const res = await fetch(`${API_URL}${path}`, { ...options, credentials: 'include', headers });
  if (!res.ok) throw await toRequestError(res);

  const body = (await res.json()) as ApiSuccessResponse<T> | T;
  return typeof body === 'object' && body !== null && 'success' in body ? body.data : body;
}

export const portalApi = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body: unknown) => request<T>(path, { method: 'POST', body: JSON.stringify(body) }),
};

export { ApiRequestError };
