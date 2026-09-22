import { oas } from '@stoplight/spectral-rulesets';
import { pattern } from '@stoplight/spectral-functions';
import type { RulesetDefinition } from '@stoplight/spectral-core';

/**
 * The ONE repo-level Spectral ruleset (WP24).
 *
 * Deliberately one ruleset for the whole repo, not one per tenant, and pass/fail only — the 0-100
 * score and per-tenant rulesets were cut from the plan (§9). Severity is the only thing that
 * decides an import's fate: **any `error` rejects the spec with 422, everything else is returned
 * as advice and the API is still created.**
 *
 * It extends Stoplight's built-in `oas` ruleset rather than hand-rolling rules, which already
 * splits along the line this WP needs:
 *   - structural validity is `error` — `oas3-schema` (the OAS 3.x meta-schema: a missing
 *     `info.version`, a `paths` that is not an object), `no-$ref-siblings`, and similar;
 *   - style and documentation quality are `warning` — `info-contact`, `info-description`,
 *     `operation-description`, `operation-operationId`, `operation-tags`.
 *
 * On top of that it adds exactly three overrides, all of them errors, and all three for the same
 * reason: an import has to produce a working `ApiDefinition` row, so a spec missing one of these
 * cannot be imported at all. Anything that is merely poor practice stays a warning on purpose —
 * rejecting real-world specs for missing a description would make the feature useless.
 */
export const openGatewayOasRuleset = {
  extends: [oas],
  rules: {
    /**
     * Built-in, but a WARNING upstream. Raised to error: `servers[0].url` becomes the API's
     * `proxyUrl`, so a spec with no servers has no upstream and there is nothing to route to.
     */
    'oas3-api-servers': 'error',

    /**
     * OAS permits a relative server URL (`/v1`), which is meaningful to a client that already
     * knows the host and meaningless as a gateway upstream — it has no host to connect to.
     */
    'og-server-url-absolute': {
      description: 'servers[0].url must be an absolute http(s) URL: it becomes the API upstream.',
      message: '{{error}} — the first server URL becomes the upstream, so it needs a scheme and host.',
      given: '$.servers[0].url',
      severity: 'error',
      then: { function: pattern, functionOptions: { match: '^https?://' } },
    },

    /**
     * `info.title` becomes the API name and, slugified, its slug and listen path. A title with no
     * alphanumeric character slugifies to the empty string, which is not a usable slug.
     */
    'og-info-title-sluggable': {
      description: 'info.title must contain at least one letter or digit: it becomes the API name and slug.',
      message: '{{error}} — the title becomes the API name and its URL slug.',
      given: '$.info.title',
      severity: 'error',
      then: { function: pattern, functionOptions: { match: '[A-Za-z0-9]' } },
    },
  },
  // The cast is the documented shape for a ruleset built in TypeScript: `extends` accepts a
  // ruleset object, but the declaration types it as the narrower literal union.
} as unknown as RulesetDefinition;
