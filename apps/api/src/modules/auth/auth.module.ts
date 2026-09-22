import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { AuthService } from './services/auth.service';
import { AuthController } from './controllers/auth.controller';
import { JwtStrategy } from './strategies/jwt.strategy';

@Module({
  imports: [
    PassportModule.register({ defaultStrategy: 'jwt' }),
    // No JwtModule: this app no longer signs tokens. Hydra issues them and JwtStrategy verifies
    // them against Hydra's JWKS, so there is no secret and no signing configuration left here.
    //
    // No ThrottlerModule.forRoot() either: a second registration silently replaced app.module.ts's
    // for the WHOLE app. Throttling is configured once in app.module.ts.
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy],
  exports: [AuthService, PassportModule],
})
// A Nest module is a decorator-only class by design; the rule cannot see @Module's metadata.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class AuthModule {}
