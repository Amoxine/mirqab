#!/usr/bin/env node
// WP12b guard (DoD-OWNER 2, i18n): fails CI if messages/{en,fr,ar}/*.json don't carry the exact
// same set of keys. A locale missing a key falls back silently in next-intl — this is what makes
// that a merge-time failure instead of a runtime one someone notices in French or Arabic only.
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const messagesDir = join(here, '../../apps/web/src/messages');
const locales = ['en', 'fr', 'ar'];

function keyPaths(obj, prefix = '') {
  return Object.entries(obj).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? keyPaths(value, path)
      : [path];
  });
}

const files = readdirSync(join(messagesDir, 'en')).filter((f) => f.endsWith('.json'));
let failed = false;

for (const file of files) {
  const keysByLocale = {};
  for (const locale of locales) {
    const path = join(messagesDir, locale, file);
    try {
      keysByLocale[locale] = new Set(keyPaths(JSON.parse(readFileSync(path, 'utf8'))));
    } catch (err) {
      console.error(`::error file=apps/web/src/messages/${locale}/${file}::missing or invalid JSON (${err.message})`);
      failed = true;
      keysByLocale[locale] = new Set();
    }
  }

  const [base, ...rest] = locales;
  for (const locale of rest) {
    const missing = [...keysByLocale[base]].filter((k) => !keysByLocale[locale].has(k));
    const extra = [...keysByLocale[locale]].filter((k) => !keysByLocale[base].has(k));
    for (const key of missing) {
      console.error(`::error file=apps/web/src/messages/${locale}/${file}::missing key "${key}" (present in ${base})`);
      failed = true;
    }
    for (const key of extra) {
      console.error(`::error file=apps/web/src/messages/${locale}/${file}::extra key "${key}" (not in ${base})`);
      failed = true;
    }
  }
}

process.exit(failed ? 1 : 0);
