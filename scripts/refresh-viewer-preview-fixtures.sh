#!/usr/bin/env bash
# Replaces the reports every pull request's Viewer preview serves with the ones a hosted Explore preview serves now,
# for example the latest euxy review:
#
#   scripts/refresh-viewer-preview-fixtures.sh 'https://euxy-explore--kks4rz14sn.expo.app/p/<token>' brentvatne/euxy#154
#
# The reports are stored as assets of this repository's viewer-preview-fixtures release (not in git), and the
# preview workflow downloads them on each run. The second argument names where they came from in the PR comment.
set -euo pipefail
url="${1:?Pass a hosted preview link: https://<project>--<id>.expo.app/p/<token>}"
source_name="${2:?Pass where the reports came from, e.g. brentvatne/euxy#154}"
base="$(printf '%s' "$url" | sed -E 's#^(https://[a-z0-9-]+\.expo\.app/p/[a-z2-7]{32}).*#\1#')"
[[ "$base" =~ ^https://[a-z0-9-]+\.expo\.app/p/[a-z2-7]{32}$ ]] || { echo "Not a hosted preview link: $url" >&2; exit 2; }
tag=viewer-preview-fixtures
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

if ! curl -fsS "$base/reports.json" -o "$work/listing.json"; then
  echo '[{"platform":"ios"}]' > "$work/listing.json"
fi
for platform in $(jq -r '.[].platform' "$work/listing.json"); do
  curl -fsS "$base/report.zip?platform=$platform" -o "$work/$platform.zip"
  unzip -tq "$work/$platform.zip" > /dev/null
done
jq --arg source "$source_name" '[.[] | {platform, changes, device, source: $source} | with_entries(select(.value != null))]' "$work/listing.json" > "$work/reports.json"

gh release view "$tag" > /dev/null 2>&1 || gh release create "$tag" --prerelease --latest=false --title "Viewer preview fixtures" \
  --notes "Reports the Viewer preview workflow serves on every pull request. Refresh with scripts/refresh-viewer-preview-fixtures.sh."
# Drop assets of platforms the new reports no longer have.
for asset in $(gh release view "$tag" --json assets -q '.assets[].name'); do
  [[ -f "$work/$asset" ]] || gh release delete-asset "$tag" "$asset" --yes
done
gh release upload "$tag" "$work/reports.json" "$work"/*.zip --clobber
jq -c . "$work/reports.json"
