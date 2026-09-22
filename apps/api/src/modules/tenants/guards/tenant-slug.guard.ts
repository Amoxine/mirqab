import {
  Injectable,
  CanActivate,
  ExecutionContext,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { Request } from 'express';
import { prisma } from '@open-gateway/database';

/**
 * Guard that validates a tenant slug exists in the request
 * (via query parameter ?slug=... or route parameter :slug)
 * and attaches the resolved tenant to the request object.
 *
 * Usage: @UseGuards(TenantSlugGuard)
 *
 * After this guard, the tenant is available as:
 *   request.resolvedTenant — the full Tenant object
 */
@Injectable()
export class TenantSlugGuard implements CanActivate {
  // Not a constructor default: `prisma: PrismaClient = prisma` resolves to the parameter itself,
  // so constructing the guard threw "Cannot access 'prisma' before initialization".
  private readonly prisma = prisma;

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const slug =
      (request.query as Record<string, string | undefined>).slug ??
      (request.params as Record<string, string | undefined>).slug;

    if (!slug) {
      throw new BadRequestException('Tenant slug is required');
    }

    // Validate slug format
    const slugPattern = /^[a-z0-9]+(-[a-z0-9]+)*$/;
    if (!slugPattern.test(slug)) {
      throw new BadRequestException(
        'Invalid slug format. Must be lowercase alphanumeric with hyphens only.',
      );
    }

    const tenant = await this.prisma.tenant.findUnique({
      where: { slug },
    });

    if (!tenant) {
      throw new NotFoundException(`Tenant with slug "${slug}" not found`);
    }

    // Attach resolved tenant to request for downstream use
    const reqWithTenant = request as unknown as Record<string, unknown>;
    reqWithTenant.resolvedTenant = tenant;

    return true;
  }
}
