/**
 * WP26a acceptance, end to end against the live stack and real Postgres.
 *
 * Run it (needs the throwaway mTLS upstream + certs set up first — see PREREQUISITES):
 *   docker cp apps/api/test/e2e/certificates-mtls.e2e.mjs open-gateway-api:/tmp/certificates-mtls.e2e.mjs
 *   docker cp <dir with client-combined.pem> open-gateway-api:/tmp/wp26a
 *   docker exec open-gateway-api node /tmp/certificates-mtls.e2e.mjs
 *
 * Same shape and same reason as plans-quotas.e2e.mjs next door: it runs INSIDE the api container,
 * driving compiled services from dist/ and talking to Tyk's control API (8081, unpublished) and to
 * Postgres through the real Prisma client. It exercises the REAL CertificateService and the REAL
 * `mapToTykOas` — only HTTP auth is out of scope (RBAC has its own wiring specs and a host-side
 * live run; this file is about the Tyk contract).
 *
 * PREREQUISITES (the script cannot start containers itself):
 *   - a TLS upstream that DEMANDS a client certificate, reachable as `${UPSTREAM_HOST}` on the
 *     gateway's docker network, answering 200 `{"ok":true,"client_cn":"$ssl_client_s_dn"}` when one
 *     is presented (nginx: `ssl_verify_client on;` + `return 200 ...`);
 *   - the client certificate + private key concatenated as one PEM at /tmp/wp26a/client-combined.pem.
 *
 * Covers what unit tests structurally cannot:
 *   1. upload -> Tyk holds it; the response (and every read) never carries private key material
 *   2. org scoping: another tenant's list excludes it, and its delete answers 404 with the cert intact;
 *      a tenant whose org id is a strict PREFIX of another's cannot list or delete that org's certs
 *      (Tyk's own list filter is a prefix match — 2c proves our layer is what stops it); and a cert
 *      an API still references cannot be deleted (delete is NOT revoke — see 2b)
 *   3. certs are visible on every node in TYK_ADMIN_URLS (S7: Redis-shared, so no fan-out needed)
 *   4. UPSTREAM mTLS: the exact OAS document `mapToTykOas` emits presents the cert to a demanding
 *      upstream (200), and the same API without it never reaches the protected resource
 *   5. cleanup leaves the gateway and Postgres as found
 *
 * TEST-HARNESS-ONLY: the throwaway upstream's server certificate is signed by a throwaway CA the
 * gateway does not trust, so step 4 adds `upstream.tlsTransport.insecureSkipVerify` to the document
 * AFTER the mapper ran. That isolates what this test is about (is the CLIENT cert presented?) from
 * server-certificate trust, and is never something the product emits.
 */
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

const ROOT = '/app/apps/api/dist';
const require = createRequire('/app/apps/api/package.json');
require('reflect-metadata');

const { prisma, tykOrgIdFor } = require('@open-gateway/database');
const { CertificateService } = require(`${ROOT}/modules/certificates/services/certificate.service.js`);
const { TykClientService } = require(`${ROOT}/modules/tyk-integration/services/tyk-client.service.js`);
const { CircuitBreakerService } = require(`${ROOT}/common/circuit-breaker/circuit-breaker.service.js`);
const { mapToTykOas } = require(`${ROOT}/modules/api-management/services/tyk-mappers.js`);

const config = { get: (key, fallback) => process.env[key] ?? fallback };
// The cert methods never touch Redis (only cache invalidation does), so a stub is enough here.
const tyk = new TykClientService(config, new CircuitBreakerService(), {});
const certs = new CertificateService(tyk);

const SECRET = process.env.TYK_ADMIN_SECRET ?? '';
const ADMIN = process.env.TYK_ADMIN_URL ?? 'http://tyk-gateway:8081/tyk';
const DATA = process.env.TYK_DATA_URL ?? 'http://tyk-gateway:8080';
const NODES = (process.env.TYK_ADMIN_URLS || ADMIN).split(',').map((s) => s.trim()).filter(Boolean);
const UPSTREAM_HOST = process.env.UPSTREAM_HOST ?? 'wp26a-mtls-upstream';
const CLIENT_PEM = readFileSync('/tmp/wp26a/client-combined.pem', 'utf8');

const results = [];
const check = (label, actual, expected) => {
  const ok = String(actual) === String(expected);
  results.push({ label, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}: ${actual} (expected ${expected})`);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const adminGet = (base, path) => fetch(`${base}${path}`, { headers: { 'x-tyk-authorization': SECRET } });

const suffix = Date.now().toString(36);
const tenantA = { id: randomUUID(), slug: `wp26a-a-${suffix}` };
const tenantB = { id: randomUUID(), slug: `wp26a-b-${suffix}` };
const createdApis = [];
let certId;
let prefixCertId;

async function makeTenant({ id, slug }) {
  await prisma.tenant.create({ data: { id, tykOrgId: tykOrgIdFor(id), name: slug, slug, plan: 'FREE' } });
}

/** A minimal ApiDefinition row — only the fields `mapToTykOas` reads. */
const apiDef = (tenant, over) => ({
  id: randomUUID(),
  tenantId: tenant.id,
  name: over.name,
  slug: over.name,
  tykApiId: `og-${over.name}-${suffix}`,
  proxyUrl: `https://${UPSTREAM_HOST}/`,
  listenPath: `/${over.name}/`,
  authType: 'NONE',
  status: 'ACTIVE',
  config: over.config ?? {},
  protocol: 'HTTP',
  listenPort: null,
  parentApiId: null,
  versionName: null,
  webhooksEnabled: false,
});

async function deployAndCall(tenant, def) {
  const doc = mapToTykOas(def, { tykOrgId: tykOrgIdFor(tenant.id), slug: tenant.slug }, '', []);
  // TEST-HARNESS-ONLY, see the file header.
  doc['x-tyk-api-gateway'].upstream.tlsTransport = { insecureSkipVerify: true };
  createdApis.push(def.tykApiId);
  await tyk.upsertOasApi(doc);
  await sleep(1500);
  const path = doc['x-tyk-api-gateway'].server.listenPath.value;
  const res = await fetch(`${DATA}${path}`);
  return { status: res.status, body: await res.text(), doc };
}

try {
  await makeTenant(tenantA);
  await makeTenant(tenantB);

  // ── 1. upload; the private key never comes back ────────────────────────────
  const created = await certs.create({ pem: CLIENT_PEM }, tenantA.id);
  certId = created.id;
  check('upload returns the cert id scoped by the tenant org', certId.startsWith(tykOrgIdFor(tenantA.id)), true);
  check('upload reports hasPrivate (the key was stored)', created.hasPrivate, true);
  // The ownership check peels a fixed-length fingerprint off the id, so pin that shape on real data.
  check('the id suffix is exactly the 64-char sha256 fingerprint', certId.slice(tykOrgIdFor(tenantA.id).length), created.fingerprint);
  check('...which is 64 lowercase hex chars', /^[0-9a-f]{64}$/.test(created.fingerprint), true);
  check('upload response carries no private key', JSON.stringify(created).includes('PRIVATE KEY'), false);

  const listA = await certs.findAll(tenantA.id);
  check('tenant A lists the cert', listA.some((c) => c.id === certId), true);
  check('no list entry carries private key material', JSON.stringify(listA).includes('PRIVATE KEY'), false);

  // Tyk's own raw GET, bypassing our service entirely: the key must not be in Tyk's answer either.
  const raw = await (await adminGet(ADMIN, `/certs/${certId}`)).text();
  check("Tyk's own GET /certs/{id} carries no private key", raw.includes('PRIVATE KEY'), false);

  // ── 2. org scoping ─────────────────────────────────────────────────────────
  check('tenant B lists no certificates', (await certs.findAll(tenantB.id)).length, 0);
  let crossTenantDelete = 'no error';
  try {
    await certs.remove(certId, tenantB.id);
  } catch (err) {
    crossTenantDelete = err.constructor.name;
  }
  check("tenant B deleting tenant A's cert answers NotFoundException", crossTenantDelete, 'NotFoundException');
  check('...and the cert is still there', (await adminGet(ADMIN, `/certs/${certId}`)).status, 200);
  const otherOrg = await (await adminGet(ADMIN, `/certs?org_id=${encodeURIComponent(tykOrgIdFor(tenantB.id))}`)).json();
  check("Tyk's own list for tenant B's org excludes it", (otherOrg.certs ?? []).includes(certId), false);

  // ── 2c. a strict-prefix org cannot see or touch the longer org's certs ─────
  // Tyk's `?org_id=` filter is a PREFIX match (measured), so a tenant whose org id is a prefix of
  // another's is handed that org's ids by the gateway itself. Unreachable through the API today (org
  // ids are server-generated, 39 chars) but the schema does not constrain it, so build it directly.
  const shortOrg = `og-wp26a-pfx-${suffix}`;
  const longOrg = `${shortOrg}-longer`;
  const tenantShort = { id: randomUUID(), slug: `wp26a-s-${suffix}` };
  const tenantLong = { id: randomUUID(), slug: `wp26a-l-${suffix}` };
  await prisma.tenant.create({ data: { ...tenantShort, tykOrgId: shortOrg, name: tenantShort.slug, plan: 'FREE' } });
  await prisma.tenant.create({ data: { ...tenantLong, tykOrgId: longOrg, name: tenantLong.slug, plan: 'FREE' } });
  prefixCertId = (await certs.create({ pem: CLIENT_PEM }, tenantLong.id)).id;
  const rawShortList = await (await adminGet(ADMIN, `/certs?org_id=${encodeURIComponent(shortOrg)}`)).json();
  check("Tyk's OWN list for the short org includes the longer org's cert (the gateway is prefix-matching)", (rawShortList.certs ?? []).includes(prefixCertId), true);
  check("...but the short tenant's service-level list does not", (await certs.findAll(tenantShort.id)).length, 0);
  let prefixDelete = 'no error';
  try {
    await certs.remove(prefixCertId, tenantShort.id);
  } catch (err) {
    prefixDelete = err.constructor.name;
  }
  check("...and its delete of that cert answers NotFoundException", prefixDelete, 'NotFoundException');
  check('...the cert is intact', (await adminGet(ADMIN, `/certs/${prefixCertId}`)).status, 200);
  check('the long tenant still lists its own cert', (await certs.findAll(tenantLong.id)).some((c) => c.id === prefixCertId), true);
  await tyk.deleteCert(prefixCertId, longOrg);
  prefixCertId = undefined;
  await prisma.tenant.deleteMany({ where: { id: { in: [tenantShort.id, tenantLong.id] } } });

  // ── 2d. an upload Tyk accepts but cannot read back is rolled back, not orphaned ──
  // Only when an ed25519 PEM is supplied: Tyk says "Certificate added" and then 404s the GET.
  if (existsSync('/tmp/wp26a/ed25519.pem')) {
    const before = (await (await adminGet(ADMIN, `/certs?org_id=${encodeURIComponent(tykOrgIdFor(tenantA.id))}`)).json()).certs ?? [];
    let unreadable = 'no error';
    try {
      await certs.create({ pem: readFileSync('/tmp/wp26a/ed25519.pem', 'utf8') }, tenantA.id);
    } catch (err) {
      unreadable = err.constructor.name;
    }
    check('an unreadable (ed25519) upload answers BadRequestException', unreadable, 'BadRequestException');
    const after = (await (await adminGet(ADMIN, `/certs?org_id=${encodeURIComponent(tykOrgIdFor(tenantA.id))}`)).json()).certs ?? [];
    check('...and leaves nothing behind in Tyk', after.length, before.length);
  } else {
    console.log('SKIP  2d (no /tmp/wp26a/ed25519.pem supplied)');
  }

  // ── 2b. delete is not revoke: an attached cert cannot be deleted ────────────
  // Measured on v5.15.0: an API that already has a cert attached keeps presenting it after the
  // cert is deleted (even across an upstream reconnect and a reload), so the service refuses.
  const attachedRow = await prisma.apiDefinition.create({
    data: {
      tenantId: tenantA.id,
      name: `wp26a-attached-${suffix}`,
      slug: `wp26a-attached-${suffix}`,
      proxyUrl: `https://${UPSTREAM_HOST}/`,
      listenPath: `/wp26a-attached-${suffix}/`,
      config: { upstreamMutualTls: { certificateId: certId } },
    },
  });
  let attachedDelete = 'no error';
  try {
    await certs.remove(certId, tenantA.id);
  } catch (err) {
    attachedDelete = err.constructor.name;
  }
  check('deleting a cert an API still references answers ConflictException', attachedDelete, 'ConflictException');
  check('...and the cert is still stored', (await adminGet(ADMIN, `/certs/${certId}`)).status, 200);
  await prisma.apiDefinition.delete({ where: { id: attachedRow.id } });

  // ── 3. present on every node (S7: Redis-shared, so no fan-out was needed to get here) ──
  for (const node of NODES) {
    check(`cert visible on node ${node}`, (await adminGet(node, `/certs/${certId}`)).status, 200);
  }

  // ── 4. upstream mTLS ───────────────────────────────────────────────────────
  const withCert = await deployAndCall(
    tenantA,
    apiDef(tenantA, { name: 'wp26a-with', config: { upstreamMutualTls: { certificateId: certId } } }),
  );
  check('with the cert attached: the demanding upstream answers 200', withCert.status, 200);
  check('...and saw our client certificate', withCert.body.includes('tyk-client'), true);
  check(
    'the emitted document keys the cert on the bare hostname',
    withCert.doc['x-tyk-api-gateway'].upstream.mutualTLS.domainToCertificateMapping[0].domain,
    UPSTREAM_HOST,
  );

  const withoutCert = await deployAndCall(tenantA, apiDef(tenantA, { name: 'wp26a-without' }));
  check('without the cert: never a 200', withoutCert.status === 200, false);
  check('...and the protected resource was never reached', withoutCert.body.includes('"ok":true'), false);
  console.log(`      (without-cert status ${String(withoutCert.status)} — upstream-dependent: an HTTP-layer reject is passed through, a TLS-layer reject is a gateway 500 "problem proxying the request")`);
} finally {
  // ── 5. cleanup ─────────────────────────────────────────────────────────────
  for (const apiId of createdApis) await tyk.deleteApi(apiId).catch((e) => console.log(`cleanup api ${apiId}: ${e.message}`));
  if (certId) await tyk.deleteCert(certId, tykOrgIdFor(tenantA.id)).catch((e) => console.log(`cleanup cert: ${e.message}`));
  if (prefixCertId) await tyk.deleteCert(prefixCertId, `og-wp26a-pfx-${suffix}-longer`).catch((e) => console.log(`cleanup prefix cert: ${e.message}`));
  await prisma.tenant.deleteMany({ where: { OR: [{ id: { in: [tenantA.id, tenantB.id] } }, { slug: { in: [`wp26a-s-${suffix}`, `wp26a-l-${suffix}`] } }] } });
  check('cleanup removed the cert from Tyk', certId ? (await adminGet(ADMIN, `/certs/${certId}`)).status : 404, 404);
  await prisma.$disconnect();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
