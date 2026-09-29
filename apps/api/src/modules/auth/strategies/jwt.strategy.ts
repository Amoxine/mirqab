import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { kidOf, resolveSigningKey } from '../../../common/ory/jwks';
import { AuthService } from '../services/auth.service';
import type { UserPayload } from '../../../common/types';

/**
 * The dashboard's access token travels in an httpOnly cookie; machine callers use a bearer header.
 * The name is `mq_`-prefixed (matches apps/web `cookie-names.ts`) so it cannot collide with another
 * app's `access_token` cookie on the same host.
 */
const fromAccessTokenCookie = (request: Request): string | null =>
  (request.cookies as Record<string, string | undefined> | undefined)?.mq_access_token ?? null;

/** A header can arrive repeated, in which case express hands back an array. */
const firstHeader = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

/**
 * Verifies Hydra-issued access tokens against Hydra's JWKS, then resolves the session from Postgres.
 *
 * Tokens are no longer signed by this app, so there is no shared secret to hold: the signature is
 * checked against the rotating public key Hydra publishes, and `iss` must be the issuer Hydra
 * stamps (`ORY_HYDRA_ISSUER`, e.g. http://localhost:33010/ — the browser-facing URL, NOT the
 * in-network http://hydra:4444 the JWKS itself is fetched from).
 *
 * Audience is deliberately not verified: Hydra issues `aud: []` unless a client requests one
 * (verified against v26.2.0), so an audience check would reject every token the dashboard holds.
 * WP4's data-plane tokens are validated by Tyk, not here.
 *
 * The token carries no tenant/role/permission claims (Hydra's token hook is off), so everything the
 * guards need is resolved per request — which also means a suspended user or a revoked membership
 * takes effect immediately instead of at the end of the token's TTL.
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(configService: ConfigService, private readonly authService: AuthService) {
    /* eslint-disable @typescript-eslint/no-unnecessary-type-arguments --
       ConfigService.get types its default as NoInferType<T>, so without the explicit argument T
       falls back to `any` (same reason as in main.ts and auth.module.ts). */
    const publicUrl = configService.get<string>('ORY_HYDRA_PUBLIC_URL', 'http://hydra:4444');
    const jwksUri = new URL('/.well-known/jwks.json', publicUrl).toString();

    super({
      jwtFromRequest: ExtractJwt.fromExtractors([
        fromAccessTokenCookie,
        ExtractJwt.fromAuthHeaderAsBearerToken(),
      ]),
      ignoreExpiration: false,
      algorithms: ['RS256'],
      issuer: configService.get<string>('ORY_HYDRA_ISSUER', 'http://localhost:33010/'),
      /* eslint-enable @typescript-eslint/no-unnecessary-type-arguments */
      secretOrKeyProvider: (_request, rawJwt: string, done) => {
        void (async () => {
          try {
            done(null, await resolveSigningKey(jwksUri, kidOf(rawJwt)));
          } catch (error) {
            done(error);
          }
        })();
      },
      passReqToCallback: true,
    });
  }

  /**
   * Signature, expiry and issuer are already verified here. What is left is turning the subject
   * into the session the guards read: `X-Tenant-ID` selects which of the caller's tenants is active
   * (TenantIsolationGuard then rejects the mismatch when the header names one they are not in).
   */
  async validate(request: Request, payload: { sub?: unknown }): Promise<UserPayload> {
    if (typeof payload.sub !== 'string') {
      throw new UnauthorizedException('Token has no subject');
    }

    const session = await this.authService.resolveSession(
      payload.sub,
      firstHeader(request.headers['x-tenant-id']),
    );

    if (!session) {
      // No user row for this subject (e.g. a client_credentials token meant for the data plane), or
      // the account is no longer active.
      throw new UnauthorizedException('Session is no longer valid');
    }

    return session;
  }
}
