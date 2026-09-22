# Open Gateway edge — Caddy + OWASP Coraza WAF (WP26b).
#
# The only self-compiled artifact in the stack: coraza-caddy is a Go module, so the WAF has to be
# linked into the Caddy binary (`xcaddy build`), not loaded at runtime. WP29b pins this image by
# digest in compose and reproduces the build in CI; until then the three versions below are the pin.
#
# coraza-caddy is held at >= 2.6.1 on purpose: earlier releases drop Flush() on the wrapped response
# writer, which stalls SSE and long-poll, and WebSocket hijack goes through the same Unwrap chain
# (WP27 depends on both). Do not relax this to a floating tag.
#
# OWASP CRS 4 needs no download and no volume — `load_owasp_crs` in the Caddyfile resolves the
# @-prefixed includes from rules compiled into this binary.

FROM caddy:2.11.4-builder-alpine AS builder

RUN xcaddy build v2.11.4 \
      --with github.com/corazawaf/coraza-caddy/v2@v2.6.1

FROM caddy:2.11.4-alpine

COPY --from=builder /usr/bin/caddy /usr/bin/caddy

# /data holds the internal CA (pki/authorities/local/{root,intermediate}.crt + keys). It is a named
# volume in compose so the root survives recreation — a new root would invalidate every client that
# installed the old one.
