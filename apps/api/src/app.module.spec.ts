import 'reflect-metadata';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Controller, Get, INestApplication, Injectable, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { PassportStrategy } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { Public } from './common/decorators/public.decorator';

/**
 * A bare passport-jwt strategy, standing in for the real one (modules/auth/strategies/jwt.strategy.ts)
 * purely so AuthGuard('jwt') has a 'jwt' strategy registered to delegate to. Deliberately NOT the real
 * JwtStrategy: that one now verifies Hydra-issued tokens against a live JWKS endpoint and resolves a
 * session via AuthService/Postgres (WP2) — none of which this test needs or should depend on. This
 * spec is only about app.module.ts's APP_GUARD wiring, not token verification.
 */
@Injectable()
class FakeJwtStrategy extends PassportStrategy(Strategy) {
  constructor() {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: 'fake-secret-for-app-module-spec-only',
    });
  }

  validate(payload: unknown): unknown {
    return payload;
  }
}

/**
 * Stands in for "whatever controller forgets @UseGuards(...)" — before JwtAuthGuard was registered
 * as a global APP_GUARD (app.module.ts), a controller like this was reachable with zero auth checks.
 * It carries no guard decorator of its own on purpose: only the global provider below should protect
 * it.
 */
@Controller('probe')
class UnguardedProbeController {
  @Get('secret')
  secret(): { ok: true } {
    return { ok: true };
  }

  @Public()
  @Get('open')
  open(): { ok: true } {
    return { ok: true };
  }
}

@Module({
  controllers: [UnguardedProbeController],
  providers: [FakeJwtStrategy, { provide: APP_GUARD, useClass: JwtAuthGuard }],
})
// A Nest module is a decorator-only class by design; the rule cannot see @Module's metadata.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
class ProbeModule {}

describe('JwtAuthGuard as a global APP_GUARD', () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [ProbeModule] }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
    await app.listen(0);
    // getHttpServer() is typed `any` on INestApplication; the cast is to the real underlying type,
    // which is what makes .address() itself properly typed (no cast needed on that call).
    const server = app.getHttpServer() as Server;
    const address: AddressInfo | string | null = server.address();
    const port = typeof address === 'string' ? address : address?.port;
    baseUrl = `http://127.0.0.1:${String(port)}`;
  });

  afterAll(async () => {
    await app.close();
  });

  it('401s a route on a controller with no @UseGuards() of its own', async () => {
    const res = await fetch(`${baseUrl}/probe/secret`);
    expect(res.status).toBe(401);
  });

  it('still exempts a route explicitly marked @Public()', async () => {
    const res = await fetch(`${baseUrl}/probe/open`);
    expect(res.status).toBe(200);
  });
});
