#!/usr/bin/env bash
# WP12b guard (A3.2 "5 pages ungated"): every (dashboard) page.tsx must render behind
# PagePermissionGate except the landing page, which is intentionally ungated.
set -euo pipefail
cd "$(dirname "$0")/../.."

landing="apps/web/src/app/(dashboard)/page.tsx"
fail=0

while IFS= read -r page; do
  if [ "$page" != "$landing" ] && ! grep -q "PagePermissionGate" "$page"; then
    echo "::error file=$page::dashboard page has no PagePermissionGate"
    fail=1
  fi
done < <(find "apps/web/src/app/(dashboard)" -name "page.tsx" | sort)

exit "$fail"
