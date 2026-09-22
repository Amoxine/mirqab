import { Injectable, PayloadTooLargeException, UnprocessableEntityException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ApiService, type ApiDetail } from '../../api-management/services/api.service';
import { CreateApiDto } from '../../api-management/dto/create-api.dto';
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
}

/** What a caller must fix, grouped by rule id, in the `details` field the error contract already has. */
function toDetails(findings: LintFinding[]): Record<string, string[]> {
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
  servers?: { url?: unknown }[];
}

@Injectable()
export class ApiImportService {
  constructor(
    private readonly lint: SpectralLintService,
    private readonly apis: ApiService,
  ) {}

  async import(source: string, tenantId: string): Promise<ImportResult> {
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

    if (hasErrors) {
      throw new UnprocessableEntityException({
        message: 'OAS document failed the lint gate',
        error: 'OAS_LINT_FAILED',
        // Warnings ride along too: a caller fixing the errors wants to see the rest in one pass.
        details: toDetails(findings),
      });
    }

    const dto = await this.deriveDto(doc, findings);

    // Reuse, not a parallel creation path: `create()` owns slug and listen-path uniqueness, the
    // Prisma conflict mapping, the background sync and the ApiDetail projection. Import's job ends
    // at producing a valid DTO.
    const api = await this.apis.create(dto, tenantId);

    return { api, findings };
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
  private async deriveDto(doc: OasShape, findings: LintFinding[]): Promise<CreateApiDto> {
    const title = typeof doc.info?.title === 'string' ? doc.info.title.trim() : '';
    const serverUrl = typeof doc.servers?.[0]?.url === 'string' ? doc.servers[0].url : '';
    const slug = slugifyTitle(title);

    const dto = plainToInstance(CreateApiDto, {
      // CreateApiDto caps the name at 100 characters; a longer title is truncated rather than
      // rejected, because the title is documentation and the slug (which must be exact) is derived
      // separately.
      name: title.slice(0, 100),
      slug,
      listenPath: `/${slug}/`,
      proxyUrl: serverUrl,
    });

    const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
    if (errors.length > 0) {
      const details = toDetails(findings);
      for (const error of errors) {
        details[`derived:${error.property}`] = Object.values(error.constraints ?? {});
      }
      throw new UnprocessableEntityException({
        message: 'The document is valid OAS but does not yield a usable API definition',
        error: 'OAS_IMPORT_UNUSABLE',
        details,
      });
    }

    return dto;
  }
}
