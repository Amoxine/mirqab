import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthService } from '../services/auth.service';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import type { UserPayload } from '../../../common/types';

/**
 * What is left of the local auth module after the Ory cutover.
 *
 * Login, registration, refresh and logout are Ory's now: the browser talks to Kratos (credentials)
 * and Hydra (tokens) through the flows WP3 builds in apps/web. This API only reads the session a
 * Hydra-issued token stands for — there is no password, no refresh rotation and no session store
 * here any more.
 *
 * No @UseGuards: JwtAuthGuard is a global APP_GUARD (app.module.ts), so this route is protected.
 */
@ApiTags('Auth')
@ApiBearerAuth()
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Get('me')
  async getMe(@CurrentUser() user: UserPayload) {
    return this.authService.getCurrentUser(user);
  }
}
