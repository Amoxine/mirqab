/**
 * The origin-check core of `hydra-admin.ts`'s `sanitizeReturnTo`, pulled out so it can be used from
 * client components too — see below for why that's necessary and why it's a separate function
 * rather than importing `sanitizeReturnTo` itself. No `next/server` or `@ory/client-fetch` import
 * here, and none may be added: this file's whole reason to exist is being safe for a `'use client'`
 * bundle to pull in.
 *
 * Parsing and comparing origins, not blocklisting characters, is the only check that can't drift
 * from what actually resolves the URL — see the caller-facing docs below for the concrete bypasses
 * a string check misses. `origin` must be a real, already-known-safe origin (or an absolute URL to
 * derive one from) — never itself derived from the value being sanitized.
 */
export function sanitizeToOrigin(raw: string | null | undefined, origin: string): string {
  if (!raw) return '/';
  let resolved: URL;
  let base: URL;
  try {
    base = new URL(origin);
    resolved = new URL(raw, base);
  } catch {
    return '/';
  }
  if (resolved.origin !== base.origin) return '/';
  // Idempotent, not just correct: `resolved.pathname` can itself start with `//` (`origin//evil.com`
  // parses as same-origin, path `//evil.com`), and a leading `//` in what comes back is exactly what
  // makes a LATER `new URL(x, base)` read `x` as protocol-relative. Collapsing it here means this
  // function is safe even if some future caller sanitizes only once before redirecting.
  return resolved.pathname.replace(/^\/+/, '/') + resolved.search + resolved.hash;
}

/**
 * For client components that navigate the browser directly with a value Kratos handed back
 * (`flow.return_to`, `redirect_browser_to`) — `login`/`register` pages' `onSuccess`, and
 * `KratosFlowForm`'s `redirect` outcome.
 *
 * These do NOT reuse `hydra-admin.ts`'s `sanitizeReturnTo`, for two reasons, not one:
 *  1. That module instantiates the Hydra admin client and reads `HYDRA_ADMIN_URL` — importing it
 *     from a `'use client'` component would ship the unauthenticated admin API's URL and SDK into
 *     the browser bundle, the exact thing that module's own header comment forbids.
 *  2. Even just its `APP_URL` constant would be WRONG here if reused as-is: it resolves from
 *     `process.env.APP_URL`, a plain (non-`NEXT_PUBLIC_`) runtime var, which Next does not expose to
 *     the browser — code bundled for the client would silently see it as unset and fall through to
 *     a hardcoded default, correct only by coincidence on a deployment that happens to match it.
 *     `window.location.origin` needs no build-time config and cannot be wrong: the code calling it
 *     is, by definition, already running on the app's real origin.
 *
 * Why this exists at all, i.e. what Kratos's own validation does not cover: Kratos checks
 * `return_to` against `allowed_return_urls` with Go's `net/url`, but the browser resolves the SAME
 * string with the WHATWG parser, and the two disagree on some inputs — `http:/\/\evil.com` reads as
 * scheme `http`, empty host to Go (passes Kratos's check) but as origin `http://evil.com` to WHATWG
 * (what `window.location.href = ...` actually does with it). Trusting Kratos's check alone means
 * trusting a parser that isn't the one with the final say. Re-checking with the parser that matters,
 * on this origin, is what closes that gap — server-side validation stays useful defence in depth,
 * it just cannot be the only check.
 */
export function sanitizeClientReturnTo(raw: string | null | undefined): string {
  return sanitizeToOrigin(raw, window.location.origin);
}
