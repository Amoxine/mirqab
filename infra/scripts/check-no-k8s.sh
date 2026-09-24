#!/usr/bin/env bash
# WP29b guard: this repo is Compose-only (owner decision O1). `helm/` and `k8s/` were deleted in
# WP12b (§9) and must not come back.
#
# A guard rather than a note in a doc, because the failure mode is slow and expensive: a Helm chart
# added "just to try it" becomes a second deployment description that nothing keeps in step with
# infra/docker-compose*.yml, and the first person to trust the wrong one finds out in production.
# If Kubernetes is ever adopted it is an owner decision that revisits O1 — and deletes this file in
# the same commit, which is exactly the visible moment this guard exists to create.
#
# NO DEPTH LIMIT, deliberately. The first version capped `find` at -maxdepth 2/3, which sounded
# careful and made the guard trivially evadable — `deploy/charts/app/Chart.yaml`, `infra/charts/`,
# `a/b/c/k8s/` and `deploy/overlays/prod/kustomization.yaml` all sailed past it (found by worker-3).
# A guard with a depth limit only catches the tidy case, which is not the case worth catching. The
# prune list below is what keeps it fast, and it is about directories that are not ours to police.
set -euo pipefail
cd "$(dirname "$0")/../.."

fail=0

# Everything under here is either not source or not ours: vendored deps, VCS internals, build
# output. `-prune` stops find descending rather than filtering after the fact, which is what makes
# an unbounded search cheap.
prune=(
  -name node_modules -o
  -name .git -o
  -name .next -o
  -name dist -o
  -name .turbo -o
  -name coverage
)

# Directory names that mean Kubernetes and nothing else, at ANY depth.
#
# `charts` is deliberately NOT here. It was, on the reasoning that a Helm chart usually lands in a
# `charts/` directory — but `charts` is an ordinary English word and the repo has
# `apps/web/src/components/analytics/charts/`, so the guard failed on legitimate UI code (found by
# worker-3). A chart is caught by its `Chart.yaml` below at any depth anyway, which is a name that
# means only one thing. A guard that cries wolf on a components directory gets disabled, and then
# it guards nothing.
while IFS= read -r dir; do
  echo "::error file=$dir::$dir exists; this repo is Compose-only (O1). Helm/Kustomize were removed in WP12b."
  fail=1
done < <(find . \( "${prune[@]}" \) -prune -o \
  -type d \( -name helm -o -name k8s -o -name kubernetes -o -name kustomize \) -print | sort)

# The filenames are unique enough to search for on their own, and a chart or overlay can live in a
# directory called anything at all — `deploy/overlays/prod/kustomization.yaml` names no directory
# the list above would catch.
while IFS= read -r file; do
  echo "::error file=$file::$file exists; this repo is Compose-only (O1)."
  fail=1
done < <(find . \( "${prune[@]}" \) -prune -o \
  -type f \( -name 'kustomization.yaml' -o -name 'kustomization.yml' \
             -o -name 'Kustomization' \
             -o -name 'Chart.yaml' -o -name 'Chart.yml' \) -print | sort)

exit "$fail"
