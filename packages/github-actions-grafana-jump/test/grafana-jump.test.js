// Unit tests for the pure parsing/URL-building/config logic in src/index.ts.
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
  contextVarKey,
  contextFilterValue,
  applicableDashboards,
  buildDashboardUrl,
  buildJumpUrl,
  labelForContext,
  defaultConfig,
  normalizeConfig,
  isConfigured,
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

test("contextVarKey maps each context kind to its DashboardVarNames field", () => {
  assert.equal(contextVarKey("pr"), "prNumber");
  assert.equal(contextVarKey("branch"), "branch");
  assert.equal(contextVarKey("workflow"), "workflowName");
  assert.equal(contextVarKey("runner"), "runnerName");
});

test("contextFilterValue extracts the raw filter value per context kind", () => {
  assert.equal(contextFilterValue({ kind: "pr", org: "o", repo: "r", prNumber: "42" }), "42");
  assert.equal(contextFilterValue({ kind: "branch", org: "o", repo: "r", branch: "main" }), "main");
  assert.equal(
    contextFilterValue({ kind: "workflow", org: "o", repo: "r", workflowFile: "ci.yml" }),
    "ci.yml",
  );
  assert.equal(
    contextFilterValue({ kind: "runner", scope: "repo", org: "o", runnerId: "9" }),
    "9",
  );
});

test("defaultConfig starts empty and unconfigured", () => {
  const config = defaultConfig();
  assert.equal(config.baseUrl, "");
  assert.deepEqual(config.dashboards, []);
  assert.equal(isConfigured(config), false);
});

test("isConfigured requires both a base URL and at least one dashboard", () => {
  assert.equal(isConfigured({ baseUrl: "", dashboards: [] }), false);
  assert.equal(
    isConfigured({ baseUrl: "https://g.example.com", dashboards: [] }),
    false,
  );
  assert.equal(
    isConfigured({
      baseUrl: "https://g.example.com",
      dashboards: [{ name: "d", uid: "u", slug: "s", varNames: {} }],
    }),
    true,
  );
});

test("normalizeConfig drops malformed input and defaults to empty", () => {
  assert.deepEqual(normalizeConfig(null), { baseUrl: "", dashboards: [] });
  assert.deepEqual(normalizeConfig(undefined), { baseUrl: "", dashboards: [] });
  assert.deepEqual(normalizeConfig("not an object"), { baseUrl: "", dashboards: [] });
  assert.deepEqual(normalizeConfig({}), { baseUrl: "", dashboards: [] });
});

test("normalizeConfig trims strings, drops empty varNames, and drops dashboards with no uid", () => {
  const result = normalizeConfig({
    baseUrl: "  https://g.example.com  ",
    dashboards: [
      {
        name: "  My Dashboard  ",
        uid: " abc123 ",
        slug: " my-dash ",
        varNames: { branch: " br ", prNumber: "", workflowName: "  ", runnerName: 5 },
      },
      { name: "no uid", uid: "", slug: "x", varNames: {} },
      "not an object",
      null,
    ],
  });
  assert.deepEqual(result, {
    baseUrl: "https://g.example.com",
    dashboards: [
      { name: "My Dashboard", uid: "abc123", slug: "my-dash", varNames: { branch: "br" } },
    ],
  });
});

test("applicableDashboards only returns dashboards with a varName for the context's field", () => {
  const config = {
    baseUrl: "https://g.example.com",
    dashboards: [
      { name: "branch-only", uid: "u1", slug: "s1", varNames: { branch: "br" } },
      { name: "pr-and-branch", uid: "u2", slug: "s2", varNames: { branch: "br", prNumber: "pr" } },
      { name: "runner-only", uid: "u3", slug: "s3", varNames: { runnerName: "runner" } },
    ],
  };

  const branchContext = { kind: "branch", org: "o", repo: "r", branch: "main" };
  assert.deepEqual(
    applicableDashboards(config, branchContext).map((d) => d.name),
    ["branch-only", "pr-and-branch"],
  );

  const prContext = { kind: "pr", org: "o", repo: "r", prNumber: "1" };
  assert.deepEqual(applicableDashboards(config, prContext).map((d) => d.name), ["pr-and-branch"]);

  const runnerContext = { kind: "runner", scope: "repo", org: "o", runnerId: "1" };
  assert.deepEqual(
    applicableDashboards(config, runnerContext).map((d) => d.name),
    ["runner-only"],
  );

  const workflowContext = { kind: "workflow", org: "o", repo: "r", workflowFile: "ci.yml" };
  assert.deepEqual(applicableDashboards(config, workflowContext), []);
});

test("buildDashboardUrl builds a var-prefixed, URL-encoded Grafana link", () => {
  const url = buildDashboardUrl(
    "https://g.example.com",
    { uid: "abc123", slug: "my-dashboard" },
    { branch: "feature/some branch" },
  );
  assert.equal(
    url,
    "https://g.example.com/d/abc123/my-dashboard?var-branch=feature%2Fsome%20branch",
  );
});

test("buildDashboardUrl supports multiple variables and omits the query string when empty", () => {
  const withVars = buildDashboardUrl(
    "https://g.example.com",
    { uid: "abc123", slug: "my-dashboard" },
    { a: "1", b: "2" },
  );
  assert.equal(withVars, "https://g.example.com/d/abc123/my-dashboard?var-a=1&var-b=2");

  const withoutVars = buildDashboardUrl(
    "https://g.example.com",
    { uid: "abc123", slug: "my-dashboard" },
    {},
  );
  assert.equal(withoutVars, "https://g.example.com/d/abc123/my-dashboard");
});

test("buildJumpUrl applies the dashboard's own varName for the context's field", () => {
  const dashboard = {
    name: "CI",
    uid: "abc123",
    slug: "ci-dashboard",
    varNames: { branch: "branch_name", prNumber: "pr_num" },
  };

  const branchUrl = buildJumpUrl("https://g.example.com", dashboard, {
    kind: "branch",
    org: "o",
    repo: "r",
    branch: "main",
  });
  assert.equal(branchUrl, "https://g.example.com/d/abc123/ci-dashboard?var-branch_name=main");

  const prUrl = buildJumpUrl("https://g.example.com", dashboard, {
    kind: "pr",
    org: "o",
    repo: "r",
    prNumber: "42",
  });
  assert.equal(prUrl, "https://g.example.com/d/abc123/ci-dashboard?var-pr_num=42");
});

test("buildJumpUrl omits the var- filter entirely when the dashboard has no matching varName", () => {
  const dashboard = { name: "CI", uid: "abc123", slug: "ci-dashboard", varNames: {} };
  const url = buildJumpUrl("https://g.example.com", dashboard, {
    kind: "runner",
    scope: "repo",
    org: "o",
    runnerId: "9",
  });
  assert.equal(url, "https://g.example.com/d/abc123/ci-dashboard");
});

test("labelForContext produces a distinct human-readable label per context kind", () => {
  assert.equal(
    labelForContext({ kind: "pr", org: "oura", repo: "r", prNumber: "42" }),
    "Grafana: PR #42 CI",
  );
  assert.equal(
    labelForContext({ kind: "branch", org: "oura", repo: "r", branch: "main" }),
    "Grafana: main CI",
  );
  assert.equal(
    labelForContext({ kind: "workflow", org: "oura", repo: "r", workflowFile: "ci.yml" }),
    "Grafana: ci.yml runs",
  );
  assert.equal(
    labelForContext({ kind: "runner", scope: "org", org: "oura", runnerId: "9" }),
    "Grafana: runner 9",
  );
});
