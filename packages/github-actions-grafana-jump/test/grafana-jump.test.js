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
  parseRunnerGroupContext,
  parseWorkflowContext,
  parseRunContext,
  resolveJumpContext,
  extractBranchFromQuery,
  contextFields,
  requiredFields,
  applicableDashboards,
  repoContextForJump,
  activeDashboards,
  mergeConfigsForExport,
  buildDashboardUrl,
  renderTemplate,
  buildTraceExploreUrl,
  buildJumpUrl,
  labelForContext,
  defaultConfig,
  normalizeConfig,
  isConfigured,
  parseYamlLite,
  configToYamlLite,
  buildCreateFileUrl,
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
    repo: "some-repo",
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

test("parseRunnerGroupContext matches an org's runner group detail page", () => {
  assert.deepEqual(
    parseRunnerGroupContext("/organizations/oura/settings/actions/runner-groups/3"),
    { kind: "runnerGroup", org: "oura", groupId: "3" },
  );
});

test("parseRunnerGroupContext returns null off a runner group detail page", () => {
  assert.equal(parseRunnerGroupContext("/organizations/oura/settings/actions/runners/3"), null);
  assert.equal(parseRunnerGroupContext("/oura/some-repo/settings/actions"), null);
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

test("parseRunContext matches a run's overview page and a specific job within it", () => {
  assert.deepEqual(parseRunContext("/oura/some-repo/actions/runs/123456"), {
    kind: "run",
    org: "oura",
    repo: "some-repo",
    runId: "123456",
  });
  assert.deepEqual(parseRunContext("/oura/some-repo/actions/runs/123456/job/789"), {
    kind: "run",
    org: "oura",
    repo: "some-repo",
    runId: "123456",
    jobId: "789",
  });
});

test("parseRunContext returns null off a run page", () => {
  assert.equal(parseRunContext("/oura/some-repo/actions/workflows/ci.yml"), null);
  assert.equal(parseRunContext("/oura/some-repo/actions"), null);
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
    resolveJumpContext("/oura/some-repo/actions/runs/9/job/1", ""),
    { kind: "run", org: "oura", repo: "some-repo", runId: "9", jobId: "1" },
  );
  assert.deepEqual(
    resolveJumpContext("/organizations/oura/settings/actions/runners/9", ""),
    { kind: "runner", scope: "org", org: "oura", runnerId: "9" },
  );
  assert.deepEqual(
    resolveJumpContext("/organizations/oura/settings/actions/runner-groups/2", ""),
    { kind: "runnerGroup", org: "oura", groupId: "2" },
  );
  assert.equal(resolveJumpContext("/oura/some-repo/issues/1", ""), null);
});

test("contextFields exposes every page-provided field per context kind", () => {
  assert.deepEqual(contextFields({ kind: "pr", org: "o", repo: "r", prNumber: "42" }), {
    repo: "r",
    prNumber: "42",
  });
  assert.deepEqual(contextFields({ kind: "branch", org: "o", repo: "r", branch: "main" }), {
    repo: "r",
    branch: "main",
  });
  assert.deepEqual(
    contextFields({ kind: "workflow", org: "o", repo: "r", workflowFile: "ci.yml" }),
    { repo: "r", workflowName: "ci.yml" },
  );
  assert.deepEqual(contextFields({ kind: "run", org: "o", repo: "r", runId: "9" }), {
    repo: "r",
    runId: "9",
  });
  assert.deepEqual(
    contextFields({ kind: "run", org: "o", repo: "r", runId: "9", jobId: "1" }),
    { repo: "r", runId: "9", jobId: "1" },
  );
  assert.deepEqual(
    contextFields({ kind: "runner", scope: "repo", org: "o", repo: "r", runnerId: "5" }),
    { repo: "r", runnerName: "5" },
  );
  assert.deepEqual(
    contextFields({ kind: "runner", scope: "org", org: "o", runnerId: "5" }),
    { runnerName: "5" },
  );
  assert.deepEqual(contextFields({ kind: "runnerGroup", org: "o", groupId: "3" }), {
    runnerGroupName: "3",
  });
});

test("defaultConfig starts empty and unconfigured", () => {
  const config = defaultConfig();
  assert.equal(config.baseUrl, "");
  assert.deepEqual(config.dashboards, []);
  assert.equal(isConfigured(config), false);
});

test("isConfigured requires both a base URL and at least one target", () => {
  assert.equal(isConfigured({ baseUrl: "", dashboards: [] }), false);
  assert.equal(
    isConfigured({ baseUrl: "https://g.example.com", dashboards: [] }),
    false,
  );
  assert.equal(
    isConfigured({
      baseUrl: "https://g.example.com",
      dashboards: [{ type: "dashboard", name: "d", uid: "u", slug: "s", varNames: {} }],
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
      { type: "dashboard", name: "My Dashboard", uid: "abc123", slug: "my-dash", varNames: { branch: "br" } },
    ],
  });
});

test("normalizeConfig treats an entry with no `type` field as a dashboard (the format's original shape)", () => {
  const result = normalizeConfig({
    baseUrl: "https://g.example.com",
    dashboards: [{ name: "legacy", uid: "u1", slug: "s1", varNames: { branch: "br" } }],
  });
  assert.deepEqual(result.dashboards, [
    { type: "dashboard", name: "legacy", uid: "u1", slug: "s1", varNames: { branch: "br" } },
  ]);
});

test("normalizeConfig reads a trace target, trimming and collapsing an embedded newline in its query", () => {
  const result = normalizeConfig({
    baseUrl: "https://g.example.com",
    dashboards: [
      {
        type: "trace",
        name: "  Run trace  ",
        id: " run-trace ",
        datasourceUid: " tempo-uid ",
        query: '{resource.github.run_id="{{runId}}"}\n  && foo="bar"',
      },
    ],
  });
  assert.deepEqual(result.dashboards, [
    {
      type: "trace",
      name: "Run trace",
      id: "run-trace",
      datasourceUid: "tempo-uid",
      query: '{resource.github.run_id="{{runId}}"} && foo="bar"',
    },
  ]);
});

test("normalizeConfig drops a trace target missing id, datasourceUid, or query", () => {
  const base = { type: "trace", name: "x", id: "i", datasourceUid: "d", query: "{{runId}}" };
  for (const missing of ["id", "datasourceUid", "query"]) {
    const result = normalizeConfig({
      baseUrl: "https://g.example.com",
      dashboards: [{ ...base, [missing]: "" }],
    });
    assert.deepEqual(result.dashboards, [], `expected a trace with no ${missing} to be dropped`);
  }
});

test("requiredFields reads a dashboard's configured varNames entries", () => {
  assert.deepEqual(
    requiredFields({ type: "dashboard", name: "", uid: "u", slug: "s", varNames: { branch: "b", runId: "r" } }),
    ["branch", "runId"],
  );
  assert.deepEqual(
    requiredFields({ type: "dashboard", name: "", uid: "u", slug: "s", varNames: {} }),
    [],
  );
});

test("requiredFields reads a trace target's {{placeholder}} references, ignoring unknown ones", () => {
  assert.deepEqual(
    requiredFields({
      type: "trace",
      name: "",
      id: "i",
      datasourceUid: "d",
      query: '{resource.github.run_id="{{runId}}" && resource.github.job_id="{{jobId}}"}',
    }),
    ["runId", "jobId"],
  );
  assert.deepEqual(
    requiredFields({ type: "trace", name: "", id: "i", datasourceUid: "d", query: '{foo="{{notARealField}}"}' }),
    [],
  );
});

test("applicableDashboards requires every one of a target's configured fields to be present", () => {
  const config = {
    baseUrl: "https://g.example.com",
    dashboards: [
      { type: "dashboard", name: "branch-only", uid: "u1", slug: "s1", varNames: { branch: "br" } },
      {
        type: "dashboard",
        name: "repo-and-branch",
        uid: "u2",
        slug: "s2",
        varNames: { repo: "repository", branch: "br" },
      },
      { type: "dashboard", name: "runner-only", uid: "u3", slug: "s3", varNames: { runnerName: "runner" } },
      { type: "dashboard", name: "no-vars", uid: "u4", slug: "s4", varNames: {} },
      {
        type: "trace",
        name: "run-trace",
        id: "t1",
        datasourceUid: "tempo",
        query: '{resource.run_id="{{runId}}"}',
      },
      {
        type: "trace",
        name: "job-span",
        id: "t2",
        datasourceUid: "tempo",
        query: '{resource.run_id="{{runId}}" && resource.job_id="{{jobId}}"}',
      },
    ],
  };

  const branchContext = { kind: "branch", org: "o", repo: "r", branch: "main" };
  assert.deepEqual(
    applicableDashboards(config, branchContext).map((d) => d.name),
    ["branch-only", "repo-and-branch"],
  );

  const prContext = { kind: "pr", org: "o", repo: "r", prNumber: "1" };
  assert.deepEqual(applicableDashboards(config, prContext), []);

  const runnerContext = { kind: "runner", scope: "repo", org: "o", repo: "r", runnerId: "1" };
  assert.deepEqual(
    applicableDashboards(config, runnerContext).map((d) => d.name),
    ["runner-only"],
  );

  const runContext = { kind: "run", org: "o", repo: "r", runId: "9" };
  assert.deepEqual(applicableDashboards(config, runContext).map((d) => d.name), ["run-trace"]);

  const jobContext = { kind: "run", org: "o", repo: "r", runId: "9", jobId: "1" };
  assert.deepEqual(
    applicableDashboards(config, jobContext).map((d) => d.name),
    ["run-trace", "job-span"],
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

test("renderTemplate substitutes known {{fieldKey}} placeholders and leaves unknown ones untouched", () => {
  assert.equal(
    renderTemplate('{a="{{runId}}" && b="{{jobId}}"}', { runId: "9", jobId: "1" }),
    '{a="9" && b="1"}',
  );
  assert.equal(renderTemplate('{a="{{bogus}}"}', { runId: "9" }), '{a="{{bogus}}"}');
  assert.equal(renderTemplate('{a="{{runId}}"}', {}), '{a="{{runId}}"}');
});

test("buildJumpUrl applies every configured varName the context has a value for", () => {
  const dashboard = {
    type: "dashboard",
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
  const dashboard = { type: "dashboard", name: "CI", uid: "abc123", slug: "ci-dashboard", varNames: {} };
  const url = buildJumpUrl("https://g.example.com", dashboard, {
    kind: "runner",
    scope: "repo",
    org: "o",
    runnerId: "9",
  });
  assert.equal(url, "https://g.example.com/d/abc123/ci-dashboard");
});

test("buildJumpUrl builds a Tempo Explore search for a trace target", () => {
  const trace = {
    type: "trace",
    name: "Run trace",
    id: "t1",
    datasourceUid: "tempo-uid",
    query: '{resource.github.run_id="{{runId}}"}',
  };
  const url = buildJumpUrl("https://g.example.com", trace, {
    kind: "run",
    org: "o",
    repo: "r",
    runId: "42",
  });
  const parsed = new URL(url);
  assert.equal(`${parsed.origin}${parsed.pathname}`, "https://g.example.com/explore");
  assert.equal(parsed.searchParams.get("schemaVersion"), "1");
  assert.equal(parsed.searchParams.get("orgId"), "1");
  const panes = JSON.parse(parsed.searchParams.get("panes"));
  assert.equal(panes.jump.datasource, "tempo-uid");
  assert.equal(panes.jump.queries[0].queryType, "traceql");
  assert.equal(panes.jump.queries[0].query, '{resource.github.run_id="42"}');
});

test("buildTraceExploreUrl fills in the query template from the given fields", () => {
  const trace = {
    type: "trace",
    name: "Job span",
    id: "t2",
    datasourceUid: "tempo-uid",
    query: '{resource.run_id="{{runId}}" && resource.job_id="{{jobId}}"}',
  };
  const url = buildTraceExploreUrl("https://g.example.com", trace, { runId: "9", jobId: "1" });
  const panes = JSON.parse(new URL(url).searchParams.get("panes"));
  assert.equal(panes.jump.queries[0].query, '{resource.run_id="9" && resource.job_id="1"}');
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
    labelForContext({ kind: "run", org: "oura", repo: "r", runId: "9" }),
    "Grafana: run #9",
  );
  assert.equal(
    labelForContext({ kind: "run", org: "oura", repo: "r", runId: "9", jobId: "1" }),
    "Grafana: run #9 / job #1",
  );
  assert.equal(
    labelForContext({ kind: "runner", scope: "org", org: "oura", runnerId: "9" }),
    "Grafana: runner 9",
  );
  assert.equal(
    labelForContext({ kind: "runnerGroup", org: "oura", groupId: "3" }),
    "Grafana: runner group 3",
  );
});

test("repoContextForJump extracts {org, repo} for repo-scoped contexts", () => {
  assert.deepEqual(repoContextForJump({ kind: "pr", org: "o", repo: "r", prNumber: "1" }), {
    org: "o",
    repo: "r",
  });
  assert.deepEqual(
    repoContextForJump({ kind: "branch", org: "o", repo: "r", branch: "main" }),
    { org: "o", repo: "r" },
  );
  assert.deepEqual(
    repoContextForJump({ kind: "workflow", org: "o", repo: "r", workflowFile: "ci.yml" }),
    { org: "o", repo: "r" },
  );
  assert.deepEqual(
    repoContextForJump({ kind: "run", org: "o", repo: "r", runId: "9" }),
    { org: "o", repo: "r" },
  );
  assert.deepEqual(
    repoContextForJump({ kind: "runner", scope: "repo", org: "o", repo: "r", runnerId: "9" }),
    { org: "o", repo: "r" },
  );
});

test("repoContextForJump returns null for org-scoped runner and runnerGroup contexts", () => {
  assert.equal(
    repoContextForJump({ kind: "runner", scope: "org", org: "o", runnerId: "9" }),
    null,
  );
  assert.equal(repoContextForJump({ kind: "runnerGroup", org: "o", groupId: "3" }), null);
});

test("activeDashboards prefers the personal config outright when it has anything applicable", () => {
  const personal = {
    baseUrl: "https://personal.example.com",
    dashboards: [{ type: "dashboard", name: "mine", uid: "p1", slug: "mine", varNames: { branch: "br" } }],
  };
  const repo = {
    baseUrl: "https://repo.example.com",
    dashboards: [{ type: "dashboard", name: "theirs", uid: "r1", slug: "theirs", varNames: { branch: "br" } }],
  };
  const context = { kind: "branch", org: "o", repo: "r", branch: "main" };
  assert.deepEqual(activeDashboards(personal, repo, context), [
    { baseUrl: "https://personal.example.com", dashboard: personal.dashboards[0] },
  ]);
});

test("activeDashboards falls back to the repo config when personal has nothing applicable", () => {
  const personal = { baseUrl: "https://personal.example.com", dashboards: [] };
  const repo = {
    baseUrl: "https://repo.example.com",
    dashboards: [{ type: "dashboard", name: "theirs", uid: "r1", slug: "theirs", varNames: { branch: "br" } }],
  };
  const context = { kind: "branch", org: "o", repo: "r", branch: "main" };
  assert.deepEqual(activeDashboards(personal, repo, context), [
    { baseUrl: "https://repo.example.com", dashboard: repo.dashboards[0] },
  ]);
});

test("activeDashboards returns nothing when neither config nor a null repo config has anything applicable", () => {
  const personal = { baseUrl: "", dashboards: [] };
  const context = { kind: "branch", org: "o", repo: "r", branch: "main" };
  assert.deepEqual(activeDashboards(personal, null, context), []);
});

test("mergeConfigsForExport unions targets, deduped by targetKey, preferring the repo's copy", () => {
  const repo = {
    baseUrl: "https://repo.example.com",
    dashboards: [
      { type: "dashboard", name: "repo-only", uid: "r1", slug: "repo-only", varNames: { branch: "br" } },
      { type: "dashboard", name: "shared (repo version)", uid: "shared", slug: "shared", varNames: {} },
      { type: "trace", name: "repo trace (repo version)", id: "trace1", datasourceUid: "tempo", query: "{{runId}}" },
    ],
  };
  const personal = {
    baseUrl: "https://personal.example.com",
    dashboards: [
      { type: "dashboard", name: "personal-only", uid: "p1", slug: "personal-only", varNames: {} },
      {
        type: "dashboard",
        name: "shared (personal version)",
        uid: "shared",
        slug: "shared",
        varNames: { prNumber: "pr" },
      },
      { type: "trace", name: "repo trace (personal version)", id: "trace1", datasourceUid: "tempo", query: "x" },
      { type: "trace", name: "personal-only trace", id: "trace2", datasourceUid: "tempo", query: "y" },
    ],
  };
  assert.deepEqual(mergeConfigsForExport(repo, personal), {
    baseUrl: "https://repo.example.com",
    dashboards: [
      repo.dashboards[0],
      repo.dashboards[1],
      repo.dashboards[2],
      personal.dashboards[0],
      personal.dashboards[3],
    ],
  });
});

test("mergeConfigsForExport falls back to the personal baseUrl when there is no repo config", () => {
  const personal = {
    baseUrl: "https://personal.example.com",
    dashboards: [{ type: "dashboard", name: "mine", uid: "p1", slug: "mine", varNames: {} }],
  };
  assert.deepEqual(mergeConfigsForExport(null, personal), {
    baseUrl: "https://personal.example.com",
    dashboards: personal.dashboards,
  });
});

test("parseYamlLite reads a baseUrl and a sequence of dashboard mappings with nested varNames", () => {
  const text = [
    "# a leading comment, and a blank line below",
    "",
    "baseUrl: https://grafana.example.com",
    "dashboards:",
    "  - type: dashboard",
    "    name: CI Overview",
    "    uid: abc123",
    "    slug: ci-overview",
    "    varNames:",
    "      branch: branch",
    "      prNumber: pr_number",
  ].join("\n");

  assert.deepEqual(parseYamlLite(text), {
    baseUrl: "https://grafana.example.com",
    dashboards: [
      {
        type: "dashboard",
        name: "CI Overview",
        uid: "abc123",
        slug: "ci-overview",
        varNames: { branch: "branch", prNumber: "pr_number" },
      },
    ],
  });
});

test("parseYamlLite unquotes single- and double-quoted scalars", () => {
  const text = ['name: "quoted value"', "slug: 'also quoted'"].join("\n");
  assert.deepEqual(parseYamlLite(text), { name: "quoted value", slug: "also quoted" });
});

test("parseYamlLite unescapes backslash-escaped quotes/backslashes inside a double-quoted scalar", () => {
  const text = 'query: "{a=\\"b\\"} \\\\ done"';
  assert.deepEqual(parseYamlLite(text), { query: '{a="b"} \\ done' });
});

test("parseYamlLite reads a single-quoted TraceQL query containing embedded double quotes verbatim", () => {
  const text = 'query: \'{resource.github.run_id="{{runId}}"}\'';
  assert.deepEqual(parseYamlLite(text), { query: '{resource.github.run_id="{{runId}}"}' });
});

test("parseYamlLite round-trips through configToYamlLite for a config with dashboard and trace targets", () => {
  const config = {
    baseUrl: "https://grafana.example.com",
    dashboards: [
      {
        type: "dashboard",
        name: "CI Overview",
        uid: "abc123",
        slug: "ci-overview",
        varNames: { branch: "branch", prNumber: "pr_number" },
      },
      { type: "dashboard", name: "No vars", uid: "def456", slug: "no-vars", varNames: {} },
      {
        type: "trace",
        name: "Job span",
        id: "job-span",
        datasourceUid: "tempo-uid",
        query: '{resource.run_id="{{runId}}" && resource.job_id="{{jobId}}"}',
      },
    ],
  };
  assert.deepEqual(normalizeConfig(parseYamlLite(configToYamlLite(config))), config);
});

test("configToYamlLite quotes scalars that would otherwise be misread", () => {
  const config = {
    baseUrl: "https://grafana.example.com",
    dashboards: [
      { type: "dashboard", name: "- looks like a list item", uid: "u1", slug: "s1", varNames: {} },
    ],
  };
  const yaml = configToYamlLite(config);
  assert.match(yaml, /name: "- looks like a list item"/);
  assert.deepEqual(normalizeConfig(parseYamlLite(yaml)), config);
});

test("buildCreateFileUrl builds a GitHub create-file link with filename and value query params", () => {
  const url = buildCreateFileUrl("o", "r", "main", ".github/jump-links.config.yaml", "baseUrl: https://g.example.com\n");
  assert.equal(
    url,
    "https://github.com/o/r/new/main?filename=.github%2Fjump-links.config.yaml&value=baseUrl%3A+https%3A%2F%2Fg.example.com%0A",
  );
});
