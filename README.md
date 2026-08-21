# Greasemonkey Scripts

A collection of user scripts for various websites, built with TypeScript and managed as a monorepo.

## Project Structure

This repository uses a monorepo structure with the following setup:

- Yarn workspaces for package management
- NX for build orchestration
- TypeScript for development
- mise for toolchain (node/yarn) version management
- release-it for per-package version management
- oxlint for linting
- GitHub Actions for CI/CD

## Getting Started

1. Install the pinned toolchain with [mise](https://mise.jdx.dev/) (this
   installs the node and yarn versions pinned in `mise.toml`):

   ```bash
   mise install
   ```

2. Install dependencies:

   ```bash
   yarn install
   ```

3. Build the project:
   ```bash
   yarn build
   ```

## Development

- Each script is a separate package in the `packages/` directory.
- To add a new script, copy `packages/template/` to `packages/<your-script>/`
  and update its `package.json` name and `src/meta.json`. Set
  `"greasyforkPublish": true` in its `package.json` to opt it into the release
  pipeline; leave the field off for an internal-only script.
- A script's `// ==UserScript==` metadata block is **not** written into
  `src/index.ts`. It lives in that package's `src/meta.json`, and
  `scripts/build-userscript.mjs` renders it into `dist/script.user.js` at build
  time with `@version` taken from the package's `package.json`.

## Versioning and releases

- Every publishable package owns its own version (`package.json`) and its own
  `CHANGELOG.md`. There is no repo-wide version.
- Versions are bumped automatically on merge to `main`, never in a PR. A PR
  gets a sticky comment previewing the bumps it will cause.
- A patch bump is applied to each package whose files changed since the last
  release. Bumping a version by hand in a PR (e.g. for a minor or major
  release) is respected and not bumped again on top.
- Each release run cuts one shared GitHub Release, attaches every published
  package's built script to it as `<package-name>.user.js`, and also commits
  those built files at a tagged (but never merged) commit - both at
  `packages/<package-name>/dist/script.user.js` and mirrored flat at repo root
  as `<package-name>.user.js`.
- Published scripts point their `@downloadURL`/`@updateURL` at
  `https://github.com/nsheaps/greasemonkey-scripts/releases/latest/download/<package-name>.user.js`,
  so a userscript manager installed directly from GitHub auto-updates from
  there.
- That same URL is what each script's **"sync from URL"** setting on
  [GreasyFork](https://greasyfork.org/en/scripts?by=1372068) must be set to
  (an account-side setting, not something this repo can change). GreasyFork's
  release webhook only syncs a script when it can regenerate that script's
  stored sync URL byte-for-byte from the release payload, and
  `releases/latest/download/...` is the only supported URL form that contains
  no branch/tag segment - so it is the only one that stays stable across
  releases. A sync URL pointing at any other ref (a raw blob at `latest`, at a
  version tag, ...) silently never matches and the script never updates. See
  the contract comment at the top of `.github/workflows/release.yaml` before
  changing any of these URLs.
- GreasyFork rewrites `@downloadURL`/`@updateURL` in the copy it serves, so
  people who installed a script *from* GreasyFork update through GreasyFork
  regardless. That only decides where an installed script polls - it is not
  what gets a new version into GreasyFork in the first place, which is what
  the sync URL above is for.
- `yarn bump` runs the same bump logic locally; pass `--preview` to see what
  would happen without writing anything.

## License

MIT
