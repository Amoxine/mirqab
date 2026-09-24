import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware } from './middleware';

const req = (path: string) => new NextRequest(new URL(path, 'http://localhost:33000'));

describe('middleware', () => {
  it('lets an unauthenticated visitor reach the portal — a separate auth domain with no access_token cookie to ever carry (WP23)', () => {
    expect(middleware(req('/portal')).headers.get('location')).toBeNull();
    expect(middleware(req('/portal/auth/login')).headers.get('location')).toBeNull();
    expect(middleware(req('/portal/products/abc')).headers.get('location')).toBeNull();
  });

  it('still redirects an unauthenticated visitor away from a dashboard route', () => {
    const res = middleware(req('/apis'));
    expect(res.headers.get('location')).toContain('/oauth2/authorize');
  });
});
