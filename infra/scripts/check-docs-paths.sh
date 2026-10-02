#!/usr/bin/env bash
# WP12b guard (A3.2 "docs drift"): fails CI if README.md, CHANGELOG.md, docs/deployment.md or
# docs/go-live.md (the production runbook, whose every command and path an operator will follow) link to
# a repo-relative path that does not exist. This is what caught helm/, k8s/, observability/{nestjs,
# nextjs}, backup/ and scripts/ sitting empty while these docs claimed delivery — and what stops the
# next one from landing silently.
set -euo pipefail
cd "$(dirname "$0")/../.."

fail=0
for doc in README.md CHANGELOG.md docs/deployment.md docs/go-live.md; do
  dir=$(dirname "$doc")
  while IFS= read -r target; do
    target="${target%%#*}" # drop an in-page #fragment before checking existence
    [ -z "$target" ] && continue
    case "$target" in
      http://* | https://* | mailto:*) continue ;;
    esac
    path="$dir/$target"
    if [ ! -e "$path" ]; then
      echo "::error file=$doc::referenced path does not exist: $target (resolved: $path)"
      fail=1
    fi
  done < <(grep -ohE '\]\([^)]+\)' "$doc" | sed -E 's/^\]\(//; s/\)$//')
done

exit "$fail"
