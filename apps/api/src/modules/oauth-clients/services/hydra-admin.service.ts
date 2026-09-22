import { BadGatewayException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * An OAuth2 client exactly as Hydra's admin API returns it — Hydra's own snake_case field names, so
 * a client fetched here can be sent straight back on an update (`PUT` replaces the whole record).
 * Only the fields this app reads are typed; the rest travel through untouched.
 */
export interface HydraClient {
  client_id: string;
  client_name?: string;
  /** Hydra returns the raw secret only when it mints one (create, or an update that sets it). */
  client_secret?: string;
  /** Set to the owning tenant id: the only server-side filter Hydra's list endpoint offers. */
  owner?: string;
  created_at?: string;
  metadata?: Record<string, unknown>;
  [field: string]: unknown;
}

/**
 * Hydra's list endpoint pages; 500 is its maximum page size.
 * ponytail: one page only. A tenant with more than 500 OAuth2 clients would see a truncated list —
 * follow `page_token` if that ever becomes real.
 */
const LIST_PAGE_SIZE = 500;

/**
 * Every call is bounded. A half-open connection to Hydra would otherwise hang the request handler
 * indefinitely — the `catch` below only ever sees a rejection, and a hang never produces one.
 */
const ADMIN_TIMEOUT_MS = 5000;

/**
 * Thin wrapper over Ory Hydra's admin API (`/admin/clients`).
 *
 * The admin API is unauthenticated and reachable only inside the compose network (see
 * docker-compose.yml: port 4445 is bound to loopback), so there is no credential to hold here.
 * Every failure collapses to 502 — Hydra's error bodies can name internal hosts, and the caller
 * only ever needs to know the provider could not be reached.
 */
@Injectable()
export class HydraAdminService {
  private readonly logger = new Logger(HydraAdminService.name);
  private readonly adminUrl: string;

  constructor(configService: ConfigService) {
    /* eslint-disable-next-line @typescript-eslint/no-unnecessary-type-arguments --
       ConfigService.get types its default as NoInferType<T>; without the explicit argument T is any. */
    this.adminUrl = configService.get<string>('ORY_HYDRA_ADMIN_URL', 'http://hydra:4445');
  }

  async create(client: Record<string, unknown>): Promise<HydraClient> {
    return this.request<HydraClient>('/admin/clients', { method: 'POST', body: JSON.stringify(client) });
  }

  /** Throws 404 when Hydra does not know the client. */
  async find(clientId: string): Promise<HydraClient> {
    return this.request<HydraClient>(`/admin/clients/${encodeURIComponent(clientId)}`);
  }

  /** Every client owned by `owner`, i.e. every client of one tenant. */
  async listByOwner(owner: string): Promise<HydraClient[]> {
    const query = new URLSearchParams({ owner, page_size: String(LIST_PAGE_SIZE) });
    return this.request<HydraClient[]>(`/admin/clients?${query.toString()}`);
  }

  /** Full replace (Hydra has no partial update for clients): send the whole record back. */
  async replace(clientId: string, client: Record<string, unknown>): Promise<HydraClient> {
    return this.request<HydraClient>(`/admin/clients/${encodeURIComponent(clientId)}`, {
      method: 'PUT',
      body: JSON.stringify(client),
    });
  }

  /** Tolerates a client Hydra no longer knows — that is the state the caller wanted. */
  async remove(clientId: string): Promise<void> {
    try {
      await this.request(`/admin/clients/${encodeURIComponent(clientId)}`, { method: 'DELETE' });
    } catch (err) {
      if (err instanceof NotFoundException) return;
      throw err;
    }
  }

  private async request<T>(path: string, options: { method?: string; body?: string } = {}): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.adminUrl}${path}`, {
        ...options,
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(ADMIN_TIMEOUT_MS),
      });
    } catch (err) {
      this.logger.error(`Hydra admin API unreachable: ${err instanceof Error ? err.message : String(err)}`);
      throw new BadGatewayException('Identity provider unreachable');
    }

    if (response.status === 404) {
      throw new NotFoundException('OAuth2 client not found');
    }

    if (!response.ok) {
      // Hydra's error bodies carry internal detail (DSN hints, hostnames); log, never forward.
      this.logger.error(`Hydra admin API ${path} returned ${String(response.status)}: ${await response.text()}`);
      throw new BadGatewayException('Identity provider rejected the request');
    }

    // 204 on DELETE.
    return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
  }
}
