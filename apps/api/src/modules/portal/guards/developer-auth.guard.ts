import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { prisma } from '@open-gateway/database';
import { kratosWhoAmI } from '../../../common/ory/kratos';
import type { DeveloperPayload } from '../../../common/types';

/** A header can arrive repeated, in which case express hands back an array. */
const firstHeader = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

const fromBearer = (request: Request): string | undefined => {
  const header = firstHeader(request.headers.authorization);
  return header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
};

/**
 * The portal's own auth — a Kratos session, never a Hydra JWT. Every portal controller is marked
 * `@Public()` (exempting it from the global `JwtAuthGuard`) and carries `@UseGuards(DeveloperAuthGuard)`
 * instead, which is what makes "no dashboard endpoint reachable with a developer session" true for
 * free: a Kratos session token sent to a dashboard route fails `JwtAuthGuard`'s JWT signature check
 * outright (a session token is not a JWT at all), and a Hydra JWT sent here fails `whoami` the same
 * way — the two token formats simply do not parse as each other's.
 *
 * Resolves to a `Developer` row, not just a live Kratos session: a Kratos identity with no
 * `Developer` (a dashboard-only `User`, or an identity that registered but never got one written)
 * is not a portal session either. `status !== ACTIVE` denies the same way a suspended dashboard
 * user's session does (`AuthService.resolveSession`).
 */
@Injectable()
export class DeveloperAuthGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();

    const session = await kratosWhoAmI({
      sessionToken: fromBearer(request),
      cookieHeader: firstHeader(request.headers.cookie),
    });
    if (!session) {
      throw new UnauthorizedException('No active developer session');
    }

    const developer = await prisma.developer.findUnique({
      where: { kratosIdentityId: session.identity.id },
    });
    if (developer?.status !== 'ACTIVE') {
      throw new UnauthorizedException('No active developer session');
    }

    const payload: DeveloperPayload = {
      sub: developer.id,
      tenantId: developer.tenantId,
      email: developer.email,
      name: developer.name,
    };
    (request as Request & { developer: DeveloperPayload }).developer = payload;

    return true;
  }
}
