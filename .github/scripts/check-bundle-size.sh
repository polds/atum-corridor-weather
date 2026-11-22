#!/usr/bin/env bash
# Fails when the built Worker is over the Workers free-plan size limit, 3 MiB after gzip.
# It measures the modules that `wrangler deploy --dry-run --outdir <dir>` writes, and skips
# source maps and the README that wrangler adds to the directory.
#
# Usage: check-bundle-size.sh <outdir> [limit in bytes]
set -euo pipefail

dir="${1:?usage: check-bundle-size.sh <outdir> [limit in bytes]}"
limit="${2:-3145728}"

total=0
count=0
while IFS= read -r -d '' file; do
	size=$(gzip -c "$file" | wc -c)
	printf '%10d bytes gzip  %s\n' "$size" "$file"
	total=$((total + size))
	count=$((count + 1))
done < <(find "$dir" -type f ! -name '*.map' ! -name 'README.md' -print0 | sort -z)

if [ "$count" -eq 0 ]; then
	echo "error: no Worker modules found in $dir" >&2
	exit 1
fi

summary="Worker bundle: $total bytes gzip ($((total / 1024)) KiB) in $count file(s). Limit: $limit bytes."
echo "$summary"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
	echo "$summary" >>"$GITHUB_STEP_SUMMARY"
fi

if [ "$total" -gt "$limit" ]; then
	echo "error: the Worker bundle is over the limit by $((total - limit)) bytes." >&2
	exit 1
fi
