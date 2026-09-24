import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { prisma } from '@open-gateway/database';
import { kratosCreateIdentity, kratosSendVerificationEmail } from '../../../common/ory/kratos';
import type { RegisterDeveloperDto } from '../dto/register-developer.dto';
import type { DeveloperPayload } from '../../../common/types';

export interface RegisteredDeveloper {
  id: string;
  email: string;
  name: string;
}

/** `GET /portal/auth/me` (WP23): the session-echo the frontend needs — whether it should treat the
 * visitor as signed in, and `tenantSlug` for the gateway URL (`gatewayListenPath`), which nothing
 * else portal-facing returns. `DeveloperAuthGuard` already resolved and validated the session; this
 * only adds the one field it doesn't carry. */
export interface CurrentDeveloperInfo {
  id: string;
  email: string;
  name: string;
  tenantSlug: string;
}

/**
 * Developer registration (WP22). Kratos owns the identity and its password; this only provisions
 * the `Developer` row that scopes everything else in the portal to a tenant, and kicks off the
 * verification email — the developer still logs in through Kratos's own self-service flow
 * afterwards (same as the dashboard reuses "the existing Kratos flow components", WP23), this
 * service never issues a session itself.
 */
@Injectable()
export class DeveloperService {
  private readonly logger = new Logger(DeveloperService.name);

  async register(dto: RegisterDeveloperDto): Promise<RegisteredDeveloper> {
    const tenant = await prisma.tenant.findUnique({ where: { slug: dto.tenantSlug } });
    if (!tenant) {
      throw new NotFoundException(`Tenant "${dto.tenantSlug}" not found`);
    }

    // Kratos enforces one identity per email globally (the schema's `identifier: true` email
    // trait) — across the dashboard's Users too, they share this one instance — so a duplicate
    // surfaces as a Kratos error, not a Postgres one. Caught below and reported as 409.
    let identity: Awaited<ReturnType<typeof kratosCreateIdentity>>;
    try {
      identity = await kratosCreateIdentity({ email: dto.email, name: dto.name, password: dto.password });
    } catch (err) {
      this.logger.warn(`Kratos identity create failed for ${dto.email}: ${String(err)}`);
      throw new ConflictException(`An account for "${dto.email}" already exists.`);
    }

    let developer: Prisma.DeveloperGetPayload<Record<string, never>>;
    try {
      developer = await prisma.developer.create({
        data: { tenantId: tenant.id, email: dto.email, name: dto.name, kratosIdentityId: identity.id },
      });
    } catch (err) {
      // The Kratos identity now outlives this failed registration — clean it up so the email is
      // free to try again, same as every other "gateway succeeded, our own write failed" rollback
      // in this codebase (PlanService.create, KeyService.create).
      await fetch(new URL(`/admin/identities/${identity.id}`, process.env.ORY_KRATOS_ADMIN_URL ?? 'http://kratos:4434'), {
        method: 'DELETE',
      }).catch((cleanupErr: unknown) => {
        this.logger.error(
          `Orphaned Kratos identity ${identity.id} after a failed Developer write; delete it manually: ${String(cleanupErr)}`,
        );
      });

      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException(`An account for "${dto.email}" already exists.`);
      }
      throw err;
    }

    // Best-effort: the account already exists at this point, and a courier hiccup is retriable
    // (the developer can ask Kratos to resend from the verification screen) — never fail the
    // registration response over it.
    try {
      await kratosSendVerificationEmail(dto.email);
    } catch (err) {
      this.logger.warn(`Could not send verification email to ${dto.email}: ${String(err)}`);
    }

    return { id: developer.id, email: developer.email, name: developer.name };
  }

  /** `payload` already comes from a validated `DeveloperAuthGuard` session — this only adds `tenantSlug`. */
  async me(payload: DeveloperPayload): Promise<CurrentDeveloperInfo> {
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: payload.tenantId }, select: { slug: true } });
    return { id: payload.sub, email: payload.email, name: payload.name, tenantSlug: tenant.slug };
  }
}
