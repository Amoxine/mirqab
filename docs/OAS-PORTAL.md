# The developer portal serves a sanitized OpenAPI document (OAS-06)

`GET /api/portal/catalog/apis/:id` is what the portal's docs page and try-it console read. Its
`oasDocument` used to be the **generated Tyk document** stored on the API row. It is now built by
`PortalApiDocService` and is always a **sanitized copy**:

| The API has | `oasDocument` is |
|---|---|
| a stored specification (`api_specs`, OAS-01) | the newest stored version, sanitized |
| no stored specification, OAS format | the generated document, sanitized |
| no stored specification, classic format | `null` |
| a stored specification that cannot be served (unparseable, or past the work limits) | `null` — **never** the generated document, which documents governed endpoints as synthetic operations, blocked ones included; a warning is logged with the API id |

Authentication is unchanged: a developer session (`DeveloperAuthGuard`) and the tenant read off it.

## Who may read a document

Only an API that is **published**: it exists in the developer's tenant (`ApiService.findOne`), its
status is `ACTIVE`, and it belongs to at least one **product** of that tenant. Products are the catalog's
unit of publication: `GET /portal/catalog/products` lists every product of the tenant (there is no
visibility flag; see the GAP note in the controller), so an API that is in no product is not published.
Everything else answers **the same 404 as a missing id**, with the same body, so the response tells a
developer nothing about drafts, disabled APIs or APIs nobody put in a product:

| API | Answer |
|---|---|
| another tenant's, or unknown | 404 |
| `DRAFT`, `DISABLED` | 404 (the check runs before any spec is read) |
| `RETIRED` | 404 (the dashboard's `GET /apis/:id` answers 410 with a `Sunset` header; the portal does not) |
| `ACTIVE`, in no product of the tenant | 404 |
| `ACTIVE`, in a product of the tenant | 200 |

`tenantId` is in the product-membership query and in every `api_specs` query.

## What was wrong (measured, not assumed)

Before this change the response carried `x-tyk-api-gateway`, which holds the **internal upstream**.
Evidence kind: **mocked persistence, real controller and real `mapToTykOas`** (no live probe: none was
made against the running stack). `portal-catalog.controller.spec.ts` failed against the old code with,
for an API whose `proxyUrl` is `http://internal-orders.corp:8443/v1`:

```
"x-tyk-api-gateway":{"info":{"id":"og-a1","name":"Orders","orgId":"og-t1", …},
  "upstream":{"url":"http://internal-orders.corp:8443/v1",
              "loadBalancing":{…"targets":[{"url":"http://internal-lb-2.corp:9000",…}]},
              "uptimeTests":{…"tests":[{"url":"http://internal-probe.corp/health",…}]}},
  "server":{"listenPath":{"value":"/acme/orders/",…}, "authentication":{…}}}
```

So a developer with a portal session could read the upstream URL, its load-balancer targets, the
uptime-probe URLs and the tenant's Tyk org id. Beyond that leak, a stored specification's own
`servers` would point developers at the upstream directly, past the gateway's authentication.

## What the sanitizer does (`portal/services/portal-spec-sanitizer.ts`)

A pure function that builds a **fresh copy** (the input is never mutated) and drops:

| Removed | Why |
|---|---|
| every `servers` key whose value is a list (any elements, valid or not) or an object, and every `server` object, at any depth (document, path item, operation, callback, link); the document's own `servers` is replaced by ONE entry `{ url: "/{tenantSlug}{listenPath}" }` | the original servers are the upstream, and a Server Object cannot be told by its contents (a hostile author omits `url`) |
| every `x-tyk-*` key (case-insensitive) at any depth, schemas and examples included | `x-tyk-api-gateway.upstream.url` is the internal `proxyUrl` |
| every `$ref` that is not a local `#…` fragment | a renderer that resolves references must never be pointed at a URL or a file; the sanitizer itself never fetches anything |
| `$id` / `$schema` whose value is an absolute URI (`https:`, `file:`, `//host/…`), a non-fragment `$dynamicRef` / `$recursiveRef`, the root `jsonSchemaDialect` (OpenAPI 3.1 / JSON Schema 2020-12) | they move the base URI a local `#/$defs/x` reference resolves against, turning it into a remote one |
| `__proto__`, `constructor`, `prototype` keys at any depth | the usual prototype-pollution gadget for whatever merges this JSON later |
| operations whose endpoint governance says `config.endpoints[key].enabled === false` | the docs must not advertise a route that answers 403 |
| values JSON cannot carry (`undefined`, functions, `Date`, `Map`, …) | array slots become `null`, as `JSON.stringify` does |

The one exception to the `servers`/`server` rule is a schema property that is merely **named** `servers`
or `server`: the keys of a schema's `properties` map are names, and their values are schemas. The walk
tracks that position (a property called `properties` does not open a second exemption), and a list under
a property name is still dropped.

Everything else is passed through **byte-for-byte**, key order included. Descriptions, summaries and
examples stay the same strings: rendering them as plain text is the web's job (below), not something
to approximate by escaping on the server. A test compares `JSON.stringify` of a legitimate document
with the expected output.

**Bounded work.** The walk is iterative (no call-stack overflow) and stops at 2,000,000 values or 128
levels of nesting; past either it answers `null` instead of a guess. A non-object document (`null`,
string, array, `Map`, …) also answers `null`.

**Blocked endpoints** use the endpoint keys of `oas-endpoints.ts` (`buildEndpointIndex`): the
`operationId` when it is unique, else `METHOD /path` — the keys governance was written against. A
path item left with no operation is removed. A path item that is itself a local `$ref` (OAS 3.1
`components/pathItems`) cannot be edited in place, so when any of its operations is blocked the
**whole item is hidden**, siblings included, and its target under `#/components/…` is deleted too
(otherwise the blocked operation would stay published under `components.pathItems`) unless another
`$ref` still points at it; a chain of path-item refs (up to the three hops the index follows) is
followed. A ref into `paths` is never deleted. Hiding the whole item is the conservative choice; inline
the item if it matters.

## The server URL

`servers[0].url` is `/{tenantSlug}{listenPath}` **without the trailing slash**, relative to the
gateway origin, for example `/acme/orders`. Two decisions the contract did not spell out:

- **Relative, not absolute.** The API process does not know the gateway's public origin: the only
  gateway URL in its environment is the internal `TYK_GATEWAY_URL`, which must never be published.
  The public origin lives in the web app (`NEXT_PUBLIC_GATEWAY_URL`), which resolves the path.
- **No trailing slash.** OpenAPI joins `server.url + path`, and paths start with `/`, so `/acme/orders/`
  would produce `/acme/orders//orders`. `gatewayListenPath` (the separate field of the response) is
  unchanged, trailing slash included.

## Parsing cost and the cache

The stored source is text. Measured on this machine: the YAML parser took **2.6 s** for a 1.6 MB
document of 4,000 operations, `JSON.parse` 49 ms for the same content as JSON. One Node process serves
every route, so the docs page must not pay that per view. `PortalApiDocService` therefore keeps
sanitized results in memory:

- **Key:** `JSON.stringify([apiId, contentHash, serverUrl, sortedBlockedKeys])`, so a spec change or a
  governance change misses. A joined string would let one blocked key containing a separator collide with
  two real keys.
- **Weight:** the length of the sanitized document's serialization, with an 8 MB budget (oldest
  evicted). The source text is a poor proxy: whitespace and comments inflate it, and a large source can
  sanitize to something small. The cached object is served and Nest serializes it per response; JSON
  cannot embed a pre-serialized string.
- **Coalescing:** concurrent misses on the same key share ONE in-flight read + parse (`Map` of promises,
  removed in `finally`, so a failed build is not remembered). Without it, N simultaneous first views would
  run N parses back to back on the one event loop.
- The version summary is read every time; the source text only on a miss.

Limits: per process (a second API replica warms its own), the first view of a large YAML pays the parse
once, and a document whose sanitized form exceeds the whole budget is rebuilt on every view (concurrent
views still share one build). The YAML parser also **throws** on some input (`!!binary`); that is caught
and answers `null`. The YAML alias guard (`yamlAliasHazard`) runs before the parser, so a document it
flags is refused rather than parsed.

## Web

- `api-docs-section.tsx` lists only real HTTP-method keys of a path item (`get`, `put`, `post`,
  `delete`, `options`, `head`, `patch`, `trace`). Before, every key of a path item became a row, so a
  real specification showed rows named `PARAMETERS`, `SUMMARY`, `SERVERS`… ; and a `null` path item
  made `Object.keys` throw. Anything that is not an object is now skipped.
- **Plain text, verified.** Summaries and descriptions are not rendered at all today; the tenant-controlled
  strings that are rendered (the API name, the path, the try-it response body) go through React text
  nodes. Component tests put `<script>`, `<img onerror>` and `javascript:` payloads in every field and
  assert no element, handler or `javascript:` link appears. Five of these tests were shown failing
  when the components were mutated (`dangerouslySetInnerHTML`, or trusting `servers[0].url` as is).
- `try-it-console.tsx` builds its target from the document's `servers[0].url`, resolved against
  `GATEWAY_URL`, joined with exactly one slash. **The developer's key is sent there**, so only a
  plain path starting with a single `/` is accepted from the document; an absolute URL, a
  scheme-relative one, `javascript:` or a non-string falls back to the API's `gatewayListenPath`.
  As a side effect a listen path without a trailing slash (`/payments`, which the DTO allows) no
  longer produces `/acme/paymentsusers`.
- No new user-facing string, so no locale change (`check-locale-keys.mjs` exit 0).

## Evidence and what it does not prove

| Claim | Evidence kind |
|---|---|
| The old response leaked the upstream, load-balancer and probe URLs | mocked persistence, real controller + mapper; failed before, passes after |
| Sanitizer rules, hostile fixtures, bounds | unit (`portal-spec-sanitizer.spec.ts`, 61 tests); shown failing against a naive `JSON.parse(JSON.stringify())` + `delete x-tyk-api-gateway` first (23 of 46); the later `servers`/`$id`/path-item-`$ref` rules were added test-first (11 failed before the fix) |
| Service: stored JSON and YAML, fallback rules, publication rule, coalescing, cache weight and key, tenant scope in every query | unit, mocked Prisma (`portal-api-doc.service.spec.ts`); mutations (generated fallback, no cache hit, no tenant filter; no status check, no product check, no 410 mapping, no coalescing, source-length weight, joined-string key) each failed tests |
| Controller: 404 across tenants, developer's own tenant id used | unit, mocked persistence |
| Web: plain text, base URL, path-item rows | vitest + jsdom; two mutations (`dangerouslySetInnerHTML`, trusting `servers[0].url`) failed five tests |
| Live: publication (DRAFT / DISABLED / in no product -> 404), HTTP through the guards, real Postgres, the advertised URL reaches the upstream, a `$ref` to a loopback listener makes zero connections | `apps/api/test/e2e/oas-portal.e2e.mjs` — **written, not run** until a build containing this change is deployed |

Not proven: browser rendering of a real specification, the TLS edge path (the e2e calls the gateway data
plane directly), cache behaviour with more than one API replica, and anything about a specification
larger than the 8 MB cache budget under load.

## Known limits

- **Only `x-tyk-*` extensions are stripped.** A tenant's OTHER vendor extensions (for example
  `x-amazon-apigateway-*` or `x-google-backend`) are tenant-authored content and pass through
  unchanged. A tenant who puts a backend URL in one of them publishes it to every developer of that
  tenant. The sanitizer cannot tell such a URL from documentation, and this change does not try to.
- **The sanitized `servers` entry is relative.** `servers[0].url` is a path such as `/acme/orders`, not
  an absolute URL: the API does not know the gateway's public origin. A consumer that reads the document
  outside the portal web app (a generated client, an external renderer) must resolve that path against
  the gateway origin itself, or it will resolve it against wherever the document was served from.
- URLs that are tenant-authored documentation are passed through as text: `externalDocs.url`,
  `info.contact.url`, `info.termsOfService`, OAuth `tokenUrl`/`authorizationUrl` in `securitySchemes`,
  and hosts mentioned inside descriptions. Only server URLs and `x-tyk-*` are treated as internals.
  The web renders none of them as links today; a future renderer must not turn them into `href`s
  without a scheme allow-list.
- A relative `$id` (`Order.json`, `/x`) is kept: it can only move the base URI within the origin the
  document was served from. Only absolute URIs are dropped. Nothing in this repo resolves `$id` anyway.
- Any object or list called `servers`, and any object called `server`, is dropped wherever it is, except
  as a schema property name. That includes a schema or a response **named** `servers` under
  `components`, and a `servers` object or list inside an `example` value. The `#/components/schemas/servers`
  reference would then dangle; rename the component.
- A schema property genuinely named `constructor`, `prototype` or `__proto__` is dropped from the
  portal copy.
- The generated-document fallback shows the synthetic catch-all operations the mapper emits for
  API-wide middleware, as before.
