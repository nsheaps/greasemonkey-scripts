// Unit tests for the pure parsing/URL-building logic in src/index.ts.
//
// This file is plain Node CommonJS (not TypeScript) and requires the
// already-built dist/index.js directly, since the userscript itself only
// exposes those functions via a Node-only `module.exports` guard (see the
// bottom of src/index.ts) - it is never loaded as an ES module in the browser.
// Run `yarn build` (or `tsc --build`) before `node --test test/` if dist/ is
// stale; the package's own "test" script does this for you.
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  parsePrContext,
  parseBranchContext,
  parseRunnerContext,
  parseWorkflowContext,
  resolveJumpContext,
  extractBranchFromQuery,
  buildDashboardUrl,
  buildGrafanaJumpUrl,
  labelForContext,
  GRAFANA_CONFIG,
} = require("../dist/index.js");

test("parsePrContext matches the PR checks tab and other PR sub-tabs", () => {
  assert.deepEqual(parsePrContext("/oura/some-repo/pull/42/checks"), {
    kind: "pr",
    org: "oura",
    repo: "some-repo",
    prNumber: "42",
  });
  assert.deepEqual(parsePrContext("/oura/some-repo/pull/42"), {
    kind: "pr",
    org: "oura",
    repo: "some-repo",
    prNumber: "42",
  });
  assert.deepEqual(parsePrContext("/oura/some-repo/pull/42/files"), {
    kind: "pr",
    org: "oura",
    repo: "some-repo",
    prNumber: "42",
  });
});

test("parsePrContext does not match non-PR paths", () => {
  assert.equal(parsePrContext("/oura/some-repo/pulls"), null);
  assert.equal(parsePrContext("/oura/some-repo/issues/42"), null);
  assert.equal(parsePrContext("/oura/some-repo/actions"), null);
});

test("extractBranchFromQuery reads bare and quoted branch filters", () => {
  assert.equal(extractBranchFromQuery("branch:main"), "main");
  assert.equal(extractBranchFromQuery("is:success branch:main"), "main");
  assert.equal(extractBranchFromQuery('branch:"feature/some branch"'), "feature/some branch");
  assert.equal(extractBranchFromQuery("is:success"), null);
});

test("parseBranchContext matches the repo Actions tab filtered by branch", () => {
  assert.deepEqual(
    parseBranchContext("/oura/some-repo/actions", "?query=branch%3Amy-feature"),
    { kind: "branch", org: "oura", repo: "some-repo", branch: "my-feature" },
  );
  assert.deepEqual(
    parseBranchContext("/oura/some-repo/actions/", "?query=is%3Asuccess+branch%3Amain"),
    { kind: "branch", org: "oura", repo: "some-repo", branch: "main" },
  );
});

test("parseBranchContext returns null without a branch filter or off the bare Actions tab", () => {
  assert.equal(parseBranchContext("/oura/some-repo/actions", ""), null);
  assert.equal(parseBranchContext("/oura/some-repo/actions", "?query=is%3Asuccess"), null);
  assert.equal(
    parseBranchContext("/oura/some-repo/actions/workflows/ci.yml", "?query=branch%3Amain"),
    null,
  );
});

test("parseRunnerContext matches repo-scoped and org-scoped runner pages", () => {
  assert.deepEqual(parseRunnerContext("/oura/some-repo/settings/actions/runners/17"), {
    kind: "runner",
    scope: "repo",
    org: "oura",
    runnerId: "17",
  });
  assert.deepEqual(
    parseRunnerContext("/organizations/oura/settings/actions/runners/17"),
    { kind: "runner", scope: "org", org: "oura", runnerId: "17" },
  );
});

test("parseRunnerContext returns null off a runner detail page", () => {
  assert.equal(parseRunnerContext("/oura/some-repo/settings/actions"), null);
  assert.equal(parseRunnerContext("/organizations/oura/settings/actions/runner-groups/1"), null);
});

test("parseWorkflowContext matches a workflow's own page", () => {
  assert.deepEqual(parseWorkflowContext("/oura/some-repo/actions/workflows/ci.yml"), {
    kind: "workflow",
    org: "oura",
    repo: "some-repo",
    workflowFile: "ci.yml",
  });
  assert.deepEqual(parseWorkflowContext("/oura/some-repo/actions/workflows/123456"), {
    kind: "workflow",
    org: "oura",
    repo: "some-repo",
    workflowFile: "123456",
  });
});

test("parseWorkflowContext returns null off a workflow page", () => {
  assert.equal(parseWorkflowContext("/oura/some-repo/actions"), null);
});

test("resolveJumpContext dispatches to the right parser for each supported URL shape", () => {
  assert.deepEqual(resolveJumpContext("/oura/some-repo/pull/42", ""), {
    kind: "pr",
    org: "oura",
    repo: "some-repo",
    prNumber: "42",
  });
  assert.deepEqual(
    resolveJumpContext("/oura/some-repo/actions/workflows/ci.yml", ""),
    { kind: "workflow", org: "oura", repo: "some-repo", workflowFile: "ci.yml" },
  );
  assert.deepEqual(
    resolveJumpContext("/organizations/oura/settings/actions/runners/9", ""),
    { kind: "runner", scope: "org", org: "oura", runnerId: "9" },
  );
  assert.equal(resolveJumpContext("/oura/some-repo/issues/1", ""), null);
});

test("buildDashboardUrl builds a var-prefixed, URL-encoded Grafana link", () => {
  const url = buildDashboardUrl({ uid: "abc123", slug: "my-dashboard" }, {
    branch: "feature/some branch",
  });
  assert.equal(
    url,
    "https://monitoring.oura.cloud/d/abc123/my-dashboard?var-branch=feature%2Fsome%20branch",
  );
});

test("buildDashboardUrl supports multiple variables and omits the query string when empty", () => {
  const withVars = buildDashboardUrl({ uid: "abc123", slug: "my-dashboard" }, {
    a: "1",
    b: "2",
  });
  assert.equal(withVars, "https://monitoring.oura.cloud/d/abc123/my-dashboard?var-a=1&var-b=2");

  const withoutVars = buildDashboardUrl({ uid: "abc123", slug: "my-dashboard" }, {});
  assert.equal(withoutVars, "https://monitoring.oura.cloud/d/abc123/my-dashboard");
});

test("buildGrafanaJumpUrl routes each context kind to its documented dashboard", () => {
  const prUrl = buildGrafanaJumpUrl({ kind: "pr", org: "oura", repo: "r", prNumber: "42" });
  assert.ok(prUrl.startsWith(`${GRAFANA_CONFIG.baseUrl}/d/${GRAFANA_CONFIG.dashboards.ciDevxReport.uid}/`));
  assert.ok(prUrl.includes(`var-${GRAFANA_CONFIG.varNames.prNumber}=42`));

  const branchUrl = buildGrafanaJumpUrl({ kind: "branch", org: "oura", repo: "r", branch: "main" });
  assert.ok(branchUrl.startsWith(`${GRAFANA_CONFIG.baseUrl}/d/${GRAFANA_CONFIG.dashboards.ciDevxReport.uid}/`));
  assert.ok(branchUrl.includes(`var-${GRAFANA_CONFIG.varNames.branch}=main`));

  const workflowUrl = buildGrafanaJumpUrl({
    kind: "workflow",
    org: "oura",
    repo: "r",
    workflowFile: "ci.yml",
  });
  assert.ok(workflowUrl.startsWith(`${GRAFANA_CONFIG.baseUrl}/d/${GRAFANA_CONFIG.dashboards.ciDevxReport.uid}/`));
  assert.ok(workflowUrl.includes(`var-${GRAFANA_CONFIG.varNames.workflowName}=ci.yml`));

  const runnerUrl = buildGrafanaJumpUrl({
    kind: "runner",
    scope: "repo",
    org: "oura",
    runnerId: "17",
  });
  assert.ok(runnerUrl.startsWith(`${GRAFANA_CONFIG.baseUrl}/d/${GRAFANA_CONFIG.dashboards.androidIosCi.uid}/`));
  assert.ok(runnerUrl.includes(`var-${GRAFANA_CONFIG.varNames.runnerName}=17`));
});

test("labelForContext produces a distinct human-readable label per context kind", () => {
  assert.equal(
    labelForContext({ kind: "pr", org: "oura", repo: "r", prNumber: "42" }),
    "Grafana: PR #42 CI ↗️",
  );
  assert.equal(
    labelForContext({ kind: "branch", org: "oura", repo: "r", branch: "main" }),
    "Grafana: main CI ↗️",
  );
  assert.equal(
    labelForContext({ kind: "workflow", org: "oura", repo: "r", workflowFile: "ci.yml" }),
    "Grafana: ci.yml runs ↗️",
  );
  assert.equal(
    labelForContext({ kind: "runner", scope: "org", org: "oura", runnerId: "9" }),
    "Grafana: runner 9 ↗️",
  );
});
