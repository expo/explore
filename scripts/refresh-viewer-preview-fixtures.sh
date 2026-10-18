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
# One ZIP per target, named for it: <target>.zip, or <platform>.zip for a report from before targets. A target named
# after its platform is selected with ?platform=, any other with ?target= (as viewer-links.ts targetParameter does).
# A preview deployed before Explore wrote static files serves each target's ZIP; a newer one serves its manifest and
# screenshots, so the ZIP is put back together here. Screenshot requests keep the target's query, which deployments
# that answered them from the ZIP need and static files ignore.
for key in $(jq -r '.[] | .target // .platform' "$work/listing.json"); do
  # The listing comes from the hosted preview: a key names files here, so it must be a target id.
  [[ "$key" =~ ^[a-z][a-z0-9-]{0,31}$ ]] || { echo "Not a target id in reports.json: $key" >&2; exit 2; }
  case "$key" in ios|android) query="platform=$key" ;; *) query="target=$key" ;; esac
  if curl -fsS "$base/report.zip?$query" -o "$work/$key.zip" 2> /dev/null; then
    unzip -tq "$work/$key.zip" > /dev/null
    continue
  fi
  report="$work/$key"
  mkdir -p "$report/assets"
  curl -fsS "$base/manifest.json?$query" -o "$work/$key.manifest.json"
  file="$(jq -r .file "$work/$key.manifest.json")"
  [[ "$file" == review.json || "$file" == exploration.json ]] || { echo "Not a report manifest: $key" >&2; exit 1; }
  jq -c .report "$work/$key.manifest.json" > "$report/$file"
  for asset in $(jq -r '.entries | keys[]' "$work/$key.manifest.json"); do
    [[ "$asset" =~ ^assets/[a-f0-9]{64}\.(png|jpg|mp4)$ ]] || { echo "Unexpected asset name: $asset" >&2; exit 1; }
    curl -fsS "$base/$asset?$query" -o "$report/$asset"
    [[ "$(shasum -a 256 "$report/$asset" | cut -c1-64)" == "${asset:7:64}" ]] || { echo "Checksum mismatch: $asset" >&2; exit 1; }
  done
  rm -f "$work/$key.zip"
  (cd "$report" && zip -qrX "$work/$key.zip" "$file" assets)
  unzip -tq "$work/$key.zip" > /dev/null
done
jq --arg source "$source_name" '[.[] | {target, platform, label, changes, device, source: $source} | with_entries(select(.value != null))]' "$work/listing.json" > "$work/reports.json"

gh release view "$tag" > /dev/null 2>&1 || gh release create "$tag" --prerelease --latest=false --title "Viewer preview fixtures" \
  --notes "Reports the Viewer preview workflow serves on every pull request. Refresh with scripts/refresh-viewer-preview-fixtures.sh."
# Drop assets of platforms the new reports no longer have.
for asset in $(gh release view "$tag" --json assets -q '.assets[].name'); do
  [[ -f "$work/$asset" ]] || gh release delete-asset "$tag" "$asset" --yes
done
gh release upload "$tag" "$work/reports.json" "$work"/*.zip --clobber
jq -c . "$work/reports.json"
