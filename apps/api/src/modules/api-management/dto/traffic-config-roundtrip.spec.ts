import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { ApiConfigDto, EDGE_BODY_LIMIT_BYTES } from './api-config.dto';

/**
 * WP15a: "every field round-trips through GET /apis/:id and survives a reconcile tick".
 *
 * The storage path is `ApiConfigDto` -> validate -> `JSON.parse(JSON.stringify(...))` (what
 * `toJsonObject` does) -> the `config` JSON column -> returned verbatim by `toApiDetail`. No mapper
 * is involved in either direction, and a reconcile tick writes only `syncState`, so what this has
 * to prove is that validation accepts the whole traffic surface and that serialisation loses
 * nothing — which is where a `@Type`-less nested DTO or a dropped field would actually show up.
 */
const fullTrafficConfig = {
  rateLimit: { rate: 10, per: 1 },
  throttle: { retryLimit: 3, intervalSeconds: 2 },
  timeoutSeconds: 5,
  circuitBreaker: { threshold: 0.5, sampleSize: 10, coolDownSeconds: 30 },
  requestSizeLimitBytes: 2048,
  loadBalancing: {
    targets: [{ url: 'http://a:4000', weight: 1 }, { url: 'http://b:4000', weight: 2 }],
    skipUnavailableHosts: true,
  },
  uptimeTests: [{ url: 'http://a:4000/health', method: 'GET', timeoutSeconds: 3 }],
};

const validate = (config: Record<string, unknown>) =>
  validateSync(plainToInstance(ApiConfigDto, config), { whitelist: true, forbidNonWhitelisted: true });

describe('traffic config round-trip', () => {
  it('accepts the full traffic surface', () => {
    expect(validate(fullTrafficConfig)).toHaveLength(0);
  });

  it('survives store-and-read without losing or reshaping a field', () => {
    const stored: unknown = JSON.parse(JSON.stringify(plainToInstance(ApiConfigDto, fullTrafficConfig)));
    expect(stored).toEqual(fullTrafficConfig);
  });

  it('rejects a request size limit above the edge limit instead of clamping it', () => {
    // Clamping would make GET /apis/:id disagree with what the operator wrote, and would quietly
    // move which component answers an oversize body.
    const errors = validate({ ...fullTrafficConfig, requestSizeLimitBytes: EDGE_BODY_LIMIT_BYTES + 1 });
    expect(errors).toHaveLength(1);
    expect(errors[0].property).toBe('requestSizeLimitBytes');
  });

  it('accepts exactly the edge limit', () => {
    expect(validate({ requestSizeLimitBytes: EDGE_BODY_LIMIT_BYTES })).toHaveLength(0);
  });

  it('rejects a circuit-breaker threshold outside 0..1', () => {
    expect(validate({ circuitBreaker: { threshold: 1.5, sampleSize: 10, coolDownSeconds: 30 } })).toHaveLength(1);
  });

  it('rejects a load-balancing target pointing at the platform itself (SSRF)', () => {
    const errors = validate({ loadBalancing: { targets: [{ url: 'http://tyk-gateway:8080', weight: 1 }] } });
    expect(errors).toHaveLength(1);
  });
});
