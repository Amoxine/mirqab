# Open Gateway edge — Caddy + OWASP Coraza WAF (WP26b, pinned by WP29b).
#
# The only self-compiled artifact in the stack: coraza-caddy is a Go module, so the WAF has to be
# linked into the Caddy binary (`xcaddy build`), not loaded at runtime. Everything else in compose
# is an upstream image pulled by tag; this one is built here, which makes it the only place a
# supply-chain change can enter without anyone pulling anything.
#
# FOUR pins, and all four are load-bearing:
#
#   1. the base images, BY DIGEST. A tag is mutable — `caddy:2.11.4-alpine` can be repushed, and the
#      "pinned" 2.11.4 build would then silently change underneath us. The digests below were
#      the INDEX (multi-arch) digests, resolved on 2026-09-24; the tag is kept alongside each one
#      for readability and is NOT what Docker resolves. They were briefly the linux/amd64 PLATFORM
#      digests instead — `docker manifest inspect -v` returns a platform entry, and pinning one
#      quietly makes the image unbuildable on any other architecture (found by worker-3). Use the
#      command at the bottom of this comment, which returns the index.
#   2. the Caddy version xcaddy compiles (`v2.11.4`), matching the base images above. A mismatch
#      here produces a binary that runs on a different runtime image than it was built for.
#   3. coraza-caddy, held at v2.6.1 or later on purpose: earlier releases drop Flush() on the
#      wrapped response writer, which stalls SSE and long-poll, and WebSocket hijack goes through
#      the same Unwrap chain (WP27 depends on both). Do not relax this to a floating tag.
#   4. the OWASP CRS ruleset. This one was previously NOT pinned here at all — it arrived
#      transitively through coraza-caddy's own go.mod, so the WAF's actual rule content was decided
#      by a module this file never named. `caddy build-info` on the image built before this change
#      reports coraza-coreruleset/v4 v4.25.0, and that is what is now stated explicitly. Naming it
#      does not change today's bytes; it makes a future change to them visible in a diff.
#
# CRS needs no download and no volume — `load_owasp_crs` in the Caddyfile resolves the @-prefixed
# includes from rules compiled into this binary, which is exactly why the version has to be pinned
# in the build rather than mounted at runtime where it could be inspected.
#
# Reproduced in CI (.github/workflows/ci.yml, `edge-image` job) rather than pulled from a
# developer's laptop, and published by CD, which is where the digest compose references comes from.
# To re-resolve the base digests after a deliberate Caddy bump (index digest, all architectures):
#   docker buildx imagetools inspect caddy:<version>-builder-alpine --format '{{.Manifest.Digest}}'

FROM caddy:2.11.4-builder-alpine@sha256:2b9f32cbba6045e79212bb253f595588d20be8f7d1edf61582c519e124e0d2d8 AS builder

RUN xcaddy build v2.11.4 \
      --with github.com/corazawaf/coraza-caddy/v2@v2.6.1 \
      --with github.com/corazawaf/coraza-coreruleset/v4@v4.25.0

FROM caddy:2.11.4-alpine@sha256:6aeddd44c3078b0f9a35206472a11420648a79c184603ef95957d0a20044cb2b

COPY --from=builder /usr/bin/caddy /usr/bin/caddy

# Fail the BUILD, not a request six weeks later, if any of the four pins above stopped producing the
# binary they name. `caddy build-info` lists every linked module with its resolved version, so this
# catches a silently-bumped transitive CRS as well as a wrong Caddy or coraza.
RUN caddy version | grep -q 'v2.11.4' \
      && caddy build-info | grep -q 'github.com/corazawaf/coraza-caddy/v2	v2.6.1' \
      && caddy build-info | grep -q 'github.com/corazawaf/coraza-coreruleset/v4	v4.25.0'

# /data holds the internal CA (pki/authorities/local/{root,intermediate}.crt + keys). It is a named
# volume in compose so the root survives recreation — a new root would invalidate every client that
# installed the old one.
