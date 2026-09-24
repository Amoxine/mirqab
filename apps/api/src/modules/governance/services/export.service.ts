import { Injectable } from '@nestjs/common';
import { prisma } from '@open-gateway/database';
import type { Prisma } from '@prisma/client';

/** One API's config-of-record fields — no `tykApiId`/`oasDocument`/secrets, see the module doc below. */
export interface ExportedApi {
  id: string;
  name: string;
  slug: string;
  proxyUrl: string;
  listenPath: string;
  authType: string;
  status: string;
  config: Prisma.JsonValue;
  defFormat: string;
  versionName: string | null;
  parentApiId: string | null;
  retiredAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ExportedPlan {
  id: string;
  name: string;
  description: string | null;
  rate: number;
  per: number;
  quotaMax: number;
  quotaPeriod: string;
  active: boolean;
  requiresApproval: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface ExportedProduct {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  apiIds: string[];
  createdAt: Date;
  updatedAt: Date;
}

export interface ExportBundle {
  apis: ExportedApi[];
  plans: ExportedPlan[];
  products: ExportedProduct[];
}

/**
 * `POST /governance/export` (WP25). Produces the tenant's config-of-record bundle — APIs, plans,
 * products, nothing else (no keys, no OAuth2 clients, no audit rows), which is what keeps secrets
 * out by construction rather than by a filter someone has to remember to keep in sync: `ApiKey.keyHash`,
 * `ApiKey.tykKeyId`, OAuth2 client secrets and `TYK_ADMIN_SECRET`/`TYK_GW_SECRET` (env vars, never in
 * the DB at all) simply never enter a query this service runs. `ApiDefinition.config` was checked by
 * hand against `api-config.dto.ts`: rate limits, CORS, IP lists, cache, HMAC algorithm names, JWT —
 * a JWKS URL and an issuer, both public by definition — none of it is a credential. Per-caller
 * credentials (HMAC shared secret, basic-auth password) live on `ApiKey`, which this bundle never
 * touches. `oasDocument`/`tykApiId` are excluded too: they are OUR OWN derived output and a gateway
 * linkage id, not config, and including them would just duplicate what the fields below already say.
 *
 * **Determinism** (two runs over unchanged config are deep-equal after stable-key JSON
 * serialisation — byte-identical is explicitly cut, see the roadmap's §9): every list is Prisma
 * `select`-only (DoD-OWNER 5) — no relation include whose own order is unspecified — and explicitly
 * `orderBy: { id: 'asc' }`. `id` (a uuid) is unique and immutable, unlike `createdAt`, which two rows
 * can share at millisecond resolution with an unspecified tie-break order. No field here is
 * generated at request time (no `exportedAt`, nothing wall-clock-derived) — the bundle is a pure
 * reflection of stored rows, so calling this twice with nothing changed in between reads the same
 * rows in the same order and produces the same content, full stop.
 *
 * Deliberately unpaginated, unlike every other list in this codebase (DoD-OWNER 5's "paginate lists"
 * rule) — an export that silently truncated at the page size would be a wrong bundle, not a slow one.
 */
@Injectable()
export class GovernanceExportService {
  async export(tenantId: string): Promise<ExportBundle> {
    const [apis, plans, products] = await Promise.all([
      this.exportApis(tenantId),
      this.exportPlans(tenantId),
      this.exportProducts(tenantId),
    ]);

    return { apis, plans, products };
  }

  private async exportApis(tenantId: string): Promise<ExportedApi[]> {
    return prisma.apiDefinition.findMany({
      where: { tenantId },
      select: {
        id: true,
        name: true,
        slug: true,
        proxyUrl: true,
        listenPath: true,
        authType: true,
        status: true,
        config: true,
        defFormat: true,
        versionName: true,
        parentApiId: true,
        retiredAt: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { id: 'asc' },
    });
  }

  private async exportPlans(tenantId: string): Promise<ExportedPlan[]> {
    return prisma.plan.findMany({
      where: { tenantId },
      select: {
        id: true,
        name: true,
        description: true,
        rate: true,
        per: true,
        quotaMax: true,
        quotaPeriod: true,
        active: true,
        requiresApproval: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { id: 'asc' },
    });
  }

  private async exportProducts(tenantId: string): Promise<ExportedProduct[]> {
    const rows = await prisma.product.findMany({
      where: { tenantId },
      select: {
        id: true,
        name: true,
        slug: true,
        description: true,
        createdAt: true,
        updatedAt: true,
        apis: { select: { apiDefId: true } },
      },
      orderBy: { id: 'asc' },
    });

    // `apis` comes from a to-many include with no orderBy of its own — sorted here rather than in
    // the query, for the same determinism reason the top-level lists are `orderBy: { id: 'asc' }`.
    return rows.map(({ apis, ...product }) => ({
      ...product,
      apiIds: apis.map((a) => a.apiDefId).sort(),
    }));
  }
}
