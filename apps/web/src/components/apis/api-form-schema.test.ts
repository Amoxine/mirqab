import { describe, expect, it } from 'vitest';
import type { ApiDefinition } from '@/hooks/use-apis';
import { makeApiFormSchema, toApiConfig, toCreatePayload, toFormInput, toUpdatePayload } from './api-form-schema';

// A stub translator: every assertion below checks validation OUTCOME (`.success`/`.data`), never
// message text, so any string here works.
const apiFormSchema = makeApiFormSchema((key) => key);

const api: ApiDefinition = {
  id: 'a1',
  name: 'Orders',
  slug: 'orders',
  status: 'ACTIVE',
  authType: 'AUTH_TOKEN',
  proxyUrl: 'http://orders:4000',
  listenPath: '/orders/',
  tykApiId: 'tyk-1',
  syncStatus: 'SYNCED',
  syncError: null,
  lastSyncedAt: null,
  config: {
    rateLimit: { rate: 100, per: 60 },
    cors: {
      enable: true,
      allowedOrigins: ['http://localhost:33000', 'https://app.example.com'],
      allowedMethods: ['GET', 'POST'],
      allowedHeaders: ['Authorization', 'Content-Type'],
      exposedHeaders: ['X-Request-Id'],
      allowCredentials: true,
      maxAge: 24,
    },
    doNotTrack: true,
  },
  createdAt: '2026-09-19T00:00:00.000Z',
  updatedAt: '2026-09-19T00:00:00.000Z',
};

describe('api form auth type', () => {
  it('keeps every configurable auth type when editing', () => {
    for (const authType of ['NONE', 'AUTH_TOKEN', 'OAUTH'] as const) {
      expect(toFormInput({ ...api, authType }).authType).toBe(authType);
    }
  });

  it('falls back to API Key for an auth type the form cannot configure (JWT)', () => {
    expect(toFormInput({ ...api, authType: 'JWT' }).authType).toBe('AUTH_TOKEN');
  });

  it('rejects an auth type outside the offered set', () => {
    const result = apiFormSchema.safeParse({ ...toFormInput(api), authType: 'JWT' });
    expect(result.success).toBe(false);
  });
});

describe('api form config mapping', () => {
  it('round-trips a stored config through the form unchanged', () => {
    const values = apiFormSchema.parse(toFormInput(api));
    expect(toApiConfig(values)).toEqual(api.config);
  });

  it('parses comma-separated lists, dropping blanks and whitespace', () => {
    const values = apiFormSchema.parse({
      ...toFormInput(api),
      corsAllowedOrigins: ' https://a.io ,, https://b.io ,',
      corsAllowedMethods: '',
    });
    expect(values.corsAllowedOrigins).toEqual(['https://a.io', 'https://b.io']);
    expect(values.corsAllowedMethods).toEqual([]);
  });

  it('defaults a new API to an unlimited, CORS-disabled config', () => {
    const values = apiFormSchema.parse({ ...toFormInput(), name: 'New', slug: 'new', proxyUrl: 'https://x.io' });
    expect(toCreatePayload(values).config).toMatchObject({
      rateLimit: { rate: 0, per: 60 },
      cors: { enable: false, allowedOrigins: [], maxAge: 0 },
      doNotTrack: false,
    });
  });

  it('never sends the slug on update', () => {
    const payload = toUpdatePayload(apiFormSchema.parse(toFormInput(api)));
    expect(payload).not.toHaveProperty('slug');
    expect(payload.proxyUrl).toBe('http://orders:4000');
  });

  it.each([
    ['rate below 0', { rateLimitRate: '-1' }],
    ['per below 1', { rateLimitPer: '0' }],
    ['non-numeric rate', { rateLimitRate: 'ten' }],
    ['non-http upstream', { proxyUrl: 'ftp://orders' }],
    ['non-URL upstream', { proxyUrl: 'orders' }],
    ['listen path without a leading slash', { listenPath: 'orders' }],
  ])('rejects %s', (_label, patch) => {
    expect(apiFormSchema.safeParse({ ...toFormInput(api), ...patch }).success).toBe(false);
  });
});
