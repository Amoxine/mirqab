import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EDGE_BODY_LIMIT_BYTES } from './api-config.dto';

/**
 * Two components can answer an oversize request body: Coraza at the edge (WP26b) and Tyk's per-API
 * request size limit (WP15a). The smaller one wins, so WP15a caps the per-API limit at the edge's
 * value — which is what makes the 413 reliably Tyk's, and therefore attributable.
 *
 * That only holds while the two numbers agree. Nothing in the type system connects a Caddyfile
 * directive to a TypeScript constant, so this test connects them: it parses the real Caddyfile and
 * fails if the edge limit is changed without changing `EDGE_BODY_LIMIT_BYTES` to match.
 *
 * Same shape as the compose-parsing SSRF test, which has already caught two real gaps (WP26b's
 * `edge` service and WP13a's multinode nodes).
 */
describe('EDGE_BODY_LIMIT_BYTES tracks the edge Caddyfile', () => {
  const caddyfile = readFileSync(join(__dirname, '../../../../../../infra/edge/Caddyfile'), 'utf8');

  const directiveValue = (name: string): number | null => {
    const match = new RegExp(`^\\s*${name}\\s+(\\d+)\\s*$`, 'm').exec(caddyfile);
    return match ? Number(match[1]) : null;
  };

  it('finds the Coraza body-limit directives at all (guards against a silent rename)', () => {
    expect(directiveValue('SecRequestBodyLimit')).not.toBeNull();
    expect(directiveValue('SecRequestBodyNoFilesLimit')).not.toBeNull();
  });

  it('matches SecRequestBodyLimit exactly', () => {
    expect(directiveValue('SecRequestBodyLimit')).toBe(EDGE_BODY_LIMIT_BYTES);
  });

  it('matches SecRequestBodyNoFilesLimit exactly', () => {
    // Both directives share one constant at the edge; if they ever diverge there, the per-API cap
    // has two different ceilings to be smaller than and the attribution argument breaks.
    expect(directiveValue('SecRequestBodyNoFilesLimit')).toBe(EDGE_BODY_LIMIT_BYTES);
  });
});
