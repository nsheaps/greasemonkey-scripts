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
# Only packages opting in with `"greasyforkPublish": true` in their own
# package.json are considered - internal-only packages (e.g.
# github-actions-grafana-jump) are deliberately outside the release pipeline.
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

# Compute the next patch version for a semver string (major.minor.patch).
next_patch() {
  local v="$1" a b c
  IFS='.' read -r a b c <<<"$v"
  echo "${a:-0}.${b:-0}.$(( ${c:-0} + 1 ))"
}

BUMP_ENTRIES=()
REPORT_MD='| Package | Base | New | Action |\n|---|---|---|---|'
HAS_BUMPS=false

for pkg_dir in packages/*/; do
  [ -d "$pkg_dir" ] || continue
  name="$(basename "$pkg_dir")"
  pjson="${pkg_dir}package.json"
  [ -f "$pjson" ] || continue

  # Only packages that opt in to public release.
  opted_in="$(node -pe "require('./$pjson').greasyforkPublish === true" 2>/dev/null || echo false)"
  [ "$opted_in" = "true" ] || continue

  base_version="$(git show "$VERSION_BASE:$pjson" 2>/dev/null \
    | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).version" 2>/dev/null || echo '0.0.0')"
  # A package added since the base ref has no version there; treat it as 0.0.0.
  if [ -z "$base_version" ] || [ "$base_version" = "undefined" ]; then
    base_version='0.0.0'
  fi
  head_version="$(node -pe "require('./$pjson').version")"

  # If the working-tree version is already higher than the base, a human bumped
  # it deliberately (e.g. a minor/major bump). Preserve it, do not re-bump.
  # Checked before the "did anything else change" filter below so a
  # version-only manual bump (no other file touched) is still caught - it
  # would otherwise be skipped by that filter, which ignores package.json.
  if [ "$head_version" != "$base_version" ]; then
    higher="$(printf '%s\n%s\n' "$head_version" "$base_version" | sort -V | tail -1)"
    if [ "$higher" = "$head_version" ]; then
      echo "kept: $name already bumped $base_version -> $head_version" >&2
      # Still counts as releasable: the version moved since the base ref, so
      # this package needs its asset published even though we didn't bump it.
      HAS_BUMPS=true
      REPORT_MD="$REPORT_MD\n| $name | $base_version | $head_version | already-bumped |"
      BUMP_ENTRIES+=("$(jq -nc --arg n "$name" --arg p "$pjson" --arg b "$base_version" \
        --arg w "$head_version" --arg a already-bumped \
        '{name:$n,path:$p,base:$b,new:$w,action:$a}')")
      continue
    fi
  fi

  # A package "changed" if any of its files other than package.json and
  # CHANGELOG.md differ from the change base. Those two are excluded so a
  # previous version-bump commit alone does not re-trigger another bump.
  # Only reached once the already-bumped case above has been ruled out, so
  # a version-only manual bump is never silently dropped by this filter.
  if ! git diff --name-only "$CHANGE_BASE..HEAD" -- "$pkg_dir" 2>/dev/null \
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
  REPORT_MD="$REPORT_MD\n| $name | $base_version | $new_version | $action |"
  BUMP_ENTRIES+=("$(jq -nc --arg n "$name" --arg p "$pjson" --arg b "$base_version" \
    --arg w "$new_version" --arg a "$action" \
    '{name:$n,path:$p,base:$b,new:$w,action:$a}')")
done

if [ "${#BUMP_ENTRIES[@]}" -gt 0 ]; then
  bumps="$(printf '%s\n' "${BUMP_ENTRIES[@]}" | jq -sc '.')"
else
  bumps='[]'
  REPORT_MD="$REPORT_MD\n| _no package changes detected_ |  |  |  |"
fi

jq -n \
  --argjson has_bumps "$HAS_BUMPS" \
  --arg report_md "$(printf '%b' "$REPORT_MD")" \
  --argjson bumps "$bumps" \
  '{has_bumps:$has_bumps, report_md:$report_md, bumps:$bumps}'
