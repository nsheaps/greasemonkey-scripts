// Per-package release-it config. The release workflow invokes
// `release-it --ci` from inside this directory to apply a patch bump, so every
// path below resolves against this package, not the repo root.
//
// Unlike the marketplace repos this pattern came from, this package has a real
// package.json, so release-it's NATIVE npm plugin owns the version bump and
// @release-it/bumper isn't needed (bumper exists for versions that live in a
// non-package.json manifest). The shared base sets `npm: { publish: false }`
// rather than `npm: false`: the latter disables the whole npm plugin including
// the version bump, which is why the old repo-wide config never actually
// updated any package.json.
//
// Committing, tagging and pushing are all disabled in the base config. The
// release workflow gathers every package's bump into a single commit and one
// push - see .github/workflows/release.yaml.
module.exports = {
  extends: "../../.release-it.base.json",
  plugins: {
    "@release-it/conventional-changelog": {
      preset: {
        name: "conventionalcommits",
        types: [
          { type: "feat", section: "Features" },
          { type: "fix", section: "Bug Fixes" },
          { type: "perf", section: "Performance" },
          { type: "refactor", section: "Refactoring" },
          { type: "docs", section: "Documentation" },
          { type: "chore", section: "Maintenance" },
        ],
      },
      infile: "CHANGELOG.md",
      header: "# Changelog",
      gitRawCommitsOpts: {
        firstParent: false,
        // Scope the changelog to commits that touched this package. Without
        // it, conventional-changelog walks every commit in the monorepo and
        // each package's CHANGELOG would list the others' changes too.
        path: ".",
      },
    },
  },
};
