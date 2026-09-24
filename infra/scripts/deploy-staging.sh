#!/usr/bin/env bash
# Staging deploy, run ON THE STAGING HOST (WP29b).
#
# Piped in over SSH by .github/workflows/cd-staging.yml, preceded by an `export` prelude that the
# workflow builds with printf %q:
#   { printf 'export REMOTE_PATH=%q …\n' "$REMOTE_PATH" …; cat infra/scripts/deploy-staging.sh; } \
#     | ssh <host> 'bash -s'
#
# A file rather than a heredoc inside the workflow, for three reasons that each bit: a quoted
# heredoc terminator has to sit at column 0, which cannot happen inside a YAML block scalar; a
# script in the repo is reviewed and shellcheck-able like any other code; and a manual deploy runs
# the same steps CD does instead of an approximation someone retypes under pressure.
#
# The prelude is why this is safe, and the earlier form was NOT. It used to be
# `ssh <host> "REMOTE_PATH='$REMOTE_PATH' … bash -s"`, with a comment claiming a value could not
# become a command. That was false, and worker-3 demonstrated it: a value containing a single quote
# closes the quoting and the rest runs as a command on the staging host
# (`/tmp'; touch /tmp/pwned; echo '` created the file). `printf %q` emits a shell-quoted token that
# survives being re-parsed, so the values are data whatever they contain.
set -euo pipefail

: "${REMOTE_PATH:?REMOTE_PATH is required (the checkout on this host)}"
: "${DEPLOY_SHA:?DEPLOY_SHA is required (the commit CI built and tested)}"
: "${WEB_IMAGE:?WEB_IMAGE is required}"
: "${API_IMAGE:?API_IMAGE is required}"
: "${EDGE_IMAGE:?EDGE_IMAGE is required}"

cd "$REMOTE_PATH"

# The exact commit CI tested, fetched by sha. NOT `git pull --ff-only`: main can move between the
# build job and this one, and deploying a commit that was never built is how a "successful" deploy
# ends up serving something no test ever saw.
git fetch --prune origin
git fetch origin "$DEPLOY_SHA"
git checkout --detach "$DEPLOY_SHA"
echo "deploying $(git rev-parse --short HEAD)"

# The digests this deploy is pinned to, written where compose reads them. The three lines are
# REPLACED, not appended: .env is read top to bottom and a stale duplicate left above would be
# silently overridden by — or silently override — the value we just decided on.
#
# Built in a TEMP FILE and only moved into place after the pull succeeds. The first version wrote
# infra/.env immediately and pulled afterwards, so a pull failure left the host's committed
# configuration pointing at images it had never fetched while the previous stack kept serving — a
# later `docker compose up` by hand would then have tried to start something that was not there.
# Nothing observes the temp file but `--env-file` below, so a failed deploy changes no state.
env_file=infra/.env
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
if [ -f "$env_file" ]; then
  grep -vE '^(WEB_IMAGE|API_IMAGE|EDGE_IMAGE)=' "$env_file" > "$tmp" || true
fi
{
  echo "WEB_IMAGE=$WEB_IMAGE"
  echo "API_IMAGE=$API_IMAGE"
  echo "EDGE_IMAGE=$EDGE_IMAGE"
} >> "$tmp"
# Preserve the existing mode: .env holds REDIS_PASSWORD, TYK_GW_SECRET and DB_PASS, and `mktemp`
# would otherwise hand them 0600-from-scratch or, worse, a umask-dependent mode.
if [ -f "$env_file" ]; then
  chmod --reference="$env_file" "$tmp"
else
  chmod 600 "$tmp"
fi

compose=(docker compose --env-file "$tmp" -f infra/docker-compose.yml -f infra/docker-compose.prod.yml --profile multinode)

# Pull BEFORE up: an image that cannot be fetched then fails while the previous stack is still
# serving, rather than half way through a recreate with some services already torn down. It also
# gates the .env rewrite below — `set -e` means a failed pull never reaches it.
"${compose[@]}" pull

# The pull worked, so these digests are fetchable on this host. Only now does the configuration on
# disk start naming them. `cp` then `mv` of a copy, rather than moving $tmp itself, so the EXIT trap
# stays valid and the file keeps the mode set above.
cp -p "$tmp" "$tmp.final"
mv "$tmp.final" "$env_file"

# prod-preflight gates this (service_completed_successfully on api, web and every gateway node): a
# default secret, or an EDGE_IMAGE that is not digest-pinned, aborts the up rather than warning.
"${compose[@]}" up -d --remove-orphans
"${compose[@]}" ps
