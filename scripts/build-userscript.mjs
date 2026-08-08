#!/usr/bin/env node
// Renders a userscript's `// ==UserScript==` metadata block and prepends it to
// the tsc-compiled dist/index.js, writing the result to dist/script.user.js
// (the single artifact uploaded as a GitHub Release asset, and the file
// GreasyFork/Tampermonkey fetch via each script's @downloadURL/@updateURL).
//
// Why generate the header instead of writing it into src/index.ts:
// userscript sources have no import/export, so tsc treats them as global
// scripts and (because "strict" implies "alwaysStrict") emits a `"use strict";`
// prologue at the very top of dist/index.js. The metablock has to be the
// literal first thing in the file - real Greasemonkey silently ignores a
// metablock that isn't - so a header committed inside the TS source always ends
// up one line too low. Switching tsc to module mode instead makes it emit a
// bare `export {};` marker, which is a SyntaxError when a userscript manager
// injects the file as a classic script. Generating the header here sidesteps
// both: the block is prepended after compilation, so it is always first and
// tsc's `"use strict";` simply lands underneath it.
//
// Usage: node ../../scripts/build-userscript.mjs   (run from a package root)

import { readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";

// Where the released userscripts are read from. Kept here, in the one script
// that renders every package's header, so the repo's own coordinates live in a
// single place instead of being hand-typed into each package's meta.json (where
// a package directory rename would silently leave a stale URL behind).
const REPO_ORG = "nsheaps";
const REPO_NAME = "greasemonkey-scripts";

const pkgDir = process.cwd();
const readJson = (relPath) =>
  JSON.parse(readFileSync(resolve(pkgDir, relPath), "utf8"));

const pkg = readJson("package.json");
const meta = readJson("src/meta.json");

// package.json is the single source of truth for the version (release-it bumps
// it per package), so meta.json declaring one too would be a second, silently
// diverging source. Fail loudly rather than picking a winner.
if ("version" in meta) {
  throw new Error(
    "src/meta.json must not declare a 'version' key - @version is taken from package.json"
  );
}

// Same reasoning as 'version': the download/update URLs are derived from the
// package's own directory name, so a meta.json still declaring them is a second
// source that would silently drift on a directory rename.
for (const key of ["downloadURL", "updateURL"]) {
  if (key in meta) {
    throw new Error(
      `src/meta.json must not declare a '${key}' key - @downloadURL/@updateURL are derived from the package directory name`
    );
  }
}

// The last segment of the package root is the directory name under packages/,
// which is the path GreasyFork and Tampermonkey fetch the built script from.
const scriptUrl = `https://raw.githubusercontent.com/${REPO_ORG}/${REPO_NAME}/latest/packages/${basename(pkgDir)}/dist/script.user.js`;

// Always emit whatever package.json currently holds. Between releases that is
// the last released version, which is honest for a local build, and on a
// release build release-it has already bumped it to the new version.
const entries = [
  ["name", meta.name],
  ["version", pkg.version],
  ...Object.entries(meta).filter(([key]) => key !== "name"),
  ["downloadURL", scriptUrl],
  ["updateURL", scriptUrl],
];

// Flatten array values (e.g. multiple @match rules) into one line per value,
// and pad keys so the rendered block stays column-aligned and readable.
const rendered = entries.flatMap(([key, value]) =>
  (Array.isArray(value) ? value : [value]).map((v) => [key, v])
);
const width = Math.max(...rendered.map(([key]) => key.length));
const header = [
  "// ==UserScript==",
  ...rendered.map(([key, v]) => `// @${key.padEnd(width)} ${v}`),
  "// ==/UserScript==",
  "",
].join("\n");

const compiled = readFileSync(resolve(pkgDir, "dist/index.js"), "utf8");
writeFileSync(resolve(pkgDir, "dist/script.user.js"), header + compiled);
