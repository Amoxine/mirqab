/**
 * DEPRECATED — dead since the Ory cutover (WP2). Nothing provides or injects this service any more:
 * Hydra issues tokens and strategies/jwt.strategy.ts verifies them against Hydra's JWKS, with
 * services/auth.service.ts resolving the session. Kept for history, not deleted (WP7 decision,
 * 2026-09-20); safe to delete in a future pass along with jwt-secret.ts, the login/register DTOs,
 * types/auth.types.ts, bcrypt and the JWT_SECRET env.
 */
import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService, JwtSignOptions } from '@nestjs/jwt';
import type { JwtPayload } from '../types/auth.types';

@Injectable()
export class TokenService {
  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  generateAccessToken(payload: JwtPayload): string {
    return this.jwtService.sign(payload);
  }

  /**
   * A refresh token is single-use: AuthService stores its digest and rotation replaces it.
   *
   * The `jti` is what makes rotation real. A `{ sub }` payload signs to the same bytes for the whole
   * second (`iat`/`exp` have one-second resolution), so a refresh that landed in the same second as
   * the login produced a byte-identical token — the digest never changed and the cookie the client
   * was supposed to discard kept working. Measured at 3 of 25 logins before this.
   */
  generateRefreshToken(userId: string): string {
    /* eslint-disable-next-line @typescript-eslint/no-unnecessary-type-arguments --
       ConfigService.get types its default as NoInferType<T>, so without the explicit argument T falls
       back to `any` (same reason as in main.ts); the cast then narrows it to the union
       JwtSignOptions accepts ('7d', 604800, ...). */
    const expiresIn = this.configService.get<string>(
      'JWT_REFRESH_EXPIRES_IN',
      '7d',
    ) as JwtSignOptions['expiresIn'];

    return this.jwtService.sign({ sub: userId, jti: randomUUID() }, { expiresIn });
  }

  verifyAccessToken(token: string): JwtPayload {
    try {
      return this.jwtService.verify<JwtPayload>(token);
    } catch {
      throw new Error('Invalid or expired access token');
    }
  }

  verifyRefreshToken(token: string): { sub: string } {
    try {
      return this.jwtService.verify<{ sub: string }>(token);
    } catch {
      throw new Error('Invalid or expired refresh token');
    }
  }
}
