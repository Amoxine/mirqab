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
| **422** `OAS_IMPORT_UNSAFE_YAML` | more than 5 YAML aliases, or any alias in a YAML document over 64 KB | rejected **before parsing**; nothing created |
| **422** `OAS_IMPORT_UNPARSEABLE` | the document is not JSON or YAML, or uses a YAML tag the parser cannot turn into JSON (`!!binary`) | nothing created; the parser's own error text is never echoed |
| **415** `OAS_IMPORT_WRONG_CONTENT_TYPE` | sent as `Content-Type: application/json` | nothing created — send `text/plain` or `application/yaml` |

A warning never blocks an import. That is the point: rejecting a real-world specification because
an operation lacks a description would make the feature unusable, while a document that cannot
yield a working route has to be refused.

## The document is data: what it may not do

Two properties of the linting stack would otherwise let an uploaded document act on the API
process, so both are refused **before** the linter runs (`services/oas-safety.ts`, called from
`SpectralLintService.lint`):

- **No external `$ref`.** Spectral resolves `$ref` while it lints, and `new Spectral()` defaults to a
  resolver that follows `http(s)://` and `file:` references. A document containing one would make the
  API process fetch that URL or read that file (a blind SSRF / local-file read reachable with
  `api:create`; reproduced against a loopback listener in `oas-import-safety.spec.ts` before the
  fix). Only local references (`#/…`) are accepted. Any other `$ref` string, anywhere in the document
  (paths, `x-` extensions, examples), returns **422** with the rule id `og-no-external-ref` and the
  line, and `Spectral.run` is never called. Inline the referenced document instead. The
  `IsAllowedProxyUrl` denylist does not apply to `$ref`s, so this is a separate control.
- **No alias bombs.** YAML aliases expand while parsing: a 272-byte document with seven nested alias
  levels took about 3.8 s to parse and the eighth level did not finish in 25 s, which blocks the
  API's event loop. A YAML document may use at most **5** aliases, and only if it is at most
  **64 KB**; anything else returns **422** `OAS_IMPORT_UNSAFE_YAML` without being parsed. A document
  that parses as JSON has no aliases and is exempt, so **upload JSON if a large specification
  legitimately relies on YAML anchors**. Anchor and alias names are any run of non-space characters
  other than `,[]{}` (so `&é0`, `&😈`, `&a.b` all count — the first version only recognised
  `[A-Za-z0-9_-]` and a 184-byte document with non-ASCII anchors got through). Aliases are recognised
  by position, at the start of a node: the start of a line, or after `:`, `-`, `?`, `,`, `[` or `{`
  (spaces or tabs allowed in between), so `*emphasis*` inside a description is not counted. A
  document without any anchor (`&name` after a line start, whitespace or an indicator; `&amp;` in
  prose over-counts, harmlessly) is never refused, because an alias without an anchor cannot expand.
  The same guard runs before every YAML parse in the API: `SpectralLintService.lint` (import,
  import preview, spec re-upload and its preview) and the portal's document service.
- **No exotic tags that break the parser.** A `!!binary` scalar made the YAML parser throw a raw
  `TypeError` (a 500); any parser exception is now **422** `OAS_IMPORT_UNPARSEABLE`. `!!timestamp`,
  `!!set`, `!!omap`, unknown local tags (`!foo`) and merge keys (`<<`) parse and lint normally.

Neither control resolves anything over the network, and neither adds a dependency.
`@stoplight/spectral-ref-resolver` is not a direct dependency of this package, so passing Spectral a
restricted resolver would have meant adding one.

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
| `proxyUrl` | `servers[serverIndex].url` (default the first), with `{variables}` replaced by their declared defaults; a variable with no default makes that server unusable |
| `authType` | left unset, so the schema default (`NONE`) applies |

Two query parameters override what the document cannot decide on its own, on both routes below:
`slug` (replaces the slug derived from `info.title`, and with it the listen path — this is the way
out of the "two specs with the same title" collision) and `serverIndex` (0–49, which `servers[]`
entry becomes the upstream). Both are validated again by `CreateApiDto`, so an override cannot
smuggle in a bad slug or a denied upstream.

`authType` is deliberately not inferred. A specification's `securitySchemes` describe what the
**upstream** expects, not what the gateway should enforce; turning one into gateway authentication
would publish a route protected in a way nobody asked for.

The derived fields are validated by `CreateApiDto` — the same DTO the hand-written create route
uses — so name length, slug shape, listen-path shape, URL validity and the SSRF denylist
(`IsAllowedProxyUrl`) are enforced once, in one place. An imported API can never reach an upstream
a hand-created one may not. Import then calls `ApiService.create()`, so slug and listen-path
uniqueness, conflict mapping and the background gateway sync are all the existing code path.

## Preview, and what is kept

**`POST /apis/import/preview`** takes the same body, the same query parameters and the same permission
(`api:create`) but **writes nothing** and is not audited. It answers with what an import would create:
the derived API (`name`, `slug`, `listenPath`, `proxyUrl`), every server with the one selected and
the reason a server is refused (`denyReason`), any slug or listen-path **conflict**, the lint
findings with line numbers, the endpoint list, the content hash and `valid` / `canImport`. Lint
errors and an unusable derived API are **reported** (`valid: false`, `problems`) rather than thrown,
so a UI can show what to fix; a document that cannot be processed at all (over 5 MB, not JSON or
YAML, not OpenAPI 3.x, more than 5 aliases, more than 5000 operations) fails exactly like the real
import.

**The document is kept.** A successful import stores it in `api_specs` **in the same transaction as
the API row** — verbatim (comments and formatting included), with its SHA-256 (`contentHash`), the
`openapiVersion`, a `format` of `json` or `yaml`, a version number (1 for an import), and an
**endpoint index** computed once at import. This is not `ApiDefinition.oasDocument`, which is the
Tyk-OAS document the sync path generates and overwrites on every sync.

| Route | Permission | Answers |
|---|---|---|
| `GET /apis/:id/spec` | `api:read` | the newest stored version with its source text |
| `GET /apis/:id/endpoints` | `api:read` | the endpoint index of the newest version, without the source text |
| `POST /apis/:id/spec/preview` | `api:update` | the diff a changed document would make; writes nothing (below) |
| `POST /apis/:id/spec` | `api:update` | apply a changed document as the next version (below) |

The two `GET`s are tenant-scoped: another tenant's API looks exactly like an API with no stored spec
(404). An API created by hand has no spec (404) until one is attached with `expectedVersion=0`.

An **endpoint** is one path + method. Its `key` is the `operationId` when that is present and unique
in the document, otherwise `METHOD path` (for example `GET /orders/{id}`), so it stays stable across
re-imports of the same document. Each row also carries `summary`, `tags`, `deprecated` and the names
of the security schemes the operation requires (operation-level, else document-level). A path item
that is a **local** `$ref` (`#/components/pathItems/…`) is followed; nothing else is. The index is
capped at **5000** operations: a larger document is refused with 422
`OAS_IMPORT_TOO_MANY_ENDPOINTS`, not truncated.

## Re-uploading a changed document (OAS-04)

Two routes, both `api:update`, both taking the raw document like the import:

- **`POST /apis/:id/spec/preview?expectedVersion=<n>`** — computes the diff and the governance impact
  and **writes nothing**; not audited (like `POST /apis/import/preview`). Lint errors are reported in
  `findings`, not thrown. Answers with `dryRun: true, applied: false`.
- **`POST /apis/:id/spec?expectedVersion=<n>[&acknowledgeRemoved=true]`** — the apply, audited as
  `api:updated`. It has no dry-run flag (an unknown query field is 400).

The body and its gates are exactly the import's (same route-scoped text parser, 5 MB, YAML alias
budget, no external `$ref`, the Spectral ruleset, OpenAPI 3.x only, at most 5000 operations, 415 for
`application/json`): the service runs the import preview, which writes nothing, and ignores the
derived name, slug and upstream — a re-upload changes none of them.

| Query | Meaning |
|---|---|
| `expectedVersion` (required) | The latest `versionNo` the caller has seen, or **0** when the API has no stored spec yet. Anything else: **409** `SPEC_VERSION_STALE` (preview included) — `0` on an API that has a spec, or `> 0` on one that has none, is stale too. |
| `acknowledgeRemoved=true` (apply only) | Needed to apply a document that no longer declares an endpoint that has governance. |

The answer is `{ dryRun, applied, unchanged, versionNo, findings, diff: { added, removed, changed }, governanceImpact: { removedGoverned, changedGoverned } }`.

- **A first spec for a hand-created API**: `expectedVersion=0` creates version 1. Every endpoint is
  `added` and there is no governance impact; the API can then be governed like an imported one.

- **Identity is the endpoint key.** A renamed `operationId` changes the key, so it shows as one
  removal plus one addition, never as a change — the old key's settings are never carried over to a
  different operation. `changed` lists the fields that differ: `method`, `path`, `summary`, `tags`,
  `deprecated`, `securitySchemes`, `fingerprint`.
- **`fingerprint`** is new on each index row: the SHA-256 of the operation object as written together
  with its path item's `parameters` (they apply to every operation of the path), with keys sorted at
  every depth (so a JSON and a YAML copy match). It catches a changed parameter, request body,
  response or security block that the other fields do not show. Rows stored before it existed have
  none; they are compared on the other fields only.
- **Same bytes as the latest version** (same content hash): `unchanged: true`, nothing written, no
  new version — even when `expectedVersion` is stale, so retrying an upload whose response was lost
  is safe.
- **Applying** (the apply route, no lint error) writes version `latest + 1` in one short transaction:
  it re-checks the latest version (compare-and-set), inserts the row, and sets the API's `syncStatus`
  to `PENDING` only if its `config` is still the one the governance impact was computed from.
  Two uploads that race on the same version: one wins, the other gets **409** `SPEC_VERSION_STALE`
  (the unique `(api_def_id, version_no)` index is the backstop, answered 409, never 500). A change to
  the API's `config` in the middle (a governance `PATCH`, for example) answers **409**
  `SPEC_GOVERNANCE_CHANGED` and the new version is rolled back: review the diff again.
  After the commit the normal gateway sync runs and reads the new index.
- **Governance is never rewritten.** `config.endpoints` is not touched: surviving keys keep their
  settings; a removed key's settings become an **orphan** (listed by `GET /apis/:id/endpoints`, not sent
  to the gateway, cleared only by `PATCH /apis/:id/endpoints` with `dropOrphans`). Because the gateway
  stops enforcing a removed endpoint's settings at the next sync (a blocked path starts proxying
  again), applying with `removedGoverned` non-empty needs `acknowledgeRemoved=true`, else **409**
  `SPEC_REMOVES_GOVERNED_ENDPOINTS` with the keys in `details.removedGoverned`.
- Another tenant's API is **404**, on both routes.

Proof: `spec-diff.spec.ts`, `spec-update.service.spec.ts` (mocked database, real lint and gates),
`api-spec-update.controller.spec.ts` (HTTP: body scoping, query parsing, 415), `spec-update.db-spec.ts`
(throwaway Postgres: concurrent applies, the unique-index backstop, rollback, tenant isolation, a
first spec with `expectedVersion=0`; run
command in the file) and `test/e2e/oas-spec-update.e2e.mjs` (live stack and gateway).

## Known limits

- **Send `text/plain` or `application/yaml`, never `application/json`**, on `POST /apis/import`,
  `/apis/import/preview`, `/apis/:id/spec` and `/apis/:id/spec/preview`. Nest's app-wide JSON parser
  runs before the route-scoped text parser, so a JSON content type would reach the route as an object
  (capped at 100 kB): it is refused with **415** `OAS_IMPORT_WRONG_CONTENT_TYPE`. The format is
  detected from the content, so a JSON *document* sent as `text/plain` is fine.
- **The fingerprint does not follow `$ref`s**: a change inside a shared `components` entry the
  operation references does not mark the endpoint as changed.
- **A re-upload never changes the API's upstream, name or slug.**
- **Two specs with the same `info.title` collide** unless you pass `slug`: the second import
  returns 409 from the existing uniqueness check. `POST /apis/import/preview` reports the conflict
  before you try.
- **Per-endpoint governance** (block, public, rate limit, cache, timeout, size limit, mock, request
  validation, allow-list mode) is documented in `OAS-ENDPOINT-GOVERNANCE.md`; an endpoint without
  governance is still proxied as part of the whole upstream under the API's listen path.
- **Only `servers[0]` is checked by the lint rule** `og-server-url-absolute`, so choosing a later
  server with `serverIndex` relies on `CreateApiDto`'s URL and denylist validation for that server.
- **Swagger 2.0 is refused** with `OAS_IMPORT_UNSUPPORTED_VERSION`. Spectral's `oas` ruleset lints
  2.0 happily under its oas2 rules, so a 2.0 document can lint clean; the version check is separate
  from the lint gate for that reason.
