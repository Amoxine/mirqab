import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { loadInventory, validate, buildFileSd, buildTextfile } from './render-inventory.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, 'render-inventory.mjs');
const inventoryDir = join(here, '../inventory');
const examplePath = join(inventoryDir, 'opengateway.example.yaml');

function renderExample() {
  const outDir = mkdtempSync(join(tmpdir(), 'og-inv-'));
  execFileSync('node', [script, '--in', examplePath, '--out-dir', outDir]);
  return outDir;
}

const ALLOWED_FILE_SD_LABELS = new Set(['environment', 'site', 'failure_domain', 'asset_id', 'role', 'node']);

test('the example renders with exit 0', () => {
  const outDir = renderExample();
  const fileSdFiles = readdirSync(join(outDir, 'file_sd'));
  assert.ok(fileSdFiles.length > 0, 'expected at least one file_sd/<job>.json');
  assert.ok(readFileSync(join(outDir, 'og_inventory.prom'), 'utf8').length > 0);
});

test('file_sd output matches the expected shape and labels', () => {
  const outDir = renderExample();
  const nodeTargets = JSON.parse(readFileSync(join(outDir, 'file_sd/node.json'), 'utf8'));
  assert.deepEqual(nodeTargets, [
    {
      targets: ['h01.example.internal:9100'],
      labels: {
        asset_id: 'og-zz-h01',
        environment: 'prod',
        site: 'site-zz-01',
        failure_domain: 'fd-zz-01-a',
        role: 'edge',
      },
    },
  ]);

  const probeTyk = JSON.parse(readFileSync(join(outDir, 'file_sd/probe-tyk_hello.json'), 'utf8'));
  assert.equal(probeTyk[0].targets[0], 'http://tyk-gateway:8081/hello');
  assert.equal(probeTyk[0].labels.node, 'tyk-1');
  // the container inherits site/failure_domain/environment from its parent host (02 §2.2)
  assert.equal(probeTyk[0].labels.site, 'site-zz-01');
  assert.equal(probeTyk[0].labels.failure_domain, 'fd-zz-01-a');
  assert.equal(probeTyk[0].labels.environment, 'prod');
  assert.equal(probeTyk[0].labels.asset_id, 'og-zz-h01-tyk-1');
});

test('no forbidden labels appear in any output', () => {
  const outDir = renderExample();
  for (const file of readdirSync(join(outDir, 'file_sd'))) {
    const groups = JSON.parse(readFileSync(join(outDir, 'file_sd', file), 'utf8'));
    for (const group of groups) {
      for (const key of Object.keys(group.labels)) {
        assert.ok(ALLOWED_FILE_SD_LABELS.has(key), `${file}: forbidden label "${key}"`);
      }
    }
  }

  const prom = readFileSync(join(outDir, 'og_inventory.prom'), 'utf8');
  const allowedByMetric = {
    og_asset_info: new Set(['asset_id', 'hostname', 'site', 'failure_domain', 'role', 'environment']),
    og_inventory_last_verified_timestamp_seconds: new Set(['asset_id']),
    og_expected_container: new Set(['asset_id', 'name']),
  };
  for (const line of prom.split('\n')) {
    const m = /^(\w+)\{([^}]*)\}/.exec(line);
    if (!m) continue;
    const [, metric, labelStr] = m;
    const allowed = allowedByMetric[metric];
    assert.ok(allowed, `unexpected metric family "${metric}"`);
    for (const pair of labelStr.split(',')) {
      const key = pair.split('=')[0];
      assert.ok(allowed.has(key), `${metric}: forbidden label "${key}"`);
    }
  }
});

test('a duplicate asset_id fails validation', () => {
  const inv = loadInventory(readFileSync(examplePath, 'utf8'));
  inv.assets.push({ ...inv.assets[0] });
  const errors = validate(inv);
  assert.ok(errors.some((e) => e.includes('duplicate asset_id')), errors.join('\n'));
});

test('a dangling reference fails validation', () => {
  const inv = loadInventory(readFileSync(examplePath, 'utf8'));
  inv.assets[0].failure_domain = 'fd-does-not-exist';
  const errors = validate(inv);
  assert.ok(errors.some((e) => e.includes('fd-does-not-exist')), errors.join('\n'));
});

test('a bad node alias fails validation', () => {
  const inv = loadInventory(readFileSync(examplePath, 'utf8'));
  const container = inv.assets.find((a) => a.kind === 'container');
  container.node = 'gw-1';
  const errors = validate(inv);
  assert.ok(errors.some((e) => e.includes('does not match ^tyk-[0-9]+$')), errors.join('\n'));
});

test('a missing required field fails validation', () => {
  const inv = loadInventory(readFileSync(examplePath, 'utf8'));
  delete inv.assets[0].criticality;
  const errors = validate(inv);
  assert.ok(errors.some((e) => e.includes('missing required field "criticality"')), errors.join('\n'));
});

test('roles must be a non-empty array of strings, not a bare string', () => {
  const inv = loadInventory(readFileSync(examplePath, 'utf8'));
  inv.assets[0].roles = 'edge'; // a string is iterable — would silently become ['e','d','g','e']
  const errors = validate(inv);
  assert.ok(errors.some((e) => e.includes('"roles" must be a non-empty array of strings')), errors.join('\n'));
});

test('roles cannot be an empty array', () => {
  const inv = loadInventory(readFileSync(examplePath, 'utf8'));
  inv.assets[0].roles = [];
  const errors = validate(inv);
  assert.ok(errors.some((e) => e.includes('"roles" must be a non-empty array of strings')), errors.join('\n'));
});

test('a scrape_target job with path-traversal characters fails validation', () => {
  const inv = loadInventory(readFileSync(examplePath, 'utf8'));
  inv.assets[0].scrape_targets[0].job = '../../etc/passwd';
  const errors = validate(inv);
  assert.ok(
    errors.some((e) => e.includes('scrape_targets[0].job') && e.includes('must match ^[A-Za-z0-9_.-]+$')),
    errors.join('\n'),
  );
});

test('a probe_target module or job with forbidden characters fails validation', () => {
  const inv = loadInventory(readFileSync(examplePath, 'utf8'));
  const container = inv.assets.find((a) => a.kind === 'container');
  container.probe_targets[0].job = 'foo/bar';
  const errors = validate(inv);
  assert.ok(
    errors.some((e) => e.includes('probe_targets[0].job') && e.includes('must match ^[A-Za-z0-9_.-]+$')),
    errors.join('\n'),
  );
});

test('an unparseable last_verified_at fails validation', () => {
  const inv = loadInventory(readFileSync(examplePath, 'utf8'));
  inv.assets[0].last_verified_at = 'not-a-date';
  const errors = validate(inv);
  assert.ok(errors.some((e) => e.includes('is not a parseable date')), errors.join('\n'));
});

test('a probe_target job overrides the probe-<module> filename', () => {
  const inv = loadInventory(readFileSync(examplePath, 'utf8'));
  const container = inv.assets.find((a) => a.kind === 'container');
  container.probe_targets[0].job = 'tyk-hello';
  assert.deepEqual(validate(inv), []);
  const byJob = buildFileSd(inv);
  assert.ok(byJob.has('tyk-hello'), 'expected the explicit job name to be used');
  assert.ok(!byJob.has('probe-tyk_hello'), 'the probe-<module> fallback should not apply once job is set');
});

test('valid inventory passes validation', () => {
  const inv = loadInventory(readFileSync(examplePath, 'utf8'));
  assert.deepEqual(validate(inv), []);
});

test('output is deterministic across runs', () => {
  const outA = renderExample();
  const outB = renderExample();
  for (const file of ['file_sd/node.json', 'file_sd/cadvisor.json', 'file_sd/probe-icmp.json', 'og_inventory.prom']) {
    assert.equal(readFileSync(join(outA, file), 'utf8'), readFileSync(join(outB, file), 'utf8'), file);
  }
});

// Guard: every IP literal committed under infra/inventory/*.yaml must be RFC 5737 documentation
// space. This is what stops a real host IP from landing in the public repo (04 §3 OG-OBS-00 risk).
test('every IP literal in infra/inventory/*.yaml is RFC 5737', () => {
  const rfc5737 = (ip) => ip.startsWith('192.0.2.') || ip.startsWith('198.51.100.') || ip.startsWith('203.0.113.');
  for (const file of readdirSync(inventoryDir).filter((f) => f.endsWith('.yaml'))) {
    const text = readFileSync(join(inventoryDir, file), 'utf8');
    const matches = text.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g) ?? [];
    for (const ip of matches) {
      assert.ok(
        ip.split('.').every((octet) => Number(octet) <= 255),
        `${file}: "${ip}" is not a valid IPv4 literal`,
      );
      assert.ok(rfc5737(ip), `${file}: "${ip}" is not in an RFC 5737 documentation range`);
    }
  }
});

test('buildFileSd/buildTextfile are exported and usable standalone', () => {
  const inv = loadInventory(readFileSync(examplePath, 'utf8'));
  assert.equal(validate(inv).length, 0);
  assert.ok(buildFileSd(inv).size > 0);
  assert.ok(buildTextfile(inv).includes('og_asset_info{'));
});
