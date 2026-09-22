/**
 * Silent session refresh for API calls. The access-token cookie is a short-lived Hydra JWT; a 401
 * on a data request usually means it just expired while the refresh-token cookie is still good.
 * Deliberately free of `@/` imports so it can be unit-tested with a mocked `fetch`.
 */

/** Same-origin route (apps/web/src/app/oauth2/refresh/route.ts) — it holds the Hydra client
 * config and does the refresh_token grant itself, so this is never `${apiUrl}/...`. */
const REFRESH_PATH = '/oauth2/refresh';

let inFlight: Promise<boolean> | null = null;

/**
 * Refresh tokens are single-use and rotate, so two parallel refreshes would make the second one
 * present an already-spent token and fail: every concurrent caller shares one request.
 *
 * ponytail: known gap, no test — a request that 401s while a refresh IS in flight but doesn't call
 * this function until just after that refresh's `.finally` has nulled `inFlight` (its own fetch was
 * simply slower) starts a second, independent refresh instead of joining the first, exactly like
 * the "fresh refresh after settle" case this file's test asserts as intended. The two are
 * indistinguishable from here, so this is unavoidable without threading a "which refresh generation
 * was I waiting on" token through every caller — more machinery than the risk (a narrow, browser-
 * cookie-timing-dependent chance the second refresh fails because the first already rotated the
 * token) has earned so far. Upgrade path if it does: have callers capture the in-flight promise (or
 * lack of one) at 401-time, not at refreshSession()-call-time.
 */
function refreshSession(): Promise<boolean> {
  inFlight ??= fetch(REFRESH_PATH, { method: 'POST', credentials: 'include' })
    .then((res) => res.ok)
    .catch(() => false)
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/**
 * `fetch(apiUrl + path)` that, on a 401, refreshes the session once and replays the request once.
 * Returns the original 401 when the refresh fails and the replay's response otherwise (even if it is
 * a 401 again), so the caller decides what an unauthenticated user sees. `init.body` must be
 * replayable (a string), which is all this app sends.
 */
export async function fetchWithRefresh(apiUrl: string, path: string, init: RequestInit): Promise<Response> {
  const url = `${apiUrl}${path}`;
  const res = await fetch(url, init);

  if (res.status !== 401) return res;
  if (!(await refreshSession())) return res;

  return fetch(url, init);
}
