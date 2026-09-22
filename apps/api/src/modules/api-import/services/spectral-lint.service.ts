import { Injectable } from '@nestjs/common';
import { Spectral, Document } from '@stoplight/spectral-core';
import * as Parsers from '@stoplight/spectral-parsers';
import { openGatewayOasRuleset } from '../oas-ruleset';

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
    const document = new Document(source, Parsers.Yaml);
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
      parsed: document.data,
    };
  }
}
