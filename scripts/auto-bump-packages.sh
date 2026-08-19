#!/usr/bin/env bash
# Patch-bumps every publishable package whose own files changed since a base
# ref, preserving any package a human already bumped above its base version.
# Emits a JSON summary on stdout ({has_bumps, report_md, bumps[]}); all
# human-readable progress goes to stderr so stdout stays machine-parseable.
# has_bumps means "there is something to release" - true both for packages this
# run bumped and for packages a human already bumped above the base ref, since
# both need their built userscript published.
#
# Usage:
#   scripts/auto-bump-packages.sh [--change-base=REF] [--version-base=REF] [--preview]
#     --change-base : git ref to diff FILE changes against (what changed).
#     --version-base: git ref to read the BASE version from (what to compare).
#     --preview     : compute what WOULD happen (no release-it, no file writes).
#
# Both refs default to origin/main. On merge to main both are release/last-run;
# on a PR use --change-base=origin/<base> --version-base=<base> --preview.
#
# A manual version bump is detected for every package, published or not, so
# it's always visible in the preview - e.g. bumping github-actions-grafana-jump
# by hand still shows up, it just doesn't trigger a release. Only packages
# opting in with `"greasyforkPublish": true` in their own package.json are
# auto-bumped from file changes or have their asset uploaded on release;
# internal-only packages are deliberately outside the rest of the pipeline.
#
# Requires: git, jq, node. In non-preview mode also requires release-it at the
# repo root (node_modules/.bin/release-it), driven per package via that
# package's own .release-it.js.
set -euo pipefail

CHANGE_BASE="origin/main"
VERSION_BASE="origin/main"
PREVIEW=false
for arg in "$@"; do
  case "$arg" in
    --change-base=*) CHANGE_BASE="${arg#*=}" ;;
    --version-base=*) VERSION_BASE="${arg#*=}" ;;
    --preview) PREVIEW=true ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

ROOT_DIR="$(git rev-parse --show-toplevel)"
cd "$ROOT_DIR"

# Resolve a ref: prefer origin/<ref>, then <ref> directly, then HEAD~1.
resolve_ref() {
  local ref="$1"
  if git rev-parse --verify "origin/$ref" >/dev/null 2>&1; then
    echo "origin/$ref"
  elif git rev-parse --verify "$ref" >/dev/null 2>&1; then
    echo "$ref"
  else
    echo "HEAD~1"
  fi
}
CHANGE_BASE="$(resolve_ref "$CHANGE_BASE")"
VERSION_BASE="$(resolve_ref "$VERSION_BASE")"
echo "Change detection base: $CHANGE_BASE" >&2
echo "Version comparison base: $VERSION_BASE" >&2

RELEASE_IT="$ROOT_DIR/node_modules/.bin/release-it"

# Shared build inputs: files outside packages/ whose content is baked into
# EVERY published script.user.js. scripts/build-userscript.mjs renders the
# `// ==UserScript==` metablock (@version, @downloadURL, @updateURL, ...) into
# each package's artifact, so changing it changes every published artifact's
# bytes even when no package's own files moved.
#
# Without this, per-package change detection below - which only looks inside
# packages/<pkg>/ - would report "no package changes detected", has_bumps would
# be false, and the release job would skip every step. A fix to the header
# would merge and then silently never reach anyone, because nothing would
# rebuild or republish. That is a real failure mode, not a hypothetical: the
# @downloadURL/@updateURL fix that restored GreasyFork sync changed only this
# script and would have shipped nothing on its own.
SHARED_BUILD_INPUTS=("scripts/build-userscript.mjs")
SHARED_CHANGED=false
if git diff --name-only "$CHANGE_BASE..HEAD" -- "${SHARED_BUILD_INPUTS[@]}" 2>/dev/null | grep -q .; then
  SHARED_CHANGED=true
  echo "shared build input changed: every published package counts as changed" >&2
fi

# Compute the next patch version for a semver string (major.minor.patch).
next_patch() {
  local v="$1" a b c
  IFS='.' read -r a b c <<<"$v"
  echo "${a:-0}.${b:-0}.$(( ${c:-0} + 1 ))"
}

BUMP_ENTRIES=()
HAS_ROWS=false
REPORT_MD='| Package | Base | New | Action |\n|---|---|---|---|'
HAS_BUMPS=false

for pkg_dir in packages/*/; do
  [ -d "$pkg_dir" ] || continue
  name="$(basename "$pkg_dir")"
  pjson="${pkg_dir}package.json"
  [ -f "$pjson" ] || continue

  # Whether this package is in the release pipeline. Computed up front but
  # not gated on yet - the manual-bump check just below applies to every
  # package so a hand-bumped internal package still shows up in the preview.
  opted_in="$(node -pe "require('./$pjson').greasyforkPublish === true" 2>/dev/null || echo false)"

  base_version="$(git show "$VERSION_BASE:$pjson" 2>/dev/null \
    | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).version" 2>/dev/null || echo '0.0.0')"
  # A package added since the base ref has no version there; treat it as 0.0.0.
  if [ -z "$base_version" ] || [ "$base_version" = "undefined" ]; then
    base_version='0.0.0'
  fi
  head_version="$(node -pe "require('./$pjson').version")"

  # If the version in package.json is already higher than the base version,
  # someone bumped it by hand (for a minor or major release). Leave it alone.
  # We check this before looking at which files changed, further down -
  # otherwise a version bumped by hand with no other file changes would get
  # missed, since that check ignores package.json. Checked for every package
  # regardless of opted_in, so this is where a manually-bumped internal
  # package gets reported.
  if [ "$head_version" != "$base_version" ]; then
    higher="$(printf '%s\n%s\n' "$head_version" "$base_version" | sort -V | tail -1)"
    if [ "$higher" = "$head_version" ]; then
      echo "kept: $name already bumped $base_version -> $head_version" >&2
      if [ "$opted_in" = "true" ]; then
        # Still counts as releasable: the version moved since the base ref,
        # so this package needs its asset published even though we didn't
        # bump it.
        HAS_BUMPS=true
        HAS_ROWS=true
        REPORT_MD="$REPORT_MD\n| $name | $base_version | $head_version | already-bumped |"
        BUMP_ENTRIES+=("$(jq -nc --arg n "$name" --arg p "$pjson" --arg b "$base_version" \
          --arg w "$head_version" --arg a already-bumped \
          '{name:$n,path:$p,base:$b,new:$w,action:$a}')")
      else
        # Not in the release pipeline, so it never goes into bumps/has_bumps -
        # there's no .release-it.js or built script.user.js for the release
        # job to publish. Reported for visibility only.
        HAS_ROWS=true
        REPORT_MD="$REPORT_MD\n| $name | $base_version | $head_version | manual (internal) |"
      fi
      continue
    fi
  fi

  # Everything below only applies to packages in the release pipeline - an
  # internal-only package with no version bump (handled above) has nothing
  # further to detect or report.
  [ "$opted_in" = "true" ] || continue

  # A package counts as "changed" if a shared build input changed (see
  # SHARED_BUILD_INPUTS above - that rewrites every published artifact), or if
  # any of its own files, other than package.json and CHANGELOG.md, differ from
  # the change base. We skip those two files so that a previous version-bump
  # commit doesn't trigger another bump on its own. We only get here after
  # already checking above for a hand-bumped version, so this check never hides
  # one of those.
  if [ "$SHARED_CHANGED" = false ] \
    && ! git diff --name-only "$CHANGE_BASE..HEAD" -- "$pkg_dir" 2>/dev/null \
      | grep -vE '(^|/)(package\.json|CHANGELOG\.md)$' | grep -q .; then
    continue
  fi

  if [ "$PREVIEW" = true ]; then
    new_version="$(next_patch "$head_version")"
    action=will-bump
  else
    echo "bumping: $name from $head_version" >&2
    if ! ( cd "$pkg_dir" && "$RELEASE_IT" --ci >&2 ); then
      echo "::error::release-it failed for package '$name'" >&2
      exit 1
    fi
    new_version="$(node -pe "require('./$pjson').version")"
    action=auto-bumped
  fi
  HAS_BUMPS=true
  HAS_ROWS=true
  REPORT_MD="$REPORT_MD\n| $name | $base_version | $new_version | $action |"
  BUMP_ENTRIES+=("$(jq -nc --arg n "$name" --arg p "$pjson" --arg b "$base_version" \
    --arg w "$new_version" --arg a "$action" \
    '{name:$n,path:$p,base:$b,new:$w,action:$a}')")
done

if [ "${#BUMP_ENTRIES[@]}" -gt 0 ]; then
  bumps="$(printf '%s\n' "${BUMP_ENTRIES[@]}" | jq -sc '.')"
else
  bumps='[]'
fi

# BUMP_ENTRIES alone would miss the manual-internal-bump rows added above,
# which are reported but deliberately excluded from bumps/has_bumps.
if [ "$HAS_ROWS" = false ]; then
  REPORT_MD="$REPORT_MD\n| _no package changes detected_ |  |  |  |"
fi

jq -n \
  --argjson has_bumps "$HAS_BUMPS" \
  --arg report_md "$(printf '%b' "$REPORT_MD")" \
  --argjson bumps "$bumps" \
  '{has_bumps:$has_bumps, report_md:$report_md, bumps:$bumps}'
