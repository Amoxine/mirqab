import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Public } from '../../../common/decorators/public.decorator';
import { DeveloperService, type RegisteredDeveloper } from '../services/developer.service';
import { RegisterDeveloperDto } from '../dto/register-developer.dto';

/**
 * `/portal/*` is a second, separate auth domain (WP22): `@Public()` exempts every route here from
 * the global `JwtAuthGuard` (Hydra-JWT dashboard sessions), and no route in this whole module ever
 * carries `@Permissions()` — that decorator is dashboard RBAC, and a developer has none.
 */
@ApiTags('Portal')
@Controller('portal/auth')
export class PortalAuthController {
  constructor(private readonly developers: DeveloperService) {}

  @Public()
  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  // Abuse control (plan acceptance): per-IP sign-up limit, tighter than the app-wide default.
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: 'Register a developer account for one tenant\'s portal' })
  @ApiResponse({ status: 201, description: 'Registered — verify the email Kratos just sent to sign in' })
  @ApiResponse({ status: 409, description: 'Email already registered' })
  async register(@Body() dto: RegisterDeveloperDto): Promise<RegisteredDeveloper> {
    return this.developers.register(dto);
  }
}
