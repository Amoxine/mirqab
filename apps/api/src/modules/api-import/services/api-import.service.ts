import { Injectable, PayloadTooLargeException, UnprocessableEntityException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ApiService, type ApiDetail } from '../../api-management/services/api.service';
import { CreateApiDto } from '../../api-management/dto/create-api.dto';
import { proxyUrlDenyReason } from '../../api-management/dto/proxy-url.validator';
import { ApiSpecService } from './api-spec.service';
import {
  buildEndpointIndex,
  contentHashOf,
  listServers,
  MAX_ENDPOINTS,
  type EndpointRow,
  type ServerOption,
} from './oas-endpoints';
import { parsesAsJson } from './oas-safety';
import { SpectralLintService, type LintFinding } from './spectral-lint.service';

/**
 * Largest OAS document accepted, in bytes. Enforced twice on purpose and the two are not
 * redundant: `spec-body.middleware.ts` stops the stream at this many bytes so an oversize payload
 * is never fully buffered, and the check here catches a caller that reached the service another
 * way (a direct service call, or a future route that forgets the middleware).
 */
export const MAX_SPEC_BYTES = 5 * 1024 * 1024;

export interface ImportResult {
  api: ApiDetail;
  /**
   * Every finding, including the warnings that did NOT block the import — the acceptance criterion
   * is that a warning-only spec creates the API *and* returns its findings, so they are part of
   * the success payload rather than something the caller has to ask for separately.
   */
  findings: LintFinding[];
  /** The stored copy of the submitted document (OAS-01). */
  spec: { versionNo: number; contentHash: string; endpointCount: number };
}

/** Caller-chosen overrides for the two things a document cannot decide on its own. */
export interface ImportOptions {
  /** Replaces the slug derived from `info.title` (two specs with the same title collide otherwise). */
  slug?: string;
  /** Which `servers[]` entry becomes the upstream. Defaults to the first. */
  serverIndex?: number;
}

/** What an import WOULD do, without doing it (OAS-01). Nothing is written to any table. */
export interface ImportPreview {
  /** The document itself is acceptable: no lint error, a usable derived API, within the endpoint limit. */
  valid: boolean;
  /** `valid` and no slug / listen-path collision: the real import would succeed. */
  canImport: boolean;
  findings: LintFinding[];
  /** Why the derived API is unusable, keyed like the real import's 422 details (`derived:proxyUrl`, …). */
  problems: Record<string, string[]>;
  openapiVersion: string;
  contentHash: string;
  format: 'json' | 'yaml';
  derived: { name: string; slug: string; listenPath: string; proxyUrl: string };
  servers: { index: number; url: string | null; selected: boolean; denyReason: string | null }[];
  conflicts: { slug: boolean; listenPath: boolean };
  endpointCount: number;
  endpoints: EndpointRow[];
}

/** What a caller must fix, grouped by rule id, in the `details` field the error contract already has. */
export function toDetails(findings: LintFinding[]): Record<string, string[]> {
  const details: Record<string, string[]> = {};
  for (const finding of findings) {
    const where = finding.path ? `line ${String(finding.line)} (${finding.path})` : `line ${String(finding.line)}`;
    (details[finding.code] ??= []).push(`${where}: ${finding.message}`);
  }
  return details;
}

/**
 * `info.title` -> URL-safe slug. Decomposes accents first (`Café` -> `cafe`) rather than dropping
 * them, so a non-ASCII title still yields something usable instead of collapsing to empty.
 * `og-info-title-sluggable` in the ruleset has already rejected titles with nothing to slugify.
 */
export function slugifyTitle(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 60)
    .replace(/^-+|-+$/g, '');
}

interface OasShape {
  openapi?: unknown;
  info?: { title?: unknown };
}

/** A document that has passed every check that does not need the database. */
interface Analysis {
  doc: OasShape;
  findings: LintFinding[];
  hasErrors: boolean;
  openapiVersion: string;
  contentHash: string;
  format: 'json' | 'yaml';
  servers: ServerOption[];
  endpoints: EndpointRow[];
  overflow: boolean;
}

interface Derived {
  dto: CreateApiDto;
  /** Empty when the derived API is usable. */
  errors: Record<string, string[]>;
}

@Injectable()
export class ApiImportService {
  constructor(
    private readonly lint: SpectralLintService,
    private readonly apis: ApiService,
    private readonly specs: ApiSpecService,
  ) {}

  /** Everything decidable from the document alone. Throws for a document that cannot be processed at all. */
  private async analyse(source: string): Promise<Analysis> {
    if (Buffer.byteLength(source, 'utf8') > MAX_SPEC_BYTES) {
      throw new PayloadTooLargeException(
        `OAS document exceeds the ${String(MAX_SPEC_BYTES / (1024 * 1024))} MB limit`,
      );
    }

    const { findings, hasErrors, parsed } = await this.lint.lint(source);

    // A document that does not parse at all yields findings but no usable object. Checked before
    // `hasErrors` so the caller is told the real problem rather than a list of schema violations
    // derived from a half-parsed tree.
    if (parsed === undefined || parsed === null || typeof parsed !== 'object') {
      throw new UnprocessableEntityException({
        message: 'Document is not valid JSON or YAML',
        error: 'OAS_IMPORT_UNPARSEABLE',
        details: toDetails(findings),
      });
    }

    const doc = parsed as OasShape;

    // The `oas` ruleset lints Swagger 2.0 happily under its oas2 rules, so a 2.0 document can reach
    // here with zero errors. This WP accepts 3.x only, and that is a separate refusal from linting.
    if (typeof doc.openapi !== 'string' || !doc.openapi.startsWith('3.')) {
      throw new UnprocessableEntityException({
        message: 'Only OpenAPI 3.x documents can be imported (missing or non-3.x "openapi" field)',
        error: 'OAS_IMPORT_UNSUPPORTED_VERSION',
        details: toDetails(findings),
      });
    }

    const { endpoints, overflow } = buildEndpointIndex(doc);
    return {
      doc,
      findings,
      hasErrors,
      openapiVersion: doc.openapi,
      contentHash: contentHashOf(source),
      format: parsesAsJson(source) ? 'json' : 'yaml',
      servers: listServers(doc),
      endpoints,
      overflow,
    };
  }

  async import(source: string, tenantId: string, options: ImportOptions = {}): Promise<ImportResult> {
    const analysis = await this.analyse(source);

    if (analysis.hasErrors) {
      throw new UnprocessableEntityException({
        message: 'OAS document failed the lint gate',
        error: 'OAS_LINT_FAILED',
        // Warnings ride along too: a caller fixing the errors wants to see the rest in one pass.
        details: toDetails(analysis.findings),
      });
    }
    if (analysis.overflow) {
      throw new UnprocessableEntityException({
        message: `The document declares more than ${String(MAX_ENDPOINTS)} operations`,
        error: 'OAS_IMPORT_TOO_MANY_ENDPOINTS',
        details: {},
      });
    }

    const { dto, errors } = await this.derive(analysis, options);
    if (Object.keys(errors).length > 0) {
      throw new UnprocessableEntityException({
        message: 'The document is valid OAS but does not yield a usable API definition',
        error: 'OAS_IMPORT_UNUSABLE',
        details: { ...toDetails(analysis.findings), ...errors },
      });
    }

    // Reuse, not a parallel creation path: `create()` owns slug and listen-path uniqueness, the
    // Prisma conflict mapping, the background sync and the ApiDetail projection. Import's job ends
    // at producing a valid DTO — and, since OAS-01, the spec to store with it in the same transaction.
    const api = await this.apis.create(dto, tenantId, {
      contentHash: analysis.contentHash,
      format: analysis.format,
      openapiVersion: analysis.openapiVersion,
      sourceText: source,
      endpointIndex: analysis.endpoints as unknown as Prisma.InputJsonValue,
      endpointCount: analysis.endpoints.length,
    });

    return {
      api,
      findings: analysis.findings,
      spec: { versionNo: 1, contentHash: analysis.contentHash, endpointCount: analysis.endpoints.length },
    };
  }

  /**
   * What `import` would do, without writing anything. Lint errors and an unusable derived API are
   * REPORTED (`valid: false`) rather than thrown, because a wizard needs them to show the user what
   * to fix; a document that cannot be processed at all (too large, unparseable, not 3.x, unsafe)
   * still fails with the same errors as the real import.
   */
  async preview(source: string, tenantId: string, options: ImportOptions = {}): Promise<ImportPreview> {
    const analysis = await this.analyse(source);
    const { dto, errors } = await this.derive(analysis, options);
    if (analysis.overflow) {
      errors.endpoints = [`The document declares more than ${String(MAX_ENDPOINTS)} operations`];
    }

    const conflicts = await this.specs.conflicts(tenantId, dto.slug, dto.listenPath);
    const valid = !analysis.hasErrors && Object.keys(errors).length === 0;
    const selectedIndex = options.serverIndex ?? 0;

    return {
      valid,
      canImport: valid && !conflicts.slug && !conflicts.listenPath,
      findings: analysis.findings,
      problems: errors,
      openapiVersion: analysis.openapiVersion,
      contentHash: analysis.contentHash,
      format: analysis.format,
      derived: { name: dto.name, slug: dto.slug, listenPath: dto.listenPath, proxyUrl: dto.proxyUrl },
      servers: analysis.servers.map((server) => ({
        index: server.index,
        url: server.url,
        selected: server.index === selectedIndex,
        denyReason: server.url === null ? 'the server URL has a variable with no default' : proxyUrlDenyReason(server.url),
      })),
      conflicts,
      endpointCount: analysis.endpoints.length,
      endpoints: analysis.endpoints,
    };
  }

  /**
   * Derives the `ApiDefinition` fields the spec actually carries, then validates the result with
   * the SAME DTO the hand-written create route uses. That is the point of going through
   * `CreateApiDto` rather than checking fields here: name length, slug shape, listen-path shape,
   * URL validity and the SSRF denylist (`IsAllowedProxyUrl` -> `proxyUrlDenyReason`) are enforced
   * once, in one place, so an imported API can never reach an upstream a hand-created one may not.
   *
   * `authType` is left unset, so the row takes the schema default (NONE). An imported spec's
   * `securitySchemes` describe what the UPSTREAM expects, not what the gateway should enforce, and
   * silently turning one into gateway auth would publish a route nobody asked to protect that way.
   */
  private async derive(analysis: Analysis, options: ImportOptions): Promise<Derived> {
    const title = typeof analysis.doc.info?.title === 'string' ? analysis.doc.info.title.trim() : '';
    const slug = options.slug?.trim() ? options.slug.trim() : slugifyTitle(title);
    const serverIndex = options.serverIndex ?? 0;
    const server = analysis.servers.find((candidate) => candidate.index === serverIndex);

    const dto = plainToInstance(CreateApiDto, {
      // CreateApiDto caps the name at 100 characters; a longer title is truncated rather than
      // rejected, because the title is documentation and the slug (which must be exact) is derived
      // separately.
      name: title.slice(0, 100),
      slug,
      listenPath: `/${slug}/`,
      proxyUrl: server?.url ?? '',
    });

    const errors: Record<string, string[]> = {};
    if (options.serverIndex !== undefined && server === undefined) {
      errors['derived:serverIndex'] = [
        `serverIndex ${String(options.serverIndex)} is out of range: the document lists ${String(analysis.servers.length)} server(s)`,
      ];
    }
    for (const error of await validate(dto, { whitelist: true, forbidNonWhitelisted: true })) {
      errors[`derived:${error.property}`] = Object.values(error.constraints ?? {});
    }
    return { dto, errors };
  }
}
