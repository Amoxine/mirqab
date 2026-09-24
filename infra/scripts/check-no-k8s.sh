#!/usr/bin/env bash
# WP29b guard: this repo is Compose-only (owner decision O1). `helm/` and `k8s/` were deleted in
# WP12b (§9) and must not come back.
#
# A guard rather than a note in a doc, because the failure mode is slow and expensive: a Helm chart
# added "just to try it" becomes a second deployment description that nothing keeps in step with
# infra/docker-compose*.yml, and the first person to trust the wrong one finds out in production.
# If Kubernetes is ever adopted it is an owner decision that revisits O1 — and deletes this file in
# the same commit, which is exactly the visible moment this guard exists to create.
set -euo pipefail
cd "$(dirname "$0")/../.."

fail=0

# Directories, at the repo root and one level down — the two places a chart actually lands.
while IFS= read -r dir; do
  echo "::error file=$dir::$dir exists; this repo is Compose-only (O1). Helm/Kustomize were removed in WP12b."
  fail=1
done < <(find . -maxdepth 2 -type d \( -name helm -o -name k8s -o -name kubernetes -o -name kustomize \) \
  -not -path './node_modules/*' -not -path './.git/*' | sort)

# Kustomize needs no directory of its own: a bare kustomization.yaml anywhere is the same decision.
while IFS= read -r file; do
  echo "::error file=$file::$file exists; this repo is Compose-only (O1)."
  fail=1
done < <(find . -maxdepth 3 -type f \( -name 'kustomization.yaml' -o -name 'kustomization.yml' -o -name 'Chart.yaml' \) \
  -not -path './node_modules/*' -not -path './.git/*' | sort)

exit "$fail"
