#!/usr/bin/env bash
# Prints the directory name of every package in the release pipeline, one per
# line, in packages/ order.
#
# A package opts in with `"greasyforkPublish": true` in its own package.json.
# That flag decides three separate things - whether a package gets auto-bumped
# (scripts/auto-bump-packages.sh), whether its built script is committed and
# mirrored at repo root for GreasyFork to read, and whether it is uploaded as a
# release asset (both in .github/workflows/release.yaml). Those three used to
# each spell the check out themselves, so renaming the flag or adding a second
# condition meant editing three places and silently shipping a half-applied
# change if you missed one. This script is the single place that answers "is
# this package published?".
#
# Usage: scripts/publishable-packages.sh   (run from anywhere in the repo)
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

for pkg_dir in packages/*/; do
  pjson="${pkg_dir}package.json"
  [ -f "$pjson" ] || continue
  opted_in="$(node -pe "require('./$pjson').greasyforkPublish === true" 2>/dev/null || echo false)"
  [ "$opted_in" = "true" ] || continue
  basename "$pkg_dir"
done
