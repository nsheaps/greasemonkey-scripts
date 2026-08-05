// Per-package release-it config - see graphite-to-github-button/.release-it.js
// for the rationale behind the shared base, the native npm plugin, and the
// path-scoped changelog. The release workflow invokes `release-it --ci` from
// inside this directory to apply a patch bump.
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
        path: ".",
      },
    },
  },
};
