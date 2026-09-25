import { describe, expect, it } from 'vitest';
import en from '@/messages/en/specSource.json';
import { ApiRequestError } from '@/lib/api-client';
import { fetchErrorKey, specErrorMessage, specUrlProblem } from './spec-source';

/** A stand-in for next-intl's `t`: resolves the key in the English catalog, fills `{status}`. */
const t = (key: string, values?: Record<string, string | number>) => {
  const text = key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown>)[part], en);
  if (typeof text !== 'string') throw new Error(`missing ${key}`);
  return text.replace(/\{(\w+)\}/g, (_, name: string) => String(values?.[name]));
};

describe('fetchErrorKey', () => {
  it.each([
    ['BAD_URL', 'errors.BAD_URL'],
    ['SPEC_FETCH_BAD_URL', 'errors.BAD_URL'],
    ['SPEC_FETCH_BLOCKED_TARGET', 'errors.BLOCKED_TARGET'],
    ['DNS_FAILED', 'errors.BLOCKED_TARGET'],
    ['SPEC_FETCH_UNREACHABLE', 'errors.UNREACHABLE'],
    ['TIMEOUT', 'errors.TIMEOUT'],
    ['SPEC_FETCH_TOO_LARGE', 'errors.TOO_LARGE'],
    ['TOO_MANY_REDIRECTS', 'errors.TOO_MANY_REDIRECTS'],
    ['NOT_A_SPEC', 'errors.NOT_A_SPEC'],
    ['SOMETHING_NEW', 'errors.unknown'],
    [null, 'errors.unknown'],
    // Only a 3-digit status is a status; anything else is not echoed as one.
    ['HTTP_12345', 'errors.unknown'],
  ])('%s -> %s', (code, key) => {
    expect(fetchErrorKey(code).key).toBe(key);
  });

  it('HTTP_<n> is one generic text carrying the number', () => {
    expect(fetchErrorKey('SPEC_FETCH_HTTP_503')).toEqual({ key: 'errors.HTTP', values: { status: 503 } });
    expect(fetchErrorKey('HTTP_404')).toEqual({ key: 'errors.HTTP', values: { status: 404 } });
  });

  it('every key it can return exists in the catalog', () => {
    for (const code of ['BAD_URL', 'BLOCKED_TARGET', 'UNREACHABLE', 'TIMEOUT', 'TOO_LARGE', 'TOO_MANY_REDIRECTS', 'NOT_A_SPEC', 'HTTP_500', 'X']) {
      const { key, values } = fetchErrorKey(code);
      expect(t(key, values)).not.toBe('');
    }
  });
});

describe('specErrorMessage', () => {
  it('never returns the server message, which could echo the URL', () => {
    const leak = 'https://h.example/spec?token=SECRET';
    for (const code of ['SPEC_FETCH_TIMEOUT', 'SPEC_CHECK_COOLDOWN', 'SPEC_VERSION_STALE', 'CANDIDATE_STALE', 'SPEC_GOVERNANCE_CHANGED', 'BAD_REQUEST']) {
      const text = specErrorMessage(t, new ApiRequestError(leak, 422, code), 'errors.saveFailed');
      expect(text).not.toContain('SECRET');
      expect(text).not.toContain('h.example');
    }
  });

  it('maps each code of this feature to its own text', () => {
    expect(specErrorMessage(t, new ApiRequestError('x', 429, 'SPEC_CHECK_COOLDOWN'), 'errors.checkFailed')).toBe(en.errors.SPEC_CHECK_COOLDOWN);
    expect(specErrorMessage(t, new ApiRequestError('x', 409, 'SPEC_REMOVES_GOVERNED_ENDPOINTS'), 'errors.applyFailed')).toBe(
      en.errors.SPEC_REMOVES_GOVERNED_ENDPOINTS,
    );
    expect(specErrorMessage(t, new ApiRequestError('x', 422, 'SPEC_FETCH_HTTP_401'), 'errors.saveFailed')).toBe(
      'The URL answered with HTTP status 401.',
    );
    expect(specErrorMessage(t, new ApiRequestError('x', 500), 'errors.saveFailed')).toBe(en.errors.saveFailed);
    for (const code of [
      'SPEC_SOURCE_LIMIT',
      'SPEC_SOURCE_URL_REQUIRED',
      'OAS_LINT_FAILED',
      'OAS_IMPORT_TOO_MANY_ENDPOINTS',
      'OAS_IMPORT_UNPARSEABLE',
      'OAS_IMPORT_UNSAFE_YAML',
      'OAS_IMPORT_UNSUPPORTED_VERSION',
      'OAS_IMPORT_UNUSABLE',
    ] as const) {
      expect(specErrorMessage(t, new ApiRequestError('server text', 422, code), 'errors.saveFailed')).toBe(en.errors[code]);
    }
    expect(specErrorMessage(t, new Error('network'), 'errors.saveFailed')).toBe(en.errors.saveFailed);
  });
});

describe('specUrlProblem', () => {
  it.each([
    ['https://specs.example.com/openapi.yaml?token=abc', null],
    ['http://10.0.0.5:8080/spec.json', null],
    ['', 'url.required'],
    ['   ', 'url.required'],
    ['not a url', 'url.invalid'],
    ['ftp://specs.example.com/spec', 'url.scheme'],
    ['file:///etc/passwd', 'url.scheme'],
    ['javascript:alert(1)', 'url.scheme'],
    ['https://user:pass@specs.example.com/spec', 'url.userinfo'],
    ['https://user@specs.example.com/spec', 'url.userinfo'],
    [`https://specs.example.com/${'a'.repeat(2048)}`, 'url.tooLong'],
  ])('%s -> %s', (value, problem) => {
    expect(specUrlProblem(value)).toBe(problem);
  });
});
