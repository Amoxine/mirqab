import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import fixture from './__fixtures__/tyk-oas-operation-fields.v5.15.0.json';
import { capabilityFor, ENDPOINT_CAPABILITIES, OFFERABLE_ENDPOINT_FIELDS } from './endpoint-capabilities';

/**
 * The capability table is only worth anything if it stays complete and stays tied to evidence.
 * These checks fail when a gateway upgrade adds a control nobody has classified, when a table entry
 * names a field the gateway does not have, or when an "enforced" claim loses its e2e probe.
 */

const E2E = readFileSync(join(__dirname, '../../../../test/e2e/oas-endpoint-capabilities.e2e.mjs'), 'utf8');
const gatewayFields = Object.keys(fixture.operationControls);

describe('ENDPOINT_CAPABILITIES', () => {
  it('classifies every control the gateway accepts, exactly once', () => {
    const classified = ENDPOINT_CAPABILITIES.map((c) => c.tykField).sort();

    expect(classified).toEqual([...gatewayFields].sort());
    expect(new Set(classified).size).toBe(classified.length);
  });

  it('names only fields the gateway\'s own schema has', () => {
    for (const { tykField } of ENDPOINT_CAPABILITIES) expect(gatewayFields).toContain(tykField);
  });

  it('gives every prerequisite-gated entry its prerequisite, and only those', () => {
    for (const c of ENDPOINT_CAPABILITIES) {
      expect(Boolean(c.prerequisite)).toBe(c.status === 'enforced-with-prerequisite');
    }
  });

  it('ties every enforced claim to a probe in the e2e (its field is exercised there)', () => {
    for (const c of ENDPOINT_CAPABILITIES.filter((x) => x.status !== 'unverified')) {
      expect(E2E).toMatch(new RegExp(`\\b${c.tykField}\\b\\s*:`));
    }
  });

  it('offers exactly the enforced controls, and never an unverified one', () => {
    expect([...OFFERABLE_ENDPOINT_FIELDS].sort()).toEqual(
      ['allow', 'block', 'cache', 'enforceTimeout', 'ignoreAuthentication', 'mockResponse', 'rateLimit', 'requestSizeLimit', 'validateRequest'],
    );
    expect(OFFERABLE_ENDPOINT_FIELDS).not.toContain('circuitBreaker');
  });

  it('looks a capability up by gateway field', () => {
    expect(capabilityFor('cache')?.prerequisite).toMatch(/global\.cache/);
    expect(capabilityFor('nope')).toBeUndefined();
  });

  it('records the pinned gateway image it was read from', () => {
    expect(fixture.source).toMatch(/tyk-gateway:v5\.15\.0/);
  });
});
