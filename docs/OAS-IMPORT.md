# OAS import and the Spectral lint gate

`POST /apis/import` turns an OpenAPI 3.x document into an API definition. The body is the raw
document — JSON or YAML, up to 5 MB — and it is linted before anything is created.

```bash
curl -sS --cacert infra/edge/root.crt \
  -X POST https://localhost:33001/api/apis/import \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/yaml' \
  --data-binary @openapi.yaml
```

Permission: **`api:create`**. Importing produces an `ApiDefinition`, so it is the same capability as
creating one by hand reached a different way — there is deliberately no separate `api:import`, which
would be a permission an admin could grant without meaning to allow API creation.

## What decides the outcome

Severity, and nothing else. The 0–100 quality score and per-tenant rulesets that earlier drafts
described were cut; this is pass/fail.

| Outcome | When | Result |
|---|---|---|
| **201** | no `error`-severity finding | API created; every finding (the warnings) returned in `data.findings` |
| **422** | ≥ 1 `error`-severity finding | nothing created; findings returned in `error.details`, keyed by rule id |
| **413** | body larger than 5 MB | nothing created |

A warning never blocks an import. That is the point: rejecting a real-world specification because
an operation lacks a description would make the feature unusable, while a document that cannot
yield a working route has to be refused.

## The ruleset

One repo-level ruleset, `apps/api/src/modules/api-import/oas-ruleset.ts`. It extends Stoplight's
built-in `oas` ruleset, which already splits along the line this feature needs:

- **Errors — structural validity.** `oas3-schema` (the OAS 3.x meta-schema: a missing
  `info.version`, a `paths` that is not an object), `no-$ref-siblings`, and the rest of the
  built-in error set.
- **Warnings — documentation quality.** `info-contact`, `info-description`,
  `operation-description`, `operation-operationId`, `operation-tags`, and similar.

On top of that it adds exactly three overrides, all errors, all for the same reason — without them
the import cannot produce a working row:

| Rule | Why it is an error |
|---|---|
| `oas3-api-servers` (built-in, raised from warning) | `servers[0].url` becomes the API's `proxyUrl`. No servers, no upstream. |
| `og-server-url-absolute` | OAS allows a relative server URL (`/v1`). It is meaningful to a client that already knows the host and useless as a gateway upstream. |
| `og-info-title-sluggable` | `info.title` becomes the API name and, slugified, its slug and listen path. A title with no letter or digit slugifies to the empty string. |

Adding a rule means editing that one file. Keep new rules at `warning` unless a document that
breaks them genuinely cannot be imported — the error list is a list of things that make import
impossible, not a style guide.

## What is derived from the document

| Field | Source |
|---|---|
| `name` | `info.title`, truncated to 100 characters |
| `slug` | `info.title` slugified (accents decomposed, non-alphanumerics collapsed to `-`) |
| `listenPath` | `/{slug}/` |
| `proxyUrl` | `servers[0].url` |
| `authType` | left unset, so the schema default (`NONE`) applies |

`authType` is deliberately not inferred. A specification's `securitySchemes` describe what the
**upstream** expects, not what the gateway should enforce; turning one into gateway authentication
would publish a route protected in a way nobody asked for.

The derived fields are validated by `CreateApiDto` — the same DTO the hand-written create route
uses — so name length, slug shape, listen-path shape, URL validity and the SSRF denylist
(`IsAllowedProxyUrl`) are enforced once, in one place. An imported API can never reach an upstream
a hand-created one may not. Import then calls `ApiService.create()`, so slug and listen-path
uniqueness, conflict mapping and the background gateway sync are all the existing code path.

## Known limits

- **Two specs with the same `info.title` collide.** The second import returns 409 from the existing
  uniqueness check. There is no slug override parameter yet; rename the title or create the API by
  hand. Worth adding when someone actually hits it.
- **The submitted document is not stored.** `ApiDefinition.oasDocument` holds the Tyk-OAS document
  the sync path generates and last pushed, and it is overwritten on every sync — it is not a place
  to keep the user's source specification. Keeping the original would need its own column.
- **Swagger 2.0 is refused** with `OAS_IMPORT_UNSUPPORTED_VERSION`. Spectral's `oas` ruleset lints
  2.0 happily under its oas2 rules, so a 2.0 document can lint clean; the version check is separate
  from the lint gate for that reason.
