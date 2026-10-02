import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { prisma } from '@open-gateway/database';
import { ApiDefFormat, AuditAction, type Prisma } from '@prisma/client';
import { TykClientService } from '../../tyk-integration/services/tyk-client.service';
import { AuditService } from '../../audit/services/audit.service';

/** `AuditLog.resource` for every adopt entry — one discriminator, filterable across every API it touches. */
export const ADOPT_RESOURCE = 'ApiDefinition';
/** Marks an `UPDATED` row as this operator override rather than an ordinary edit — see `adopt()`. */
export const ADOPT_EVENT = 'adopted_from_gateway';

export interface AdoptResult {
  apiDefId: string;
  node: string;
  adoptedFields: string[];
  adoptedAt: string;
  /** P2: labelled as an override, not a routine sync — see the class doc comment. */
  message: string;
}

/**
 * `POST /governance/apis/:id/adopt` (WP25) — P2's audited escape hatch: "Postgres is config of
 * record, each node is a projection; adopt from gateway is an audited escape hatch," not a normal
 * path. An operator uses this after `GET /apis/:id/drift` shows nodes disagreeing and decides one
 * node's CURRENT state is the one to keep — the opposite direction of `POST /apis/:id/sync`, which
 * pushes Postgres's config out to every node.
 *
 * Stores the node's raw definition into `ApiDefinition.adoptedFromGateway` (see that field's own
 * doc comment for why it is a dedicated field, not `oasDocument`) and writes ONE mandatory
 * `AuditLog` row naming the node and the adopted fields — not the fire-and-forget
 * `AuditLogInterceptor`/`@Audit()` path every other mutation uses (`setImmediate`, swallows its own
 * failures): an operator override to config of record is exactly the action that must not be
 * silently unaudited. Both writes go through ONE `prisma.$transaction`, not just an awaited
 * `recordOrThrow()` — live-verified (worker-8) that two separate awaited writes are not enough: a
 * throwing audit write left the row's `adoptedFromGateway` persisted anyway, an override with no
 * trace it happened. The transaction is what makes "the request failed" and "nothing changed" the
 * same fact.
 *
 * Deliberately does NOT reverse-map the adopted document into `proxyUrl`/`listenPath`/`config` — see
 * the field's doc comment. A future `PATCH`/`POST :id/sync` still regenerates from those structured
 * fields, unaffected by what was adopted; that is this v1's documented limit, not an oversight.
 */
@Injectable()
export class GovernanceAdoptService {
  constructor(
    private readonly tykClient: TykClientService,
    private readonly auditService: AuditService,
  ) {}

  async adopt(apiDefId: string, nodeUrl: string, tenantId: string): Promise<AdoptResult> {
    // The node is a caller-supplied string — resolving it against the CONFIGURED node list, not
    // fetching whatever URL the caller sends, is what stops this being an SSRF hole into the
    // internal network the api container can otherwise reach.
    if (!this.tykClient.nodes.includes(nodeUrl)) {
      throw new BadRequestException(
        `"${nodeUrl}" is not one of the configured gateway nodes: ${this.tykClient.nodes.join(', ')}`,
      );
    }

    const apiDef = await prisma.apiDefinition.findFirst({
      where: { id: apiDefId, tenantId },
      select: { id: true, tykApiId: true, defFormat: true },
    });
    if (!apiDef) throw new NotFoundException(`API definition ${apiDefId} not found`);
    if (!apiDef.tykApiId) {
      throw new BadRequestException('This API has never been synced to the gateway; there is nothing to adopt');
    }

    const document =
      apiDef.defFormat === ApiDefFormat.OAS
        ? await this.tykClient.getOasApiFromNode(apiDef.tykApiId, nodeUrl)
        : await this.tykClient.getApiFromNode(apiDef.tykApiId, nodeUrl);

    const adoptedFields = Object.keys(document).sort();
    const adoptedAt = new Date().toISOString();

    // One transaction, not two awaited calls: recordOrThrow() alone makes a failed audit write
    // THROW, but by itself does nothing to undo the apiDefinition.update that already committed —
    // exactly the gap worker-8's live verification found. Wrapping both in $transaction is what
    // makes them commit or roll back together, so "adopt reported success" and "the AuditLog row
    // exists" can never disagree.
    await prisma.$transaction(async (tx) => {
      await tx.apiDefinition.update({
        where: { id: apiDefId },
        // `document` is whatever shape Tyk answered with (already sanitised of internal_id/org_id/etc
        // by TykClientService.request) — cast, not `as any`: Prisma's InputJsonValue is a closed
        // recursive union that a plain `Record<string, unknown>` cannot structurally satisfy even
        // though every value in it is, in fact, valid JSON (it came from a JSON HTTP response).
        data: {
          adoptedFromGateway: { node: nodeUrl, document, adoptedFields, adoptedAt } as Prisma.InputJsonValue,
        },
      });

      // recordOrThrow, not record(): record() swallows its own failures (logs and resolves anyway),
      // which would let this method report success on a silently unaudited override.
      await this.auditService.recordOrThrow(
        {
          tenantId,
          action: AuditAction.UPDATED,
          resource: ADOPT_RESOURCE,
          details: { event: ADOPT_EVENT, apiDefId, node: nodeUrl, adoptedFields },
        },
        tx,
      );
    });

    return {
      apiDefId,
      node: nodeUrl,
      adoptedFields,
      adoptedAt,
      message:
        `Adopted ${String(adoptedFields.length)} field(s) from ${nodeUrl}, overriding the stored definition as ` +
        'config of record for this API. This is an operator escape hatch, not a routine sync — the ' +
        'structured fields (proxy URL, listen path, config) are unchanged and the next edit or ' +
        'POST /apis/:id/sync will regenerate from them, not from what was just adopted.',
    };
  }
}
