/**
 * OAS-08a contract (REV 2): the guarded OpenAPI spec fetcher.
 * Errors carry a fixed code and a fixed message — never the URL, a redirect
 * Location or any remote text.
 */

export type SpecFetchErrorCode =
  | 'BAD_URL'
  | 'BLOCKED_TARGET'
  | 'UNREACHABLE'
  | 'TIMEOUT'
  | 'TOO_LARGE'
  | 'TOO_MANY_REDIRECTS'
  | `HTTP_${number}`;

const MESSAGES: Record<string, string> = {
  BAD_URL: 'The spec URL is not a valid http(s) URL without credentials.',
  BLOCKED_TARGET: 'The spec URL is not reachable from here or not allowed.',
  UNREACHABLE: 'The spec host could not be reached.',
  TIMEOUT: 'Fetching the spec took too long.',
  TOO_LARGE: 'The spec is larger than the 5 MB limit.',
  TOO_MANY_REDIRECTS: 'The spec URL redirected too many times.',
};

export class SpecFetchError extends Error {
  constructor(readonly code: SpecFetchErrorCode) {
    super(MESSAGES[code] ?? 'The spec host answered with an unexpected HTTP status.');
    this.name = 'SpecFetchError';
  }
}

export interface SpecFetchOk {
  kind: 'OK';
  text: string;
  etag: string | null;
  lastModified: string | null;
}

export interface SpecFetchNotModified {
  kind: 'NOT_MODIFIED';
}

export interface SpecFetchConditions {
  etag?: string | null;
  lastModified?: string | null;
}

export interface SpecFetcherPort {
  /** Throws SpecFetchError. */
  fetch(url: string, cond?: SpecFetchConditions): Promise<SpecFetchOk | SpecFetchNotModified>;
  /** Same policy including DNS resolution. Throws SpecFetchError (BAD_URL | BLOCKED_TARGET). */
  validateUrl(url: string): Promise<void>;
}

export const SPEC_FETCHER = Symbol('SPEC_FETCHER');

/** `https://host[:port]/…` with no userinfo, path, query or fragment; '' on garbage. */
export function redactSpecUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return `${u.protocol}//${u.host}/…`;
  } catch {
    return '';
  }
}
