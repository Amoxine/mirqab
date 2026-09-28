import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { createHash } from 'node:crypto';
import { prisma } from '@open-gateway/database';
import { ApiDefFormat, AuditAction } from '@prisma/client';
import { recordJobRun } from '../../../common/metrics/ops-metrics';
import { TykClientService } from '../../tyk-integration/services/tyk-client.service';

/** One node's view of a definition. `hash` is null when the node could not be read. */
export interface NodeView {
  present: boolean;
  hash: string | null;
  error?: string;
}

/** Shape persisted to `ApiDefinition.syncState`. Rebuilt every tick, never merged. */
export interface SyncState {
  checkedAt: string;
  inSync: boolean;
  nodes: Record<string, NodeView>;
}

/** How often drift is recomputed. Acceptance requires a hand-edit to surface within one tick. */
export const RECONCILE_INTERVAL_MS = 60_000;

/** `AuditLog.resource` discriminator for the node-set provenance row. */
export const NODE_SET_RESOURCE = 'GatewayNodeSet';

/**
 * Fields removed before hashing, because they describe the definition's *runtime state* rather than
 * its configuration and so legitimately differ between nodes.
 *
 * Deliberately tiny, and that is an evidence-based choice rather than an oversight — see
 * `__fixtures__/tyk-injected-defaults.v5.15.0.json`. Tyk injects **81** top-level defaults into any
 * definition you POST, and the plan anticipated stripping all of them. Measured on v5.15.0, that is
 * both unnecessary and harmful:
 *
 *  - Unnecessary: the injected defaults are **deterministic**. DELETE + re-POST of a byte-identical
 *    body produced a byte-identical GET — 0 differing leaf paths out of 250 — so same-version nodes
 *    agree on them without any stripping.
 *  - Harmful: **12 of the 81** are fields `mapToTykFormat` itself emits (`CORS`,
 *    `global_rate_limit`, `do_not_track`, `enable_jwt`, the five `jwt_*`, `slug`, `domain`, `tags`).
 *    Stripping those would blind the drift check to a hand-edit of exactly the fields this product
 *    manages — the thing drift detection exists to catch.
 *
 * Known limit: nodes running DIFFERENT Tyk versions can inject different defaults and would read as
 * permanently drifted. That is a mixed-version deployment, which this stack does not do (one pinned
 * image, `infra/docker-compose.yml`), and reporting it as drift is arguably correct anyway.
 */
const VOLATILE_PATHS = [
  // OAS (Tyk-OAS definitions arrive with WP13b); harmless on a classic definition, which has no
  // `x-tyk-api-gateway` key at all.
  ['x-tyk-api-gateway', 'info', 'state'],
  // Classic: Tyk's own row identity, not configuration.
  ['_id'],
  ['internal_id'],
] as const;

function stripPath(doc: Record<string, unknown>, path: readonly string[]): void {
  let cursor: Record<string, unknown> = doc;
  for (const segment of path.slice(0, -1)) {
    const next: unknown = cursor[segment];
    if (next === null || typeof next !== 'object' || Array.isArray(next)) return;
    cursor = next as Record<string, unknown>;
  }
  // `Reflect.deleteProperty` rather than `delete cursor[leaf]` only to satisfy the no-dynamic-delete
  // rule; `copy` is a throwaway clone, so mutating it is fine.
  Reflect.deleteProperty(cursor, path[path.length - 1]);
}

/** Recursively sort object keys so two structurally equal documents serialise identically. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== 'object') return value;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return Object.fromEntries(entries.map(([k, v]) => [k, sortKeys(v)]));
}

/**
 * Stable content hash of a definition as a node reports it. Compare hashes, never raw bytes: Tyk
 * does not preserve key order, so two identical definitions serialise differently.
 */
export function definitionHash(doc: Record<string, unknown>): string {
  const copy = structuredClone(doc);
  for (const path of VOLATILE_PATHS) stripPath(copy, path);
  return createHash('sha256').update(JSON.stringify(sortKeys(copy))).digest('hex');
}

/** True when every node that answered holds the same definition, and every node answered. */
export function computeInSync(nodes: Record<string, NodeView>): boolean {
  const views = Object.values(nodes);
  if (views.length === 0) return false;
  if (views.some((v) => !v.present || v.hash === null)) return false;
  return new Set(views.map((v) => v.hash)).size === 1;
}

/**
 * How many of `nodes` are in sync across every reconciled definition — the `gateway_nodes_in_sync`
 * gauge R2 alerts on (`< gateway_nodes_total`).
 *
 * A node counts only when EVERY state reports it present with a hash no peer contradicts. When two
 * nodes both answer with different hashes neither counts, which is deliberate: the hashes say the
 * cluster diverged, not which side is right, and an operator has to look either way. Definitions
 * that have never been reconciled carry no `syncState` and are not passed in — no evidence is not
 * evidence of drift.
 *
 * Only nodes in `nodes` are considered, on both sides: a node dropped from `TYK_ADMIN_URLS` still
 * appears in stored states until the next tick rewrites them, and counting it would pin the gauge
 * low — an alert about a machine that is no longer part of the deployment.
 */
export function nodesInSync(states: readonly SyncState[], nodes: readonly string[]): number {
  return inSyncNodes(states, nodes).length;
}

/** The nodes `nodesInSync` counts, for the per-node `og_tyk_node_in_sync` gauge (TYK-04). */
export function inSyncNodes(states: readonly SyncState[], nodes: readonly string[]): string[] {
  // A Map per state rather than `state.nodes[node]`: indexing a `Record<string, NodeView>` is typed
  // as always present, while a state written before this node joined `TYK_ADMIN_URLS` simply has no
  // entry for it. `Map.get` is the lookup whose type tells the truth.
  const views = states.map((state) => new Map(Object.entries(state.nodes)));

  return nodes.filter((node) =>
    views.every((byNode) => {
      const view = byNode.get(node);
      if (!view?.present || view.hash === null) return false;
      // A peer that is MISSING the definition is out of sync itself; it must not drag down the node
      // that actually holds it. Only a peer that answered with a DIFFERENT hash is a contradiction.
      return nodes.every((peer) => {
        const other = byNode.get(peer);
        return !other?.present || other.hash === null || other.hash === view.hash;
      });
    }),
  );
}

@Injectable()
export class ReconcileService implements OnModuleInit {
  private readonly logger = new Logger(ReconcileService.name);

  constructor(private readonly tykClient: TykClientService) {}

  /**
   * Record the node set at boot, but only when it has actually changed.
   *
   * This is OPERATIONAL PROVENANCE, not a security control: it answers "when did this deployment
   * start talking to a different set of gateways", which is the first question when drift appears
   * everywhere at once. It is deliberately NOT stored in `syncState` — that field is per
   * `ApiDefinition` and the node set is global, so it would be the wrong shape and would be
   * rewritten by every tick.
   *
   * `tenantId` is null because the node list is platform-wide and belongs to no tenant. No new
   * `AuditAction` value: `UPDATED` + `resource: 'GatewayNodeSet'` is the discriminator, which keeps
   * this out of the enum-migration hazard entirely.
   */
  async onModuleInit(): Promise<void> {
    const nodes = [...this.tykClient.nodes];
    try {
      const last = await prisma.auditLog.findFirst({
        where: { resource: NODE_SET_RESOURCE, action: AuditAction.UPDATED },
        orderBy: { createdAt: 'desc' },
        select: { details: true },
      });
      const previous = (last?.details as { nodes?: unknown } | null)?.nodes;
      const unchanged = Array.isArray(previous) && JSON.stringify(previous) === JSON.stringify(nodes);
      if (unchanged) return;

      await prisma.auditLog.create({
        data: {
          tenantId: null,
          action: AuditAction.UPDATED,
          resource: NODE_SET_RESOURCE,
          details: { nodes, previous: previous ?? null },
        },
      });
      this.logger.log(`Gateway node set recorded: ${nodes.join(', ')}`);
    } catch (err) {
      // Provenance must never stop the app booting.
      this.logger.warn(
        `Could not record the gateway node set: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Recompute `syncState` for one definition by reading it from every node.
   *
   * The map is built fresh from the CURRENT node list each time — never merged into the stored one.
   * A merge would leave a node that has been removed from `TYK_ADMIN_URLS` in the map forever,
   * pinning `inSync:false` and alerting on a machine that no longer exists.
   */
  async reconcileOne(apiDefId: string, tykApiId: string, defFormat: ApiDefFormat = ApiDefFormat.CLASSIC): Promise<SyncState> {
    const nodes: Record<string, NodeView> = {};
    // An OAS api lives in a different collection and is NOT readable through /tyk/apis/{id}, so
    // reading the wrong one would report every OAS api as missing on every node.
    const isOas = defFormat === ApiDefFormat.OAS;

    for (const nodeUrl of this.tykClient.nodes) {
      try {
        const doc = isOas
          ? await this.tykClient.getOasApiFromNode(tykApiId, nodeUrl)
          : await this.tykClient.getApiFromNode(tykApiId, nodeUrl);
        nodes[nodeUrl] = { present: true, hash: definitionHash(doc) };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // "not found" is a definite answer (the node is missing the definition); anything else
        // means we could not read the node at all. Both block `inSync`, but only the second is a
        // reason to look at infrastructure, so they are recorded distinctly.
        const absent = /not found|404/i.test(message);
        nodes[nodeUrl] = { present: false, hash: null, error: absent ? 'not present' : message };
      }
    }

    const state: SyncState = {
      checkedAt: new Date().toISOString(),
      inSync: computeInSync(nodes),
      nodes,
    };

    await prisma.apiDefinition.update({
      where: { id: apiDefId },
      data: { syncState: state as unknown as object },
    });

    return state;
  }

  /**
   * One reconcile tick over every definition that has reached the gateway.
   *
   * Rows with no `tykApiId` have never been synced, so there is nothing to compare and no drift to
   * report — leaving `syncState` null is the honest answer rather than inventing an empty map.
   */
  @Interval(RECONCILE_INTERVAL_MS)
  async reconcileAll(): Promise<void> {
    // A throw leaves `ok` false, and so does one failed definition even though the sweep goes on.
    let ok = false;
    try {
      const defs = await prisma.apiDefinition.findMany({
        where: { tykApiId: { not: null } },
        select: { id: true, tykApiId: true, defFormat: true },
      });
      ok = true;

      for (const def of defs) {
        if (!def.tykApiId) continue;
        try {
          await this.reconcileOne(def.id, def.tykApiId, def.defFormat);
        } catch (err) {
          // One bad definition must not stop the sweep.
          ok = false;
          this.logger.warn(
            `Reconcile of ${def.id} failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    } finally {
      recordJobRun('reconcile', ok);
    }
  }
}
