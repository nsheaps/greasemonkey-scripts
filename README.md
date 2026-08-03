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
- Each release run publishes one GitHub Release carrying every bumped script's
  compiled `<package-name>.user.js` as an asset. Published scripts point their
  `@downloadURL`/`@updateURL` at that release's stable `latest/download` URL,
  so a userscript manager installed directly from GitHub auto-updates from
  there. [GreasyFork](https://greasyfork.org/en/scripts?by=1372068) forcibly
  rewrites those same fields for any script actually listed on its site, so
  the existing GreasyFork listings keep updating through GreasyFork's own
  mechanism instead - this pipeline doesn't change that.
- `yarn bump` runs the same bump logic locally; pass `--preview` to see what
  would happen without writing anything.

## License

MIT
