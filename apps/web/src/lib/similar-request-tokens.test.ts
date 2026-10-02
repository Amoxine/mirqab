import { describe, expect, it } from 'vitest';
import { SEARCH_LIMITS } from '@/lib/traffic-search';
import { similarActions, type SimilarAction } from './similar-request-tokens';

const API_ID = '6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f';
const request = { path: '/orders/42', status: 502, apiId: API_ID as string | null, keyAlias: 'qbus-web' };
const byKind = (actions: SimilarAction[]) => Object.fromEntries(actions.map((a) => [a.kind, a]));

describe('similarActions', () => {
  it('offers the same path, status, API and key, as tokens the bar accepts', () => {
    expect(similarActions(request, [])).toEqual([
      { kind: 'path', token: 'path:/orders/42', blocked: null },
      { kind: 'status', token: 'status:502', blocked: null },
      { kind: 'api', token: `api:${API_ID}`, blocked: null },
      { kind: 'key', token: 'key:qbus-web', blocked: null },
    ]);
  });

  it('quotes a key alias that has a space', () => {
    expect(byKind(similarActions({ ...request, keyAlias: 'my key' }, [])).key?.token).toBe('key:"my key"');
  });

  describe('blocks what cannot be a filter', () => {
    it.each<[string, Partial<typeof request>, keyof ReturnType<typeof byKind>]>([
      ['a request with no API', { apiId: null }, 'api'],
      ['an anonymous request (no key alias)', { keyAlias: '' }, 'key'],
      ['an alias with a double quote (the bar has no escape)', { keyAlias: 'a"b' }, 'key'],
      ['a path of fewer than 3 letters or digits', { path: '/a' }, 'path'],
      ['a path with a double quote', { path: '/a"b/orders' }, 'path'],
    ])('%s', (_name, patch, kind) => {
      expect(byKind(similarActions({ ...request, ...patch }, []))[kind]).toMatchObject({ token: null, blocked: 'unsupported' });
    });

    it('and leaves the others available', () => {
      const actions = byKind(similarActions({ ...request, apiId: null }, []));
      expect(actions.path?.blocked).toBeNull();
      expect(actions.status?.blocked).toBeNull();
    });
  });

  it('blocks a filter that is already in the search', () => {
    const actions = byKind(similarActions(request, ['status:502', 'path:/orders/42']));
    expect(actions.status).toMatchObject({ token: 'status:502', blocked: 'present' });
    expect(actions.path).toMatchObject({ blocked: 'present' });
    expect(actions.api?.blocked).toBeNull();
  });

  it('blocks every action once the search is at the clause cap', () => {
    const full = Array.from({ length: SEARCH_LIMITS.maxClauses }, (_, i) => `latency:>${String(i + 1)}`);
    expect(similarActions(request, full).map((a) => a.blocked)).toEqual(['full', 'full', 'full', 'full']);
  });

  it('still allows an action when there is exactly one clause of room', () => {
    const almost = Array.from({ length: SEARCH_LIMITS.maxClauses - 1 }, (_, i) => `latency:>${String(i + 1)}`);
    expect(similarActions(request, almost).map((a) => a.blocked)).toEqual([null, null, null, null]);
  });

  it('reports a duplicate as present even when the search is full', () => {
    const full = ['status:502', ...Array.from({ length: SEARCH_LIMITS.maxClauses - 1 }, (_, i) => `latency:>${String(i + 1)}`)];
    expect(byKind(similarActions(request, full)).status?.blocked).toBe('present');
  });
});
