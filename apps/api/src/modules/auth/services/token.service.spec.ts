/**
 * DEPRECATED — covers token.service.ts, itself dead since the Ory cutover (WP2). Still green, so it
 * stays green; it guards nothing reachable. Kept for history, not deleted (WP7 decision,
 * 2026-09-20); delete it in the same pass as the service.
 */
import type { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { TokenService } from './token.service';

describe('TokenService', () => {
  const jwtService = new JwtService({ secret: 'a'.repeat(40), signOptions: { expiresIn: '15m' } });
  const configService = { get: (_key: string, fallback: string) => fallback } as unknown as ConfigService;
  const service = new TokenService(jwtService, configService);

  it('issues a distinct refresh token on every call, even within the same second', () => {
    // `iat`/`exp` only have second resolution, so without a per-token claim two refresh tokens signed
    // in the same second were byte-identical and rotation silently kept the old cookie valid.
    const tokens = new Set(Array.from({ length: 50 }, () => service.generateRefreshToken('user-1')));

    expect(tokens.size).toBe(50);
  });

  it('keeps the refresh token verifiable and carrying its subject', () => {
    const token = service.generateRefreshToken('user-1');

    expect(service.verifyRefreshToken(token).sub).toBe('user-1');
  });
});
