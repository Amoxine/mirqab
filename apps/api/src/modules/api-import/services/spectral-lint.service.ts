import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import { Spectral, Document } from '@stoplight/spectral-core';
import * as Parsers from '@stoplight/spectral-parsers';
import { openGatewayOasRuleset } from '../oas-ruleset';
import { findExternalRefs, MAX_ALIAS_DOCUMENT_BYTES, MAX_YAML_ALIASES, yamlAliasHazard } from './oas-safety';

/** Spectral's DiagnosticSeverity, which is numeric and easy to invert by accident. */
const SEVERITY_NAME = ['error', 'warning', 'info', 'hint'] as const;
export type LintSeverity = (typeof SEVERITY_NAME)[number];

/** One Spectral finding, flattened to what a client can act on. */
export interface LintFinding {
  /** Rule id, e.g. `oas3-schema` or `og-server-url-absolute`. */
  code: string;
  message: string;
  severity: LintSeverity;
  /** JSON path into the document, e.g. `servers.0.url`. Empty string at the document root. */
  path: string;
  /** 1-based line in the submitted document (Spectral counts from 0). */
  line: number;
}

export interface LintOutcome {
  findings: LintFinding[];
  /** True when at least one finding is `error` — the only thing that blocks an import. */
  hasErrors: boolean;
  /**
   * The parsed document, or undefined when the input is not parseable at all. Spectral parses
   * once and hands back the result, so the import path never parses the payload a second time.
   */
  parsed: unknown;
}

/**
 * Lints an OAS document against the one repo-level ruleset (`oas-ruleset.ts`).
 *
 * JSON and YAML both go through the YAML parser on purpose: YAML 1.2 is a strict superset of JSON,
 * so one parser accepts both and the route needs no content-type sniffing to decide. Verified
 * against a JSON and a YAML copy of the same spec — identical findings, identical parse.
 */
@Injectable()
export class SpectralLintService {
  /**
   * Built once. Compiling the ruleset resolves and compiles every rule's JSON path and regex, which
   * is the expensive part; re-running `run()` on the same instance is cheap.
   */
  private readonly spectral: Spectral;

  constructor() {
    this.spectral = new Spectral();
    this.spectral.setRuleset(openGatewayOasRuleset);
  }

  async lint(source: string): Promise<LintOutcome> {
    // Before the parser: YAML aliases expand exponentially while parsing (see oas-safety.ts).
    const hazard = yamlAliasHazard(source);
    if (hazard) {
      const why =
        hazard.reason === 'too-many-aliases'
          ? `${String(hazard.aliases)} YAML aliases found; at most ${String(MAX_YAML_ALIASES)} are accepted`
          : `a YAML document that uses aliases may be at most ${String(MAX_ALIAS_DOCUMENT_BYTES / 1024)} KB`;
      throw new UnprocessableEntityException({
        message: 'The document uses YAML aliases beyond what an import accepts',
        error: 'OAS_IMPORT_UNSAFE_YAML',
        details: { 'og-yaml-alias-limit': [`line ${String(hazard.line)}: ${why}. Expand the aliases or upload JSON.`] },
      });
    }

    // The YAML parser throws raw errors on some valid tags (`!!binary` → "data.replace is not a
    // function"), both while constructing and on the first `.data` read. Any of them is the caller's
    // document being unusable: a 422 that never echoes the parser's text, not a 500.
    const parse = (): { document: Document<unknown, Parsers.YamlParserResult<unknown>>; data: unknown } => {
      const parsed = new Document(source, Parsers.Yaml);
      return { document: parsed, data: parsed.data };
    };
    let document: ReturnType<typeof parse>['document'];
    let data: unknown;
    try {
      ({ document, data } = parse());
    } catch {
      throw new UnprocessableEntityException({
        message: 'The document is not valid YAML or JSON',
        error: 'OAS_IMPORT_UNPARSEABLE',
      });
    }

    // Before the linter: Spectral's default resolver would FOLLOW an http(s) or file `$ref`, so the
    // uploaded document could make this process fetch a URL or read a file. A document with any
    // external reference is rejected here and `Spectral.run` is never called on it.
    const external = findExternalRefs(data);
    if (external.length > 0) {
      const findings: LintFinding[] = external.map(({ path, ref }) => ({
        code: 'og-no-external-ref',
        message: `External $ref "${ref.slice(0, 200)}" is not allowed: only local references (#/…) are resolved. Inline the referenced document.`,
        severity: 'error',
        path: [...path, '$ref'].join('.'),
        line: (document.getRangeForJsonPath([...path, '$ref'], true)?.start.line ?? 0) + 1,
      }));
      return { findings, hasErrors: true, parsed: data };
    }

    const results = await this.spectral.run(document);

    const findings: LintFinding[] = results.map((result) => ({
      code: String(result.code),
      message: result.message,
      severity: SEVERITY_NAME[result.severity] ?? 'error',
      path: result.path.join('.'),
      line: result.range.start.line + 1,
    }));

    return {
      findings,
      hasErrors: findings.some((finding) => finding.severity === 'error'),
      parsed: data,
    };
  }
}
