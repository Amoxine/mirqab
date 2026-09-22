import { BadGatewayException, BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { prisma } from '@open-gateway/database';
import type { ApiDefinition } from '@prisma/client';
import { TykClientService } from '../../tyk-integration/services/tyk-client.service';
import { HydraAdminService, type HydraClient } from './hydra-admin.service';
import {
  buildHydraClientDef,
  buildTykPolicy,
  generateClientSecret,
  type ClientLimits,
} from './oauth-client-mapper';
import { loadTenantScope } from '../../tyk-integration/services/tenant-scope';

/** An OAuth2 client as the dashboard lists it. The secret is never part of this shape. */
export interface OAuthClientListItem {
  clientId: string;
  name: string;
  apiDefId: string;
  createdAt: string | null;
}

/** Create / rotate response: the only time the raw secret exists outside Hydra. */
export interface OAuthClientSecret extends OAuthClientListItem {
  clientSecret: string;
  /** Where the consumer exchanges the credentials, i.e. Hydra's public token endpoint. */
  tokenUrl: string;
}

export interface CreateOAuthClientInput extends ClientLimits {
  apiDefId: string;
  name: string;
}

/** `metadata` is free-form JSON on Hydra's side; only these two fields are ours. */
interface ClientMetadata {
  tenantId?: unknown;
  apiDefId?: unknown;
}

const metadataOf = (client: HydraClient): ClientMetadata => (client.metadata ?? {}) as ClientMetadata;

function toListItem(client: HydraClient): OAuthClientListItem {
  const { apiDefId } = metadataOf(client);
  return {
    clientId: client.client_id,
    name: client.client_name ?? '',
    apiDefId: typeof apiDefId === 'string' ? apiDefId : '',
    createdAt: client.created_at ?? null,
  };
}

/**
 * OAuth2 client credentials for the data plane: one Hydra client per consumer of one API, plus the
 * Tyk policy that authorizes it (see `buildTykPolicy` for why the policy id is the client id).
 *
 * There is no local table. Hydra is the single source of truth and its `metadata.tenantId` /
 * `metadata.apiDefId` are the scoping record, which is why every read re-checks the tenant instead
 * of trusting an id from the request.
 */
@Injectable()
export class OAuthClientService {
  private readonly logger = new Logger(OAuthClientService.name);
  private readonly tokenUrl: string;

  constructor(
    private readonly hydra: HydraAdminService,
    private readonly tykClient: TykClientService,
    configService: ConfigService,
  ) {
    /* eslint-disable-next-line @typescript-eslint/no-unnecessary-type-arguments --
       ConfigService.get types its default as NoInferType<T>; without the explicit argument T is any. */
    const issuer = configService.get<string>('ORY_HYDRA_ISSUER', 'http://localhost:33010/');
    // The browser-facing issuer, not the in-network host: this URL is handed to the API consumer.
    this.tokenUrl = new URL('oauth2/token', issuer).toString();
  }

  async create(input: CreateOAuthClientInput, tenantId: string): Promise<OAuthClientSecret> {
    const apiDef = await this.findOAuthApi(input.apiDefId, tenantId);
    const secret = generateClientSecret();
    // Built before the client exists so an invalid limit combination answers 400 instead of leaving
    // a Hydra client behind (same order as KeyService.create).
    const policy = buildTykPolicy(
      input.name,
      { name: apiDef.name, tykApiId: apiDef.tykApiId },
      input,
      (await loadTenantScope(tenantId)).tykOrgId,
    );

    const client = await this.hydra.create(
      buildHydraClientDef({ name: input.name, tenantId, apiDefId: input.apiDefId, secret }),
    );

    // Without the policy the credentials authenticate but authorize nothing (Tyk answers 403), so a
    // client whose policy could not be written is not a usable client — remove it rather than leave
    // a credential nobody can explain.
    try {
      await this.tykClient.upsertPolicy({ ...policy, id: client.client_id });
    } catch (err) {
      this.logger.error(
        `Failed to authorize OAuth2 client ${client.client_id} on the gateway: ${err instanceof Error ? err.message : String(err)}`,
      );
      try {
        await this.hydra.remove(client.client_id);
      } catch (cleanupErr) {
        this.logger.error(
          `Orphaned OAuth2 client ${client.client_id} after a failed policy write; delete it manually: ` +
            (cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)),
        );
      }
      throw new BadGatewayException('Could not authorize the client on the gateway; it was not created');
    }

    this.logger.log(`OAuth2 client ${client.client_id} created for API ${apiDef.id}`);

    return { ...toListItem(client), clientSecret: secret, tokenUrl: this.tokenUrl };
  }

  /** Every client scoped to one API of this tenant, newest first. */
  async findByApi(apiDefId: string, tenantId: string): Promise<OAuthClientListItem[]> {
    await this.findApi(apiDefId, tenantId);
    const clients = await this.hydra.listByOwner(tenantId);

    return clients
      .filter((client) => metadataOf(client).apiDefId === apiDefId)
      .map(toListItem)
      .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
  }

  /**
   * Replace the client's secret, leaving its id and its policy alone, so a consumer can roll
   * credentials without the dashboard re-issuing access. The new secret is returned once.
   */
  async rotate(clientId: string, tenantId: string): Promise<OAuthClientSecret> {
    const client = await this.findClient(clientId, tenantId);
    const secret = generateClientSecret();

    // Hydra has no partial update for clients: send the record back with only the secret changed.
    const rotated = await this.hydra.replace(clientId, { ...client, client_secret: secret });
    this.logger.log(`OAuth2 client ${clientId} secret rotated for tenant ${tenantId}`);

    return { ...toListItem(rotated), clientSecret: secret, tokenUrl: this.tokenUrl };
  }

  /**
   * Revoke a client. The policy goes first: Tyk verifies these tokens offline against Hydra's
   * signing key, so removing only the Hydra client would leave tokens already issued working until
   * they expire (up to the access-token TTL). Dropping the policy denies them on the next request.
   */
  async revoke(clientId: string, tenantId: string): Promise<{ message: string }> {
    await this.findClient(clientId, tenantId);

    // `deletePolicy` is idempotent, so a failure here means the policy may still be live — i.e. the
    // credentials may still be authorized, and the client must NOT be reported as revoked.
    try {
      await this.tykClient.deletePolicy(clientId);
    } catch (err) {
      this.logger.error(
        `Failed to delete gateway policy for client ${clientId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw new BadGatewayException('Could not revoke the client on the gateway; it was not revoked');
    }

    await this.hydra.remove(clientId);
    this.logger.log(`OAuth2 client ${clientId} revoked for tenant ${tenantId}`);

    return { message: 'OAuth2 client revoked' };
  }

  private async findApi(apiDefId: string, tenantId: string): Promise<ApiDefinition> {
    const apiDef = await prisma.apiDefinition.findUnique({ where: { id: apiDefId } });

    if (apiDef?.tenantId !== tenantId) {
      throw new NotFoundException(`API definition with id "${apiDefId}" not found`);
    }

    return apiDef;
  }

  private async findOAuthApi(apiDefId: string, tenantId: string): Promise<ApiDefinition> {
    const apiDef = await this.findApi(apiDefId, tenantId);

    if (apiDef.authType !== 'OAUTH') {
      throw new BadRequestException(
        `API "${apiDef.name}" does not use OAuth2 (auth type is ${apiDef.authType}); OAuth2 clients only apply to OAUTH APIs`,
      );
    }

    return apiDef;
  }

  /** A client of this tenant, by id. A client of another tenant is indistinguishable from a missing one. */
  private async findClient(clientId: string, tenantId: string): Promise<HydraClient> {
    const client = await this.hydra.find(clientId);

    if (metadataOf(client).tenantId !== tenantId) {
      throw new NotFoundException('OAuth2 client not found');
    }

    return client;
  }
}
