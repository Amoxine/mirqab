import { Controller, Get, Header, HttpStatus, Res } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { AppService, type ReadinessReport } from './app.service';
import { Public } from './common/decorators/public.decorator';
import { MetricsService } from './modules/observability/metrics.service';

// Liveness/readiness probes must never be rate limited: an orchestrator polling /health would
// otherwise eat into the per-IP budget and eventually be told the app is unhealthy. Same reasoning
// for auth: neither route had a guard before JwtAuthGuard became global (app.module.ts), so @Public()
// here is what keeps them reachable by an unauthenticated orchestrator instead of 401ing it.
//
// /metrics rides the same decorators for the same reasons — Prometheus holds no JWT and scrapes on a
// fixed interval. It carries no secret, but it does describe the deployment, so the edge answers 404
// for it (infra/edge/Caddyfile): it is an in-network scrape target, not a published endpoint.
@ApiTags('Health')
@Public()
@SkipThrottle()
@Controller()
export class AppController {
  constructor(
    private readonly appService: AppService,
    private readonly metricsService: MetricsService,
  ) {}

  @Get()
  getRoot(): { status: string; timestamp: string } {
    return this.appService.getLiveness();
  }

  @Get('health')
  async getHealth(@Res({ passthrough: true }) res: Response): Promise<ReadinessReport> {
    const report = await this.appService.getReadiness();
    // 503, not a thrown exception: the body names WHICH dependency is down, and AllExceptionsFilter
    // would replace it with the generic error envelope.
    if (report.status !== 'ok') res.status(HttpStatus.SERVICE_UNAVAILABLE);
    return report;
  }

  @Get('metrics')
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  async getMetrics(): Promise<string> {
    await this.metricsService.refresh();
    return this.metricsService.registry.metrics();
  }
}
