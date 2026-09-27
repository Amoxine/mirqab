#!/usr/bin/env node
// OG-OBS-00: turns the inventory YAML (docs/ha-observability/02 §2.1) into Prometheus file_sd
// JSON and a textfile-collector .prom file. Validation is hand-written on purpose — no ajv, no
// schema.json at runtime; infra/inventory/schema.json is the human/tooling-facing description of
// the same shape, kept in sync by hand.
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';

// Labels allowed on metrics (02 §4): environment, site, failure_domain, asset_id, role, node.
// This regex is what keeps a stray value (a raw path, a comma-joined role list, ...) from ever
// reaching a label.
const LABEL_CHARS = /^[A-Za-z0-9_.:-]*$/;
const NODE_PATTERN = /^tyk-[0-9]+$/;
// job/module become file_sd/<this>.json filenames — reject anything that could path-traverse
// (a "/" or "..segment") before it ever reaches a path.join.
const JOB_PATTERN = /^[A-Za-z0-9_.-]+$/;

// Plain code-unit comparison, not String.prototype.localeCompare: locale-aware collation can
// order the same two strings differently across machines/ICU versions, which is exactly what
// "deterministic, stable across runs" (OG-OBS-00 AT-1) rules out.
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--in') args.in = argv[(i += 1)];
    else if (argv[i] === '--out-dir') args.outDir = argv[(i += 1)];
  }
  if (!args.in || !args.outDir) {
    throw new Error('usage: render-inventory.mjs --in <yaml> --out-dir <dir>');
  }
  return args;
}

export function loadInventory(yamlText) {
  return parse(yamlText);
}

const REQUIRED_ASSET_COMMON = ['asset_id', 'kind', 'criticality', 'exposure', 'owner', 'last_verified_at'];
const REQUIRED_ASSET_BY_KIND = {
  physical_host: ['hostname', 'site_id', 'environment', 'cluster', 'failure_domain', 'roles'],
  vm: ['hostname', 'site_id', 'environment', 'cluster', 'failure_domain', 'roles'],
  container: ['parent_asset_id', 'compose_project', 'compose_service', 'container_name', 'image'],
  endpoint: [],
};

/** @returns {string[]} error messages; empty means valid. */
export function validate(inv) {
  const errors = [];
  const requireFields = (obj, fields, where) => {
    for (const field of fields) {
      if (obj?.[field] === undefined) errors.push(`${where}: missing required field "${field}"`);
    }
  };
  const checkLabelChars = (value, where) => {
    if (typeof value === 'string' && !LABEL_CHARS.test(value)) {
      errors.push(`${where}: "${value}" has characters outside [A-Za-z0-9_.:-]`);
    }
  };
  const checkDate = (value, where) => {
    if (value !== undefined && Number.isNaN(Date.parse(value))) {
      errors.push(`${where}: "last_verified_at" is not a parseable date: "${value}"`);
    }
  };
  const checkJobName = (value, where) => {
    if (value !== undefined && !JOB_PATTERN.test(value)) {
      errors.push(`${where}: "${value}" must match ^[A-Za-z0-9_.-]+$`);
    }
  };

  if (inv?.schema_version === undefined) errors.push('root: missing "schema_version"');
  if (!Array.isArray(inv?.sites)) errors.push('root: "sites" must be an array');
  if (!Array.isArray(inv?.failure_domains)) errors.push('root: "failure_domains" must be an array');
  if (!Array.isArray(inv?.assets)) errors.push('root: "assets" must be an array');
  const sites = Array.isArray(inv?.sites) ? inv.sites : [];
  const failureDomains = Array.isArray(inv?.failure_domains) ? inv.failure_domains : [];
  const assets = Array.isArray(inv?.assets) ? inv.assets : [];

  const siteIds = new Set();
  sites.forEach((site, i) => {
    requireFields(
      site,
      ['site_id', 'display_name', 'country', 'city', 'provider', 'datacenter', 'last_verified_at', 'verified_by'],
      `sites[${i}]`,
    );
    checkDate(site?.last_verified_at, `sites[${i}]`);
    if (site?.site_id) siteIds.add(site.site_id);
  });

  const fdIds = new Set();
  failureDomains.forEach((fd, i) => {
    requireFields(fd, ['failure_domain', 'site_id', 'scope'], `failure_domains[${i}]`);
    if (fd?.failure_domain) fdIds.add(fd.failure_domain);
    if (fd?.site_id && !siteIds.has(fd.site_id)) {
      errors.push(`failure_domains[${i}]: site_id "${fd.site_id}" does not exist in sites`);
    }
  });

  const byId = new Map(assets.filter((a) => a?.asset_id).map((a) => [a.asset_id, a]));
  const seenAssetIds = new Set();

  assets.forEach((asset, i) => {
    const where = `assets[${i}] (${asset?.asset_id ?? '?'})`;
    requireFields(asset, REQUIRED_ASSET_COMMON, where);

    const extra = REQUIRED_ASSET_BY_KIND[asset?.kind];
    if (asset?.kind !== undefined && extra === undefined) {
      errors.push(`${where}: unknown kind "${asset.kind}"`);
    } else if (extra) {
      requireFields(asset, extra, where);
    }

    if (asset?.asset_id) {
      if (seenAssetIds.has(asset.asset_id)) errors.push(`${where}: duplicate asset_id`);
      seenAssetIds.add(asset.asset_id);
      checkLabelChars(asset.asset_id, `${where}.asset_id`);
    }
    if (asset?.parent_asset_id && !byId.has(asset.parent_asset_id)) {
      errors.push(`${where}: parent_asset_id "${asset.parent_asset_id}" does not exist`);
    }
    if (asset?.site_id && !siteIds.has(asset.site_id)) {
      errors.push(`${where}: site_id "${asset.site_id}" does not exist`);
    }
    if (asset?.failure_domain && !fdIds.has(asset.failure_domain)) {
      errors.push(`${where}: failure_domain "${asset.failure_domain}" does not exist`);
    }
    if (asset?.environment) checkLabelChars(asset.environment, `${where}.environment`);
    if (asset?.site_id) checkLabelChars(asset.site_id, `${where}.site_id`);
    if (asset?.failure_domain) checkLabelChars(asset.failure_domain, `${where}.failure_domain`);
    checkDate(asset?.last_verified_at, where);

    if (asset?.roles !== undefined) {
      const rolesValid =
        Array.isArray(asset.roles) && asset.roles.length > 0 && asset.roles.every((r) => typeof r === 'string');
      if (!rolesValid) {
        // a plain string is iterable too, and would otherwise become one single-character role
        // per index rather than the one role it was meant to be.
        errors.push(`${where}: "roles" must be a non-empty array of strings`);
      } else {
        for (const role of asset.roles) checkLabelChars(role, `${where}.roles`);
      }
    }

    if (asset?.node) {
      checkLabelChars(asset.node, `${where}.node`);
      if (!NODE_PATTERN.test(asset.node)) {
        errors.push(`${where}: node "${asset.node}" does not match ^tyk-[0-9]+$`);
      }
    }

    (asset?.scrape_targets ?? []).forEach((st, j) => {
      const stWhere = `${where}.scrape_targets[${j}]`;
      requireFields(st, ['job', 'target'], stWhere);
      checkJobName(st?.job, `${stWhere}.job`);
    });
    (asset?.probe_targets ?? []).forEach((pt, j) => {
      const ptWhere = `${where}.probe_targets[${j}]`;
      requireFields(pt, ['module', 'target'], ptWhere);
      checkJobName(pt?.module, `${ptWhere}.module`);
      checkJobName(pt?.job, `${ptWhere}.job`);
    });
  });

  // node aliases are unique per cluster. A container has no `cluster` of its own — it inherits
  // one from its parent host, same as the label inheritance below (02 §2.2).
  const nodesByCluster = new Map();
  for (const asset of assets) {
    if (!asset?.node) continue;
    const cluster = asset.cluster ?? byId.get(asset.parent_asset_id)?.cluster ?? '(no cluster)';
    const seen = nodesByCluster.get(cluster) ?? new Set();
    if (seen.has(asset.node)) {
      errors.push(`assets: node "${asset.node}" is used twice in cluster "${cluster}"`);
    }
    seen.add(asset.node);
    nodesByCluster.set(cluster, seen);
  }

  return errors;
}

// A container asset carries no environment/site_id/failure_domain of its own — it inherits them
// from its parent host (02 §2.2, "Container assets inherit site, failure domain and environment
// from their parent host"). asset_id is never inherited: it always names the asset itself.
function targetLabels(asset, byId) {
  const parent = asset.parent_asset_id ? byId.get(asset.parent_asset_id) : undefined;
  const environment = asset.environment ?? parent?.environment;
  const site = asset.site_id ?? parent?.site_id;
  const failureDomain = asset.failure_domain ?? parent?.failure_domain;

  const labels = { asset_id: asset.asset_id };
  if (environment) labels.environment = environment;
  if (site) labels.site = site;
  if (failureDomain) labels.failure_domain = failureDomain;
  // ponytail: a file_sd label is single-valued, so `role` is the first entry of `roles` — never
  // a joined list. The label-char guard above already rejects a comma in that value.
  if (asset.roles?.[0]) labels.role = asset.roles[0];
  if (asset.node) labels.node = asset.node;
  return labels;
}

export function buildFileSd(inv) {
  const byId = new Map(inv.assets.filter((a) => a?.asset_id).map((a) => [a.asset_id, a]));
  const byJob = new Map();
  const push = (job, target, labels) => {
    const list = byJob.get(job) ?? [];
    list.push({ targets: [target], labels });
    byJob.set(job, list);
  };

  for (const asset of inv.assets) {
    const labels = targetLabels(asset, byId);
    for (const st of asset.scrape_targets ?? []) push(st.job, st.target, labels);
    // probe_targets carry an optional `job` (schema.json); when a probe wants its own
    // prometheus.yml job (api-health, ory-ready, ...) it sets one, otherwise this falls back to
    // "probe-<module>" rather than requiring every probe_target to name one.
    for (const pt of asset.probe_targets ?? []) push(pt.job ?? `probe-${pt.module}`, pt.target, labels);
  }

  for (const list of byJob.values()) {
    list.sort((a, b) => cmp(a.targets[0], b.targets[0]));
  }
  return byJob;
}

function escapeLabelValue(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function formatLabels(labels) {
  return Object.entries(labels)
    .map(([k, v]) => `${k}="${escapeLabelValue(v)}"`)
    .join(',');
}

export function buildTextfile(inv) {
  const lines = [];

  lines.push('# HELP og_asset_info Static asset identity, for dashboard joins.');
  lines.push('# TYPE og_asset_info gauge');
  const hosts = [...inv.assets].filter((a) => a.hostname).sort((a, b) => cmp(a.asset_id, b.asset_id));
  for (const host of hosts) {
    const labels = { asset_id: host.asset_id, hostname: host.hostname };
    if (host.site_id) labels.site = host.site_id;
    if (host.failure_domain) labels.failure_domain = host.failure_domain;
    if (host.roles?.[0]) labels.role = host.roles[0];
    if (host.environment) labels.environment = host.environment;
    lines.push(`og_asset_info{${formatLabels(labels)}} 1`);
  }

  lines.push('# HELP og_inventory_last_verified_timestamp_seconds Epoch of last_verified_at per asset.');
  lines.push('# TYPE og_inventory_last_verified_timestamp_seconds gauge');
  const verified = [...inv.assets].filter((a) => a.last_verified_at).sort((a, b) => cmp(a.asset_id, b.asset_id));
  for (const asset of verified) {
    const epoch = Math.floor(new Date(asset.last_verified_at).getTime() / 1000);
    lines.push(`og_inventory_last_verified_timestamp_seconds{asset_id="${escapeLabelValue(asset.asset_id)}"} ${epoch}`);
  }

  lines.push('# HELP og_expected_container Containers the inventory expects on their parent host (AL-CTR-01).');
  lines.push('# TYPE og_expected_container gauge');
  const containers = [...inv.assets]
    .filter((a) => a.kind === 'container' && a.parent_asset_id && a.container_name)
    .sort((a, b) => cmp(a.asset_id, b.asset_id));
  for (const ctr of containers) {
    const labels = { asset_id: ctr.parent_asset_id, name: ctr.container_name };
    lines.push(`og_expected_container{${formatLabels(labels)}} 1`);
  }

  return lines.join('\n') + '\n';
}

function main() {
  const { in: inPath, outDir } = parseArgs(process.argv.slice(2));
  const inv = loadInventory(readFileSync(inPath, 'utf8'));

  const errors = validate(inv);
  if (errors.length > 0) {
    for (const error of errors) console.error(`error: ${error}`);
    process.exitCode = 1;
    return;
  }

  const fileSdDir = join(outDir, 'file_sd');
  mkdirSync(fileSdDir, { recursive: true });
  const byJob = buildFileSd(inv);
  for (const job of [...byJob.keys()].sort()) {
    writeFileSync(join(fileSdDir, `${job}.json`), JSON.stringify(byJob.get(job), null, 2) + '\n');
  }

  writeFileSync(join(outDir, 'og_inventory.prom'), buildTextfile(inv));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
