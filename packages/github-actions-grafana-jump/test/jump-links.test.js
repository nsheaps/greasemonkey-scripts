// Unit tests for the pure parsing/templating/config logic in src/index.ts.
//
// This file is plain Node CommonJS (not TypeScript) and requires the
// already-built dist/index.js directly, since the userscript itself only
// exposes those functions via a Node-only `module.exports` guard (see the
// bottom of src/index.ts) - it is never loaded as an ES module in the browser.
// Run `yarn build` (or `tsc --build`) before `node --test test/` if dist/ is
// stale; the package's own "test" script does this for you.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  parseRepoHomeContext,
  parseRepoFileContext,
  parsePrContext,
  parsePrListContext,
  parseBranchListContext,
  parseActionsListContext,
  parseBranchContext,
  parseRunnerContext,
  parseRunnerGroupContext,
  parseWorkflowContext,
  parseRunContext,
  resolveJumpContext,
  extractBranchFromQuery,
  contextFields,
  rowFieldKey,
  isListPageKind,
  availableFieldKeys,
  sampleContext,
  placeholderFields,
  applicableLinks,
  repoContextForJump,
  activeLinks,
  mergeConfigsForExport,
  renderTemplate,
  linkDisplayName,
  linksForPage,
  defaultConfig,
  normalizeConfig,
  isConfigured,
  isJumpPageKind,
  JUMP_PAGE_KINDS,
  parseYamlLite,
  configToYamlLite,
  buildCreateFileUrl,
  isVersionUpdate,
  pageFieldsReference,
  REPO_CONFIG_TEMPLATE,
} = require("../dist/index.js");

// ---------------------------------------------------------------------------
// Page parsers
// ---------------------------------------------------------------------------

test("parseRepoHomeContext matches a repo's own landing page", () => {
  assert.deepEqual(parseRepoHomeContext("/oura/some-repo"), {
    kind: "repoHome",
    org: "oura",
    repo: "some-repo",
  });
  assert.deepEqual(parseRepoHomeContext("/oura/some-repo/"), {
    kind: "repoHome",
    org: "oura",
    repo: "some-repo",
  });
});

test("parseRepoHomeContext does not match deeper paths or GitHub's own global pages", () => {
  assert.equal(parseRepoHomeContext("/oura/some-repo/pulls"), null);
  assert.equal(parseRepoHomeContext("/oura"), null);
  assert.equal(parseRepoHomeContext("/organizations/oura"), null);
  assert.equal(parseRepoHomeContext("/settings/profile"), null);
  assert.equal(parseRepoHomeContext("/notifications/subscriptions"), null);
});

test("parseRepoFileContext matches a file at a ref and decodes the ref", () => {
  assert.deepEqual(parseRepoFileContext("/oura/some-repo/blob/main/README.md"), {
    kind: "repoFile",
    org: "oura",
    repo: "some-repo",
    branch: "main",
  });
  assert.deepEqual(parseRepoFileContext("/oura/some-repo/blob/my%2Fbranch/src/index.ts"), {
    kind: "repoFile",
    org: "oura",
    repo: "some-repo",
    branch: "my/branch",
  });
});

test("parseRepoFileContext does not match a directory view or a bare ref", () => {
  assert.equal(parseRepoFileContext("/oura/some-repo/tree/main/src"), null);
  assert.equal(parseRepoFileContext("/oura/some-repo/blob/main"), null);
});

test("parsePrContext matches the PR checks tab and other PR sub-tabs", () => {
  for (const pathname of [
    "/oura/some-repo/pull/42",
    "/oura/some-repo/pull/42/checks",
    "/oura/some-repo/pull/42/files",
  ]) {
    assert.deepEqual(parsePrContext(pathname), {
      kind: "pr",
      org: "oura",
      repo: "some-repo",
      prNumber: "42",
    });
  }
});

test("parsePrContext does not match non-PR paths", () => {
  assert.equal(parsePrContext("/oura/some-repo/pulls"), null);
  assert.equal(parsePrContext("/oura/some-repo/issues/42"), null);
  assert.equal(parsePrContext("/oura/some-repo/actions"), null);
});

test("parsePrListContext matches the repo's PR list", () => {
  assert.deepEqual(parsePrListContext("/oura/some-repo/pulls"), {
    kind: "prList",
    org: "oura",
    repo: "some-repo",
  });
  assert.deepEqual(parsePrListContext("/oura/some-repo/pulls/"), {
    kind: "prList",
    org: "oura",
    repo: "some-repo",
  });
  assert.equal(parsePrListContext("/oura/some-repo/pull/42"), null);
});

test("parseBranchListContext matches the branch list and its sub-tabs", () => {
  const expected = { kind: "branchList", org: "oura", repo: "some-repo" };
  assert.deepEqual(parseBranchListContext("/oura/some-repo/branches"), expected);
  assert.deepEqual(parseBranchListContext("/oura/some-repo/branches/all"), expected);
  assert.deepEqual(parseBranchListContext("/oura/some-repo/branches/yours"), expected);
  assert.equal(parseBranchListContext("/oura/some-repo/branch_commits/abc"), null);
});

test("extractBranchFromQuery reads bare and quoted branch filters", () => {
  assert.equal(extractBranchFromQuery("branch:main"), "main");
  assert.equal(extractBranchFromQuery("is:success branch:main"), "main");
  assert.equal(extractBranchFromQuery('branch:"feature/some branch"'), "feature/some branch");
  assert.equal(extractBranchFromQuery("is:success"), null);
});

test("parseBranchContext matches the repo Actions tab filtered by branch", () => {
  assert.deepEqual(parseBranchContext("/oura/some-repo/actions", "?query=branch%3Amy-feature"), {
    kind: "branch",
    org: "oura",
    repo: "some-repo",
    branch: "my-feature",
  });
  assert.deepEqual(parseBranchContext("/oura/some-repo/actions/", "?query=is%3Asuccess+branch%3Amain"), {
    kind: "branch",
    org: "oura",
    repo: "some-repo",
    branch: "main",
  });
});

test("parseBranchContext returns null without a branch filter or off the bare Actions tab", () => {
  assert.equal(parseBranchContext("/oura/some-repo/actions", ""), null);
  assert.equal(parseBranchContext("/oura/some-repo/actions", "?query=is%3Asuccess"), null);
  assert.equal(parseBranchContext("/oura/some-repo/actions/workflows/ci.yml", "?query=branch%3Amain"), null);
});

test("parseActionsListContext matches the repo Actions tab", () => {
  assert.deepEqual(parseActionsListContext("/oura/some-repo/actions"), {
    kind: "actionsList",
    org: "oura",
    repo: "some-repo",
  });
  assert.equal(parseActionsListContext("/oura/some-repo/actions/workflows/ci.yml"), null);
});

test("parseRunnerContext matches repo-scoped and org-scoped runner pages", () => {
  assert.deepEqual(parseRunnerContext("/oura/some-repo/settings/actions/runners/17"), {
    kind: "runner",
    scope: "repo",
    org: "oura",
    repo: "some-repo",
    runnerId: "17",
  });
  assert.deepEqual(parseRunnerContext("/organizations/oura/settings/actions/runners/17"), {
    kind: "runner",
    scope: "org",
    org: "oura",
    runnerId: "17",
  });
});

test("parseRunnerContext returns null off a runner detail page", () => {
  assert.equal(parseRunnerContext("/oura/some-repo/settings/actions"), null);
  assert.equal(parseRunnerContext("/organizations/oura/settings/actions/runner-groups/1"), null);
});

test("parseRunnerGroupContext matches an org's runner group detail page", () => {
  assert.deepEqual(parseRunnerGroupContext("/organizations/oura/settings/actions/runner-groups/3"), {
    kind: "runnerGroup",
    org: "oura",
    groupId: "3",
  });
  assert.equal(parseRunnerGroupContext("/organizations/oura/settings/actions/runners/3"), null);
});

test("parseWorkflowContext matches a workflow's own page", () => {
  assert.deepEqual(parseWorkflowContext("/oura/some-repo/actions/workflows/ci.yml"), {
    kind: "workflow",
    org: "oura",
    repo: "some-repo",
    workflowFile: "ci.yml",
  });
  assert.equal(parseWorkflowContext("/oura/some-repo/actions"), null);
});

test("parseRunContext distinguishes a run's own page from one job within it", () => {
  assert.deepEqual(parseRunContext("/oura/some-repo/actions/runs/123456"), {
    kind: "run",
    org: "oura",
    repo: "some-repo",
    runId: "123456",
  });
  assert.deepEqual(parseRunContext("/oura/some-repo/actions/runs/123456/job/789"), {
    kind: "job",
    org: "oura",
    repo: "some-repo",
    runId: "123456",
    jobId: "789",
  });
  assert.equal(parseRunContext("/oura/some-repo/actions/workflows/ci.yml"), null);
});

test("resolveJumpContext dispatches to the right parser for each supported URL shape", () => {
  const cases = [
    ["/oura/some-repo", "", { kind: "repoHome", org: "oura", repo: "some-repo" }],
    [
      "/oura/some-repo/blob/main/README.md",
      "",
      { kind: "repoFile", org: "oura", repo: "some-repo", branch: "main" },
    ],
    ["/oura/some-repo/pull/42", "", { kind: "pr", org: "oura", repo: "some-repo", prNumber: "42" }],
    ["/oura/some-repo/pulls", "", { kind: "prList", org: "oura", repo: "some-repo" }],
    ["/oura/some-repo/branches", "", { kind: "branchList", org: "oura", repo: "some-repo" }],
    ["/oura/some-repo/actions", "", { kind: "actionsList", org: "oura", repo: "some-repo" }],
    [
      "/oura/some-repo/actions",
      "?query=branch%3Amain",
      { kind: "branch", org: "oura", repo: "some-repo", branch: "main" },
    ],
    [
      "/oura/some-repo/actions/workflows/ci.yml",
      "",
      { kind: "workflow", org: "oura", repo: "some-repo", workflowFile: "ci.yml" },
    ],
    ["/oura/some-repo/actions/runs/9", "", { kind: "run", org: "oura", repo: "some-repo", runId: "9" }],
    [
      "/oura/some-repo/actions/runs/9/job/1",
      "",
      { kind: "job", org: "oura", repo: "some-repo", runId: "9", jobId: "1" },
    ],
    [
      "/organizations/oura/settings/actions/runners/9",
      "",
      { kind: "runner", scope: "org", org: "oura", runnerId: "9" },
    ],
    [
      "/organizations/oura/settings/actions/runner-groups/2",
      "",
      { kind: "runnerGroup", org: "oura", groupId: "2" },
    ],
  ];
  for (const [pathname, search, expected] of cases) {
    assert.deepEqual(resolveJumpContext(pathname, search), expected, `for ${pathname}${search}`);
  }
});

test("resolveJumpContext returns null for pages with no jump context", () => {
  assert.equal(resolveJumpContext("/oura/some-repo/issues/1", ""), null);
  assert.equal(resolveJumpContext("/oura/some-repo/tree/main/src", ""), null);
  assert.equal(resolveJumpContext("/", ""), null);
});

test("resolveJumpContext covers every declared page kind", () => {
  // A page kind offered in configs with no URL that ever resolves to it would
  // be dead config surface, so every kind must be reachable.
  const reachable = new Set(
    JUMP_PAGE_KINDS.map((page) => resolveJumpContextForSample(page)).filter(Boolean),
  );
  assert.deepEqual([...JUMP_PAGE_KINDS].sort(), [...reachable].sort());
});

/** The URL shape each page kind is reached by, resolved back to its kind. */
function resolveJumpContextForSample(page) {
  const urls = {
    repoHome: ["/oura/some-repo", ""],
    repoFile: ["/oura/some-repo/blob/main/README.md", ""],
    pr: ["/oura/some-repo/pull/42", ""],
    prList: ["/oura/some-repo/pulls", ""],
    branchList: ["/oura/some-repo/branches", ""],
    actionsList: ["/oura/some-repo/actions", ""],
    branch: ["/oura/some-repo/actions", "?query=branch%3Amain"],
    workflow: ["/oura/some-repo/actions/workflows/ci.yml", ""],
    run: ["/oura/some-repo/actions/runs/9", ""],
    job: ["/oura/some-repo/actions/runs/9/job/1", ""],
    runner: ["/oura/some-repo/settings/actions/runners/1", ""],
    runnerGroup: ["/organizations/oura/settings/actions/runner-groups/1", ""],
  }[page];
  assert.ok(urls, `no example URL for page kind ${page}`);
  return resolveJumpContext(urls[0], urls[1])?.kind;
}

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

const GITHUB_COMMON_FIELDS = {
  serverUrl: "https://github.com",
  apiUrl: "https://api.github.com",
};

test("contextFields exposes every page-provided field per context kind", () => {
  const repoFields = { repo: "r", org: "o", repoFullName: "o/r" };
  assert.deepEqual(contextFields({ kind: "repoHome", org: "o", repo: "r" }), {
    ...GITHUB_COMMON_FIELDS,
    ...repoFields,
  });
  assert.deepEqual(contextFields({ kind: "repoFile", org: "o", repo: "r", branch: "main" }), {
    ...GITHUB_COMMON_FIELDS,
    ...repoFields,
    branch: "main",
  });
  assert.deepEqual(contextFields({ kind: "pr", org: "o", repo: "r", prNumber: "42" }), {
    ...GITHUB_COMMON_FIELDS,
    ...repoFields,
    prNumber: "42",
  });
  assert.deepEqual(contextFields({ kind: "prList", org: "o", repo: "r" }), {
    ...GITHUB_COMMON_FIELDS,
    ...repoFields,
  });
  assert.deepEqual(contextFields({ kind: "branchList", org: "o", repo: "r" }), {
    ...GITHUB_COMMON_FIELDS,
    ...repoFields,
  });
  assert.deepEqual(contextFields({ kind: "actionsList", org: "o", repo: "r" }), {
    ...GITHUB_COMMON_FIELDS,
    ...repoFields,
  });
  assert.deepEqual(contextFields({ kind: "branch", org: "o", repo: "r", branch: "main" }), {
    ...GITHUB_COMMON_FIELDS,
    ...repoFields,
    branch: "main",
  });
  assert.deepEqual(contextFields({ kind: "workflow", org: "o", repo: "r", workflowFile: "ci.yml" }), {
    ...GITHUB_COMMON_FIELDS,
    ...repoFields,
    workflowName: "ci.yml",
  });
  assert.deepEqual(contextFields({ kind: "run", org: "o", repo: "r", runId: "9" }), {
    ...GITHUB_COMMON_FIELDS,
    ...repoFields,
    runId: "9",
  });
  assert.deepEqual(contextFields({ kind: "job", org: "o", repo: "r", runId: "9", jobId: "1" }), {
    ...GITHUB_COMMON_FIELDS,
    ...repoFields,
    runId: "9",
    jobId: "1",
  });
  assert.deepEqual(contextFields({ kind: "runner", scope: "repo", org: "o", repo: "r", runnerId: "5" }), {
    ...GITHUB_COMMON_FIELDS,
    ...repoFields,
    runnerName: "5",
  });
  assert.deepEqual(contextFields({ kind: "runner", scope: "org", org: "o", runnerId: "5" }), {
    ...GITHUB_COMMON_FIELDS,
    org: "o",
    runnerName: "5",
  });
  assert.deepEqual(contextFields({ kind: "runnerGroup", org: "o", groupId: "3" }), {
    ...GITHUB_COMMON_FIELDS,
    org: "o",
    runnerGroupName: "3",
  });
});

test("rowFieldKey names the per-row field on list pages only", () => {
  assert.equal(rowFieldKey("prList"), "prNumber");
  assert.equal(rowFieldKey("branchList"), "branch");
  assert.equal(rowFieldKey("pr"), null);
  assert.equal(rowFieldKey("run"), null);
  assert.equal(isListPageKind("prList"), true);
  assert.equal(isListPageKind("branchList"), true);
  assert.equal(isListPageKind("pr"), false);
});

test("availableFieldKeys adds the per-row field on a list page", () => {
  assert.deepEqual(availableFieldKeys({ kind: "prList", org: "o", repo: "r" }), [
    "repo",
    "org",
    "repoFullName",
    "prNumber",
    "serverUrl",
    "apiUrl",
  ]);
  assert.deepEqual(availableFieldKeys({ kind: "branchList", org: "o", repo: "r" }), [
    "repo",
    "org",
    "repoFullName",
    "branch",
    "serverUrl",
    "apiUrl",
  ]);
  // The repo home page provides the same fields minus any per-row one.
  assert.deepEqual(availableFieldKeys({ kind: "repoHome", org: "o", repo: "r" }), [
    "repo",
    "org",
    "repoFullName",
    "serverUrl",
    "apiUrl",
  ]);
});

test("sampleContext returns a context of the requested kind for every page kind", () => {
  for (const page of JUMP_PAGE_KINDS) {
    assert.equal(sampleContext(page).kind, page);
  }
});

test("placeholderFields reads {{placeholder}} references, ignoring unknown ones", () => {
  assert.deepEqual(placeholderFields("https://x.example.com/{{repoFullName}}/{{prNumber}}"), [
    "repoFullName",
    "prNumber",
  ]);
  assert.deepEqual(placeholderFields("https://x.example.com/{{notARealField}}"), []);
  assert.deepEqual(placeholderFields("https://x.example.com/fixed"), []);
});

test("renderTemplate substitutes known {{fieldKey}} placeholders and leaves unknown ones untouched", () => {
  assert.equal(
    renderTemplate("https://g.example.com/d/x?var-run={{runId}}&var-job={{jobId}}", {
      runId: "9",
      jobId: "1",
    }),
    "https://g.example.com/d/x?var-run=9&var-job=1",
  );
  assert.equal(renderTemplate("https://x.example.com/{{bogus}}", { runId: "9" }), "https://x.example.com/{{bogus}}");
  assert.equal(renderTemplate("https://x.example.com/{{runId}}", {}), "https://x.example.com/{{runId}}");
});

// ---------------------------------------------------------------------------
// Config shape
// ---------------------------------------------------------------------------

test("defaultConfig starts empty and unconfigured", () => {
  assert.deepEqual(defaultConfig(), { pages: [] });
  assert.equal(isConfigured(defaultConfig()), false);
});

test("isConfigured is true once any page has a link", () => {
  assert.equal(isConfigured({ pages: [] }), false);
  assert.equal(
    isConfigured({ pages: [{ page: "pr", links: [{ name: "x", url: "https://x.example.com" }] }] }),
    true,
  );
});

test("isJumpPageKind accepts declared page kinds only", () => {
  assert.equal(isJumpPageKind("pr"), true);
  assert.equal(isJumpPageKind("branchList"), true);
  assert.equal(isJumpPageKind("dashboard"), false);
  assert.equal(isJumpPageKind(""), false);
});

test("normalizeConfig drops malformed input and defaults to empty", () => {
  for (const raw of [null, undefined, "not an object", {}, { pages: "nope" }]) {
    assert.deepEqual(normalizeConfig(raw), { pages: [] });
  }
});

test("normalizeConfig trims values and drops links with no URL", () => {
  assert.deepEqual(
    normalizeConfig({
      pages: [
        {
          page: "  pr  ",
          links: [
            { name: "  CI dashboard  ", url: "  https://g.example.com/{{prNumber}}  " },
            { name: "no url", url: "   " },
            { name: "not even a url field" },
            "not an object",
            null,
          ],
        },
      ],
    }),
    {
      pages: [{ page: "pr", links: [{ name: "CI dashboard", url: "https://g.example.com/{{prNumber}}" }] }],
    },
  );
});

test("normalizeConfig collapses a newline inside a URL, since the config format has no multi-line scalars", () => {
  assert.deepEqual(
    normalizeConfig({
      pages: [{ page: "pr", links: [{ name: "x", url: "https://x.example.com/a\n  ?b=c" }] }],
    }).pages[0].links[0].url,
    "https://x.example.com/a ?b=c",
  );
});

test("normalizeConfig keeps a link with a blank name, filling it in at display time", () => {
  const config = normalizeConfig({
    pages: [{ page: "pr", links: [{ url: "https://x.example.com/a" }] }],
  });
  assert.deepEqual(config.pages[0].links, [{ name: "", url: "https://x.example.com/a" }]);
  assert.equal(linkDisplayName(config.pages[0].links[0]), "https://x.example.com/a");
  assert.equal(linkDisplayName({ name: "Named", url: "https://x.example.com/a" }), "Named");
});

test("normalizeConfig drops unknown page names and pages with no usable links", () => {
  assert.deepEqual(
    normalizeConfig({
      pages: [
        { page: "notAPage", links: [{ name: "x", url: "https://x.example.com" }] },
        { page: "pr", links: [] },
        { page: "run", links: [{ name: "y", url: "" }] },
      ],
    }),
    { pages: [] },
  );
});

test("normalizeConfig merges two entries naming the same page and emits pages in canonical order", () => {
  const result = normalizeConfig({
    pages: [
      { page: "run", links: [{ name: "run link", url: "https://x.example.com/{{runId}}" }] },
      { page: "pr", links: [{ name: "pr link 1", url: "https://x.example.com/1" }] },
      { page: "pr", links: [{ name: "pr link 2", url: "https://x.example.com/2" }] },
    ],
  });
  assert.deepEqual(
    result.pages.map((entry) => entry.page),
    ["pr", "run"],
  );
  assert.deepEqual(
    result.pages[0].links.map((link) => link.name),
    ["pr link 1", "pr link 2"],
  );
});

test("linksForPage returns a page's links, or nothing for a page with none", () => {
  const config = { pages: [{ page: "pr", links: [{ name: "x", url: "https://x.example.com" }] }] };
  assert.deepEqual(linksForPage(config, "pr"), config.pages[0].links);
  assert.deepEqual(linksForPage(config, "run"), []);
});

// ---------------------------------------------------------------------------
// Which links show where
// ---------------------------------------------------------------------------

const MULTI_PAGE_CONFIG = {
  pages: [
    {
      page: "pr",
      links: [
        { name: "pr ci", url: "https://g.example.com/d/x?var-pr={{prNumber}}" },
        { name: "repo runbook", url: "https://runbooks.example.com/{{repoFullName}}" },
        { name: "fixed", url: "https://wiki.example.com/ci" },
        { name: "needs a job", url: "https://g.example.com/d/x?var-job={{jobId}}" },
      ],
    },
    {
      page: "run",
      links: [{ name: "run trace", url: "https://g.example.com/explore?q={{runId}}" }],
    },
    {
      page: "prList",
      links: [{ name: "row ci", url: "https://g.example.com/d/x?var-pr={{prNumber}}" }],
    },
  ],
};

test("applicableLinks only offers links configured for the current page", () => {
  const prContext = { kind: "pr", org: "o", repo: "r", prNumber: "42" };
  assert.deepEqual(
    applicableLinks(MULTI_PAGE_CONFIG, prContext).map((link) => link.name),
    // "needs a job" is dropped: a PR page has no jobId to fill in.
    ["pr ci", "repo runbook", "fixed"],
  );

  const runContext = { kind: "run", org: "o", repo: "r", runId: "9" };
  assert.deepEqual(
    applicableLinks(MULTI_PAGE_CONFIG, runContext).map((link) => link.name),
    ["run trace"],
  );

  // A page with nothing configured for it shows nothing, even though the repo
  // fields its links use are available there.
  const repoHomeContext = { kind: "repoHome", org: "o", repo: "r" };
  assert.deepEqual(applicableLinks(MULTI_PAGE_CONFIG, repoHomeContext), []);
});

test("applicableLinks lets a list page's link use the field its rows provide", () => {
  const prListContext = { kind: "prList", org: "o", repo: "r" };
  assert.deepEqual(
    applicableLinks(MULTI_PAGE_CONFIG, prListContext).map((link) => link.name),
    ["row ci"],
  );
});

test("applicableLinks drops a link using a field its own page never provides", () => {
  const config = {
    pages: [{ page: "run", links: [{ name: "branchy", url: "https://x.example.com/{{branch}}" }] }],
  };
  assert.deepEqual(applicableLinks(config, { kind: "run", org: "o", repo: "r", runId: "9" }), []);
});

test("repoContextForJump extracts {org, repo} for repo-scoped contexts", () => {
  const repoScoped = [
    { kind: "repoHome", org: "o", repo: "r" },
    { kind: "repoFile", org: "o", repo: "r", branch: "main" },
    { kind: "pr", org: "o", repo: "r", prNumber: "1" },
    { kind: "prList", org: "o", repo: "r" },
    { kind: "branchList", org: "o", repo: "r" },
    { kind: "actionsList", org: "o", repo: "r" },
    { kind: "branch", org: "o", repo: "r", branch: "main" },
    { kind: "workflow", org: "o", repo: "r", workflowFile: "ci.yml" },
    { kind: "run", org: "o", repo: "r", runId: "9" },
    { kind: "job", org: "o", repo: "r", runId: "9", jobId: "1" },
    { kind: "runner", scope: "repo", org: "o", repo: "r", runnerId: "9" },
  ];
  for (const context of repoScoped) {
    assert.deepEqual(repoContextForJump(context), { org: "o", repo: "r" }, `for ${context.kind}`);
  }
});

test("repoContextForJump returns null for org-scoped runner and runnerGroup contexts", () => {
  assert.equal(repoContextForJump({ kind: "runner", scope: "org", org: "o", runnerId: "9" }), null);
  assert.equal(repoContextForJump({ kind: "runnerGroup", org: "o", groupId: "3" }), null);
});

test("activeLinks prefers the personal config outright when it has anything applicable", () => {
  const personal = { pages: [{ page: "pr", links: [{ name: "mine", url: "https://mine.example.com" }] }] };
  const repo = { pages: [{ page: "pr", links: [{ name: "theirs", url: "https://theirs.example.com" }] }] };
  const context = { kind: "pr", org: "o", repo: "r", prNumber: "1" };
  assert.deepEqual(activeLinks(personal, repo, context), personal.pages[0].links);
});

test("activeLinks falls back to the repo config per page, not per config", () => {
  const personal = { pages: [{ page: "run", links: [{ name: "mine", url: "https://mine.example.com" }] }] };
  const repo = { pages: [{ page: "pr", links: [{ name: "theirs", url: "https://theirs.example.com" }] }] };
  // Personal has links, just none for this page - the repo config still fills in.
  assert.deepEqual(
    activeLinks(personal, repo, { kind: "pr", org: "o", repo: "r", prNumber: "1" }),
    repo.pages[0].links,
  );
});

test("activeLinks returns nothing when neither config has anything for the page", () => {
  assert.deepEqual(activeLinks(defaultConfig(), null, { kind: "pr", org: "o", repo: "r", prNumber: "1" }), []);
});

test("mergeConfigsForExport unions per page, deduped by URL, preferring the repo's copy", () => {
  const repo = {
    pages: [
      {
        page: "pr",
        links: [
          { name: "repo only", url: "https://repo.example.com/only" },
          { name: "shared (repo wording)", url: "https://shared.example.com" },
        ],
      },
    ],
  };
  const personal = {
    pages: [
      {
        page: "pr",
        links: [
          { name: "shared (personal wording)", url: "https://shared.example.com" },
          { name: "personal only", url: "https://personal.example.com/only" },
        ],
      },
      { page: "run", links: [{ name: "run link", url: "https://personal.example.com/run" }] },
    ],
  };
  assert.deepEqual(mergeConfigsForExport(repo, personal), {
    pages: [
      {
        page: "pr",
        links: [
          { name: "repo only", url: "https://repo.example.com/only" },
          { name: "shared (repo wording)", url: "https://shared.example.com" },
          { name: "personal only", url: "https://personal.example.com/only" },
        ],
      },
      { page: "run", links: [{ name: "run link", url: "https://personal.example.com/run" }] },
    ],
  });
});

test("mergeConfigsForExport returns the personal config alone when there is no repo config", () => {
  const personal = { pages: [{ page: "pr", links: [{ name: "mine", url: "https://mine.example.com" }] }] };
  assert.deepEqual(mergeConfigsForExport(null, personal), personal);
});

// ---------------------------------------------------------------------------
// YAML-lite round trip
// ---------------------------------------------------------------------------

test("parseYamlLite reads a page-keyed config with links nested one level deeper", () => {
  const text = [
    "# a leading comment, and a blank line below",
    "",
    "pages:",
    "  - page: pr",
    "    links:",
    "      - name: CI dashboard",
    "        url: https://g.example.com/d/x",
    "      - name: Runbook",
    "        url: https://runbooks.example.com",
    "  - page: run",
    "    links:",
    "      - name: Run trace",
    "        url: https://g.example.com/explore",
  ].join("\n");

  assert.deepEqual(parseYamlLite(text), {
    pages: [
      {
        page: "pr",
        links: [
          { name: "CI dashboard", url: "https://g.example.com/d/x" },
          { name: "Runbook", url: "https://runbooks.example.com" },
        ],
      },
      { page: "run", links: [{ name: "Run trace", url: "https://g.example.com/explore" }] },
    ],
  });
});

test("parseYamlLite reads a sequence written at the same indent as its own key", () => {
  const text = [
    "pages:",
    "- page: pr",
    "  links:",
    "  - name: CI dashboard",
    "    url: https://g.example.com/d/x",
  ].join("\n");

  assert.deepEqual(parseYamlLite(text), {
    pages: [{ page: "pr", links: [{ name: "CI dashboard", url: "https://g.example.com/d/x" }] }],
  });
});

test("parseYamlLite unquotes single- and double-quoted scalars", () => {
  assert.deepEqual(parseYamlLite(['name: "quoted value"', "url: 'also quoted'"].join("\n")), {
    name: "quoted value",
    url: "also quoted",
  });
});

test("parseYamlLite unescapes backslash-escaped quotes/backslashes inside a double-quoted scalar", () => {
  assert.deepEqual(parseYamlLite('url: "{a=\\"b\\"} \\\\ done"'), { url: '{a="b"} \\ done' });
});

test("configToYamlLite serializes an empty config as an empty list", () => {
  assert.equal(configToYamlLite(defaultConfig()), "pages: []\n");
  assert.deepEqual(normalizeConfig(parseYamlLite("pages: []\n")), defaultConfig());
});

test("parseYamlLite round-trips through configToYamlLite", () => {
  const config = {
    pages: [
      {
        page: "pr",
        links: [
          { name: "CI Overview", url: "https://g.example.com/d/abc123/ci?var-pr={{prNumber}}" },
          { name: "", url: "https://runbooks.example.com/{{repoFullName}}" },
        ],
      },
      {
        page: "job",
        links: [{ name: "Job span", url: "https://g.example.com/explore?q=%7Bjob%3D{{jobId}}%7D" }],
      },
    ],
  };
  assert.deepEqual(normalizeConfig(parseYamlLite(configToYamlLite(config))), config);
});

test("configToYamlLite quotes scalars that would otherwise be misread", () => {
  const config = {
    pages: [{ page: "pr", links: [{ name: "- looks like a list item", url: "https://x.example.com" }] }],
  };
  const yaml = configToYamlLite(config);
  assert.match(yaml, /name: "- looks like a list item"/);
  assert.deepEqual(normalizeConfig(parseYamlLite(yaml)), config);
});

// ---------------------------------------------------------------------------
// Documentation that has to stay in step with the code
// ---------------------------------------------------------------------------

test("pageFieldsReference documents every page kind and its actual fields", () => {
  const lines = pageFieldsReference().split("\n");
  assert.equal(lines.length, JUMP_PAGE_KINDS.length);
  JUMP_PAGE_KINDS.forEach((page, index) => {
    const expected = `#     ${page}: ${availableFieldKeys(sampleContext(page)).join(", ")}`;
    assert.equal(lines[index], expected);
  });
});

test("the repo config template parses into a usable config", () => {
  const config = normalizeConfig(parseYamlLite(REPO_CONFIG_TEMPLATE));
  assert.ok(config.pages.length > 0, "template should define at least one page");
  for (const entry of config.pages) {
    assert.equal(isJumpPageKind(entry.page), true);
    assert.ok(entry.links.length > 0);
    // Every example link must actually show up on the page it's filed under.
    assert.deepEqual(applicableLinks(config, sampleContext(entry.page)), entry.links);
  }
});

test("this repo's own checked-in jump-links config parses into a usable config", () => {
  // Guards the documented example against drifting out of the format the
  // parser actually reads - it's the one config file in this repo that a real
  // contributor's browser will fetch.
  const configPath = path.join(__dirname, "..", "..", "..", ".github", "jump-links.config.yaml");
  const config = normalizeConfig(parseYamlLite(fs.readFileSync(configPath, "utf8")));
  assert.ok(config.pages.length > 0, "checked-in config should define at least one page");
  for (const entry of config.pages) {
    assert.deepEqual(applicableLinks(config, sampleContext(entry.page)), entry.links);
  }
  assert.match(
    fs.readFileSync(configPath, "utf8"),
    new RegExp(pageFieldsReference().split("\n")[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    "checked-in config's header comment should carry the generated page/field reference",
  );
});

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

test("isVersionUpdate is true only when a non-empty previous version differs from the current one", () => {
  assert.equal(isVersionUpdate("0.2.3", "0.2.4"), true);
  assert.equal(isVersionUpdate("0.2.4", "0.2.4"), false);
  assert.equal(isVersionUpdate("", "0.2.4"), false, "empty previous means first-ever run, not an update");
});

test("buildCreateFileUrl builds a GitHub create-file link with filename and value query params", () => {
  const url = buildCreateFileUrl("o", "r", "main", ".github/jump-links.config.yaml", "pages: []\n");
  assert.equal(
    url,
    "https://github.com/o/r/new/main?filename=.github%2Fjump-links.config.yaml&value=pages%3A+%5B%5D%0A",
  );
});
