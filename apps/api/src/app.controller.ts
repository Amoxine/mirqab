import { Controller, Get } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { ApiTags } from '@nestjs/swagger';
import { AppService } from './app.service';
import { Public } from './common/decorators/public.decorator';

// Liveness/readiness probes must never be rate limited: an orchestrator polling /health would
// otherwise eat into the per-IP budget and eventually be told the app is unhealthy. Same reasoning
// for auth: neither route had a guard before JwtAuthGuard became global (app.module.ts), so @Public()
// here is what keeps them reachable by an unauthenticated orchestrator instead of 401ing it.
@ApiTags('Health')
@Public()
@SkipThrottle()
@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  getRoot(): { status: string; timestamp: string } {
    return this.appService.getHealth();
  }

  @Get('health')
  getHealth(): { status: string; timestamp: string } {
    return this.appService.getHealth();
  }
}
