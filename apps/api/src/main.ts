import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { parseTrustProxyHops } from './common/config/env';

// Prisma BigInt columns (AuditLog.id) throw "Do not know how to serialize a BigInt" in res.json()
(BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function (this: bigint) {
  return this.toString();
};

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const configService = app.get(ConfigService);

  /* eslint-disable @typescript-eslint/no-unnecessary-type-arguments --
     ConfigService.get types its default as NoInferType<T>, so T cannot be inferred from it and
     falls back to `any`. The explicit argument is what keeps these typed. */
  const port = configService.get<number>('PORT', 33001);
  const nodeEnv = configService.get<string>('NODE_ENV', 'development');
  const allowedOrigins = configService
    .get<string>('CORS_ORIGINS', 'http://localhost:33000')
    .split(',');
  const trustProxy = parseTrustProxyHops(configService.get<string>('TRUST_PROXY_HOPS'));
  /* eslint-enable @typescript-eslint/no-unnecessary-type-arguments */

  // Behind N reverse proxies req.ip (the throttler's key) must be the client, not the proxy. A hop
  // count, never `true`: `true` trusts the whole X-Forwarded-For header, which clients can forge.
  if (trustProxy.invalid) {
    new Logger('Bootstrap').warn(
      'TRUST_PROXY_HOPS must be an integer >= 0; falling back to 0 (X-Forwarded-For ignored)',
    );
  }
  app.set('trust proxy', trustProxy.hops);

  // Security
  app.use(helmet());
  app.use(cookieParser());

  // CORS
  app.enableCors({
    origin: allowedOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Tenant-ID', 'X-Correlation-ID'],
    exposedHeaders: ['X-Correlation-ID'],
  });

  // Global validation pipe
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  // Global exception filter
  app.useGlobalFilters(new AllExceptionsFilter());

  // Prefix
  app.setGlobalPrefix('api');

  // OpenAPI — every controller below already carries @ApiTags/@ApiProperty, this is the one line
  // that was missing to actually serve them. Path is spelled out (not just 'docs') because
  // SwaggerModule.setup ignores the global prefix above unless told to repeat it.
  const openApiConfig = new DocumentBuilder()
    .setTitle('Open Gateway API')
    .setDescription('Control-plane API for the Open Gateway admin dashboard')
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, openApiConfig));

  // Shutdown hooks
  app.enableShutdownHooks();

  if (nodeEnv !== 'production') {
    const logger = new Logger('Bootstrap');
    logger.log(`API server running on http://localhost:${String(port)}`);
    logger.log(`Health check: http://localhost:${String(port)}/api/health`);
  }

  await app.listen(port);
}

void bootstrap();
