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

const {
  parseRepoHomeContext,
  parseRepoFileContext,
  parseRepoTreeRootContext,
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
  repoConfigCacheKey,
  repoConfigUrl,
  fetchRepoConfigForTarget,
  branchFromTreeHref,
  refNameFromRefSelectorLabel,
  refNameFromEmbeddedData,
  refMatchesBlobPath,
  refMatchesTreeRootPath,
  mayBeUnresolvedTreeRoot,
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
  assert.deepEqual(parseRepoHomeContext("/some-org/some-repo"), {
    kind: "repoHome",
    org: "some-org",
    repo: "some-repo",
  });
  assert.deepEqual(parseRepoHomeContext("/some-org/some-repo/"), {
    kind: "repoHome",
    org: "some-org",
    repo: "some-repo",
  });
});

test("parseRepoHomeContext does not match deeper paths or GitHub's own global pages", () => {
  assert.equal(parseRepoHomeContext("/some-org/some-repo/pulls"), null);
  assert.equal(parseRepoHomeContext("/some-org"), null);
  assert.equal(parseRepoHomeContext("/organizations/some-org"), null);
  assert.equal(parseRepoHomeContext("/settings/profile"), null);
  assert.equal(parseRepoHomeContext("/notifications/subscriptions"), null);
});

test("parseRepoFileContext matches a file at a ref and decodes the ref", () => {
  assert.deepEqual(parseRepoFileContext("/some-org/some-repo/blob/main/README.md"), {
    kind: "repoFile",
    org: "some-org",
    repo: "some-repo",
    branch: "main",
  });
  assert.deepEqual(parseRepoFileContext("/some-org/some-repo/blob/my%2Fbranch/src/index.ts"), {
    kind: "repoFile",
    org: "some-org",
    repo: "some-repo",
    branch: "my/branch",
  });
});

test("parseRepoFileContext does not match a directory view or a bare ref", () => {
  assert.equal(parseRepoFileContext("/some-org/some-repo/tree/main/src"), null);
  assert.equal(parseRepoFileContext("/some-org/some-repo/blob/main"), null);
});

test("parseRepoTreeRootContext reads the repo root at a ref as its home page", () => {
  assert.deepEqual(parseRepoTreeRootContext("/some-org/some-repo/tree/main"), {
    kind: "repoHome",
    org: "some-org",
    repo: "some-repo",
    branch: "main",
  });
  assert.deepEqual(parseRepoTreeRootContext("/some-org/some-repo/tree/main/"), {
    kind: "repoHome",
    org: "some-org",
    repo: "some-repo",
    branch: "main",
  });
  assert.deepEqual(parseRepoTreeRootContext("/some-org/some-repo/tree/renovate%2Fall-patch"), {
    kind: "repoHome",
    org: "some-org",
    repo: "some-repo",
    branch: "renovate/all-patch",
  });
});

test("parseRepoTreeRootContext leaves an ambiguous multi-segment tree URL alone", () => {
  // "/tree/renovate/all-patch" is equally the root at ref "renovate/all-patch"
  // or directory "all-patch" at ref "renovate"; only the ref in the page's own
  // DOM settles it, so nothing is matched from the URL alone here.
  assert.equal(parseRepoTreeRootContext("/some-org/some-repo/tree/renovate/all-patch"), null);
  assert.equal(parseRepoTreeRootContext("/some-org/some-repo/tree/main/packages"), null);
  assert.equal(parseRepoTreeRootContext("/some-org/some-repo/tree"), null);
  assert.equal(parseRepoTreeRootContext("/some-org/some-repo"), null);
});

test("parsePrContext matches the PR checks tab and other PR sub-tabs", () => {
  for (const pathname of [
    "/some-org/some-repo/pull/42",
    "/some-org/some-repo/pull/42/checks",
    "/some-org/some-repo/pull/42/files",
  ]) {
    assert.deepEqual(parsePrContext(pathname), {
      kind: "pr",
      org: "some-org",
      repo: "some-repo",
      prNumber: "42",
    });
  }
});

test("parsePrContext does not match non-PR paths", () => {
  assert.equal(parsePrContext("/some-org/some-repo/pulls"), null);
  assert.equal(parsePrContext("/some-org/some-repo/issues/42"), null);
  assert.equal(parsePrContext("/some-org/some-repo/actions"), null);
});

test("parsePrListContext matches the repo's PR list", () => {
  assert.deepEqual(parsePrListContext("/some-org/some-repo/pulls"), {
    kind: "prList",
    org: "some-org",
    repo: "some-repo",
  });
  assert.deepEqual(parsePrListContext("/some-org/some-repo/pulls/"), {
    kind: "prList",
    org: "some-org",
    repo: "some-repo",
  });
  assert.equal(parsePrListContext("/some-org/some-repo/pull/42"), null);
});

test("parseBranchListContext matches the branch list and its sub-tabs", () => {
  const expected = { kind: "branchList", org: "some-org", repo: "some-repo" };
  assert.deepEqual(parseBranchListContext("/some-org/some-repo/branches"), expected);
  assert.deepEqual(parseBranchListContext("/some-org/some-repo/branches/all"), expected);
  assert.deepEqual(parseBranchListContext("/some-org/some-repo/branches/yours"), expected);
  assert.equal(parseBranchListContext("/some-org/some-repo/branch_commits/abc"), null);
});

test("extractBranchFromQuery reads bare and quoted branch filters", () => {
  assert.equal(extractBranchFromQuery("branch:main"), "main");
  assert.equal(extractBranchFromQuery("is:success branch:main"), "main");
  assert.equal(extractBranchFromQuery('branch:"feature/some branch"'), "feature/some branch");
  assert.equal(extractBranchFromQuery("is:success"), null);
});

test("parseBranchContext matches the repo Actions tab filtered by branch", () => {
  assert.deepEqual(parseBranchContext("/some-org/some-repo/actions", "?query=branch%3Amy-feature"), {
    kind: "branch",
    org: "some-org",
    repo: "some-repo",
    branch: "my-feature",
  });
  assert.deepEqual(parseBranchContext("/some-org/some-repo/actions/", "?query=is%3Asuccess+branch%3Amain"), {
    kind: "branch",
    org: "some-org",
    repo: "some-repo",
    branch: "main",
  });
});

test("parseBranchContext returns null without a branch filter or off the bare Actions tab", () => {
  assert.equal(parseBranchContext("/some-org/some-repo/actions", ""), null);
  assert.equal(parseBranchContext("/some-org/some-repo/actions", "?query=is%3Asuccess"), null);
  assert.equal(parseBranchContext("/some-org/some-repo/actions/workflows/ci.yml", "?query=branch%3Amain"), null);
});

test("parseActionsListContext matches the repo Actions tab", () => {
  assert.deepEqual(parseActionsListContext("/some-org/some-repo/actions"), {
    kind: "actionsList",
    org: "some-org",
    repo: "some-repo",
  });
  assert.equal(parseActionsListContext("/some-org/some-repo/actions/workflows/ci.yml"), null);
});

test("parseRunnerContext matches repo-scoped and org-scoped runner pages", () => {
  assert.deepEqual(parseRunnerContext("/some-org/some-repo/settings/actions/runners/17"), {
    kind: "runner",
    scope: "repo",
    org: "some-org",
    repo: "some-repo",
    runnerId: "17",
  });
  assert.deepEqual(parseRunnerContext("/organizations/some-org/settings/actions/runners/17"), {
    kind: "runner",
    scope: "org",
    org: "some-org",
    runnerId: "17",
  });
});

test("parseRunnerContext returns null off a runner detail page", () => {
  assert.equal(parseRunnerContext("/some-org/some-repo/settings/actions"), null);
  assert.equal(parseRunnerContext("/organizations/some-org/settings/actions/runner-groups/1"), null);
});

test("parseRunnerGroupContext matches an org's runner group detail page", () => {
  assert.deepEqual(parseRunnerGroupContext("/organizations/some-org/settings/actions/runner-groups/3"), {
    kind: "runnerGroup",
    org: "some-org",
    groupId: "3",
  });
  assert.equal(parseRunnerGroupContext("/organizations/some-org/settings/actions/runners/3"), null);
});

test("parseWorkflowContext matches a workflow's own page", () => {
  assert.deepEqual(parseWorkflowContext("/some-org/some-repo/actions/workflows/ci.yml"), {
    kind: "workflow",
    org: "some-org",
    repo: "some-repo",
    workflowFile: "ci.yml",
  });
  assert.equal(parseWorkflowContext("/some-org/some-repo/actions"), null);
});

test("parseRunContext distinguishes a run's own page from one job within it", () => {
  assert.deepEqual(parseRunContext("/some-org/some-repo/actions/runs/123456"), {
    kind: "run",
    org: "some-org",
    repo: "some-repo",
    runId: "123456",
  });
  assert.deepEqual(parseRunContext("/some-org/some-repo/actions/runs/123456/job/789"), {
    kind: "job",
    org: "some-org",
    repo: "some-repo",
    runId: "123456",
    jobId: "789",
  });
  assert.equal(parseRunContext("/some-org/some-repo/actions/workflows/ci.yml"), null);
});

test("resolveJumpContext dispatches to the right parser for each supported URL shape", () => {
  const cases = [
    ["/some-org/some-repo", "", { kind: "repoHome", org: "some-org", repo: "some-repo" }],
    [
      "/some-org/some-repo/blob/main/README.md",
      "",
      { kind: "repoFile", org: "some-org", repo: "some-repo", branch: "main" },
    ],
    [
      "/some-org/some-repo/tree/main",
      "",
      { kind: "repoHome", org: "some-org", repo: "some-repo", branch: "main" },
    ],
    ["/some-org/some-repo/pull/42", "", { kind: "pr", org: "some-org", repo: "some-repo", prNumber: "42" }],
    ["/some-org/some-repo/pulls", "", { kind: "prList", org: "some-org", repo: "some-repo" }],
    ["/some-org/some-repo/branches", "", { kind: "branchList", org: "some-org", repo: "some-repo" }],
    ["/some-org/some-repo/actions", "", { kind: "actionsList", org: "some-org", repo: "some-repo" }],
    [
      "/some-org/some-repo/actions",
      "?query=branch%3Amain",
      { kind: "branch", org: "some-org", repo: "some-repo", branch: "main" },
    ],
    [
      "/some-org/some-repo/actions/workflows/ci.yml",
      "",
      { kind: "workflow", org: "some-org", repo: "some-repo", workflowFile: "ci.yml" },
    ],
    ["/some-org/some-repo/actions/runs/9", "", { kind: "run", org: "some-org", repo: "some-repo", runId: "9" }],
    [
      "/some-org/some-repo/actions/runs/9/job/1",
      "",
      { kind: "job", org: "some-org", repo: "some-repo", runId: "9", jobId: "1" },
    ],
    [
      "/organizations/some-org/settings/actions/runners/9",
      "",
      { kind: "runner", scope: "org", org: "some-org", runnerId: "9" },
    ],
    [
      "/organizations/some-org/settings/actions/runner-groups/2",
      "",
      { kind: "runnerGroup", org: "some-org", groupId: "2" },
    ],
  ];
  for (const [pathname, search, expected] of cases) {
    assert.deepEqual(resolveJumpContext(pathname, search), expected, `for ${pathname}${search}`);
  }
});

test("resolveJumpContext returns null for pages with no jump context", () => {
  assert.equal(resolveJumpContext("/some-org/some-repo/issues/1", ""), null);
  // A directory below the repo root is a different page with a different header,
  // and stays unmatched however deep it goes.
  assert.equal(resolveJumpContext("/some-org/some-repo/tree/main/src", ""), null);
  assert.equal(resolveJumpContext("/some-org/some-repo/tree/main/packages/some-package", ""), null);
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
    repoHome: ["/some-org/some-repo", ""],
    repoFile: ["/some-org/some-repo/blob/main/README.md", ""],
    pr: ["/some-org/some-repo/pull/42", ""],
    prList: ["/some-org/some-repo/pulls", ""],
    branchList: ["/some-org/some-repo/branches", ""],
    actionsList: ["/some-org/some-repo/actions", ""],
    branch: ["/some-org/some-repo/actions", "?query=branch%3Amain"],
    workflow: ["/some-org/some-repo/actions/workflows/ci.yml", ""],
    run: ["/some-org/some-repo/actions/runs/9", ""],
    job: ["/some-org/some-repo/actions/runs/9/job/1", ""],
    runner: ["/some-org/some-repo/settings/actions/runners/1", ""],
    runnerGroup: ["/organizations/some-org/settings/actions/runner-groups/1", ""],
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
    { kind: "pr", org: "o", repo: "r", prNumber: "1" },
    { kind: "prList", org: "o", repo: "r" },
    { kind: "branchList", org: "o", repo: "r" },
    { kind: "actionsList", org: "o", repo: "r" },
    { kind: "workflow", org: "o", repo: "r", workflowFile: "ci.yml" },
    { kind: "run", org: "o", repo: "r", runId: "9" },
    { kind: "job", org: "o", repo: "r", runId: "9", jobId: "1" },
    { kind: "runner", scope: "repo", org: "o", repo: "r", runnerId: "9" },
  ];
  for (const context of repoScoped) {
    assert.deepEqual(repoContextForJump(context), { org: "o", repo: "r" }, `for ${context.kind}`);
  }
});

test("repoContextForJump carries the branch for the page kinds whose URL names a ref", () => {
  assert.deepEqual(repoContextForJump({ kind: "repoFile", org: "o", repo: "r", branch: "some/feature" }), {
    org: "o",
    repo: "r",
    branch: "some/feature",
  });
  assert.deepEqual(repoContextForJump({ kind: "branch", org: "o", repo: "r", branch: "main" }), {
    org: "o",
    repo: "r",
    branch: "main",
  });
  // The repo home page viewed at a ref reads that ref's config, so a config
  // change can be tried out from the branch's own tree view before it's merged.
  assert.deepEqual(repoContextForJump({ kind: "repoHome", org: "o", repo: "r", branch: "some/feature" }), {
    org: "o",
    repo: "r",
    branch: "some/feature",
  });
});

test("a repo home page at a ref reads its config from that ref", () => {
  const context = resolveJumpContext("/o/r/tree/some-feature", "");
  const target = repoContextForJump(context);
  assert.equal(repoConfigCacheKey(target.org, target.repo, target.branch), "o/r@some-feature");
  assert.equal(
    repoConfigUrl(target.org, target.repo, target.branch),
    "https://raw.githubusercontent.com/o/r/some-feature/.github/jump-links.config.yaml",
  );

  // ... while the plain repo home URL names no ref and keeps reading the default
  // branch, as a separate cache entry.
  const plain = repoContextForJump(resolveJumpContext("/o/r", ""));
  assert.equal(repoConfigCacheKey(plain.org, plain.repo, plain.branch), "o/r@HEAD");
});

test("repoContextForJump returns null for org-scoped runner and runnerGroup contexts", () => {
  assert.equal(repoContextForJump({ kind: "runner", scope: "org", org: "o", runnerId: "9" }), null);
  assert.equal(repoContextForJump({ kind: "runnerGroup", org: "o", groupId: "3" }), null);
});

test("repoConfigCacheKey keeps a branch's config separate from the default branch's", () => {
  assert.equal(repoConfigCacheKey("o", "r"), "o/r@HEAD");
  assert.equal(repoConfigCacheKey("o", "r", "some/feature"), "o/r@some/feature");
  assert.notEqual(repoConfigCacheKey("o", "r"), repoConfigCacheKey("o", "r", "main"));
});

test("repoConfigUrl reads the default branch when no branch is given", () => {
  assert.equal(
    repoConfigUrl("some-org", "some-repo"),
    "https://raw.githubusercontent.com/some-org/some-repo/HEAD/.github/jump-links.config.yaml",
  );
});

test("repoConfigUrl reads the given branch, keeping its slashes literal", () => {
  assert.equal(
    repoConfigUrl("some-org", "some-repo", "renovate/all-patch"),
    "https://raw.githubusercontent.com/some-org/some-repo/renovate/all-patch/.github/jump-links.config.yaml",
  );
});

test("repoConfigUrl escapes characters that would otherwise change the URL", () => {
  assert.equal(
    repoConfigUrl("some-org", "some-repo", "weird?branch#name"),
    "https://raw.githubusercontent.com/some-org/some-repo/weird%3Fbranch%23name/.github/jump-links.config.yaml",
  );
});

// ---------------------------------------------------------------------------
// Fetching a target's config. GM.xmlHttpRequest is stubbed per test (the real
// one only exists in a script manager), and each test uses a repo name of its
// own so the module-level response cache can't carry across tests.
// ---------------------------------------------------------------------------

/** Runs `body` with GM.xmlHttpRequest answering per `status(url)`, recording the URLs asked for. */
async function withStubbedFetch(status, body) {
  const requested = [];
  globalThis.GM = {
    xmlHttpRequest: ({ url, onload }) => {
      requested.push(url);
      onload({ status: status(url), responseText: "pages:\n  - page: pr\n    links:\n      - name: Dash\n        url: https://example.test/d\n" });
    },
  };
  try {
    return { result: await body(), requested };
  } finally {
    delete globalThis.GM;
  }
}

test("fetchRepoConfigForTarget falls back to the default branch when a PR's head branch has no config", async () => {
  const { result, requested } = await withStubbedFetch(
    (url) => (url.includes("/HEAD/") ? 200 : 404),
    () =>
      fetchRepoConfigForTarget({
        org: "o",
        repo: "pr-fallback",
        branch: "n8bot/deleted-after-merge",
        fallBackToDefaultBranch: true,
      }),
  );
  assert.deepEqual(linksForPage(result, "pr"), [{ name: "Dash", url: "https://example.test/d" }]);
  assert.deepEqual(requested, [
    repoConfigUrl("o", "pr-fallback", "n8bot/deleted-after-merge"),
    repoConfigUrl("o", "pr-fallback"),
  ]);
});

test("fetchRepoConfigForTarget stops at the head branch's own config when it has one", async () => {
  const { requested } = await withStubbedFetch(
    () => 200,
    () =>
      fetchRepoConfigForTarget({
        org: "o",
        repo: "pr-head-has-config",
        branch: "n8bot/jump-links-config",
        fallBackToDefaultBranch: true,
      }),
  );
  assert.deepEqual(requested, [repoConfigUrl("o", "pr-head-has-config", "n8bot/jump-links-config")]);
});

test("fetchRepoConfigForTarget doesn't fall back for a ref the URL itself names", async () => {
  const { result, requested } = await withStubbedFetch(
    (url) => (url.includes("/HEAD/") ? 200 : 404),
    () => fetchRepoConfigForTarget({ org: "o", repo: "blob-no-fallback", branch: "some/feature" }),
  );
  assert.equal(result, null);
  assert.deepEqual(requested, [repoConfigUrl("o", "blob-no-fallback", "some/feature")]);
});

test("branchFromTreeHref reads the branch out of a run header's branch link", () => {
  assert.equal(
    branchFromTreeHref("/nsheaps/greasemonkey-scripts/tree/refs/heads/renovate/all-patch", "nsheaps", "greasemonkey-scripts"),
    "renovate/all-patch",
  );
  // The same link's shorter, unqualified form.
  assert.equal(branchFromTreeHref("/o/r/tree/main", "o", "r"), "main");
  assert.equal(branchFromTreeHref("/o/r/tree/some%2Fbranch", "o", "r"), "some/branch");
});

test("branchFromTreeHref reads a PR header's head-branch link, slashes and all", () => {
  // Captured from the live PR header on jouzen/android#28338 and
  // nsheaps/greasemonkey-scripts#54: the head branch is one whole href, so a
  // slashed name needs none of the disambiguation a /blob/<ref>/<path> URL does.
  assert.equal(
    branchFromTreeHref("/jouzen/android/tree/n8bot/jump-links-config", "jouzen", "android"),
    "n8bot/jump-links-config",
  );
  assert.equal(
    branchFromTreeHref(
      "/nsheaps/greasemonkey-scripts/tree/n8bot/tree-view-repohome",
      "nsheaps",
      "greasemonkey-scripts",
    ),
    "n8bot/tree-view-repohome",
  );
});

test("branchFromTreeHref rejects a fork PR's head-branch link", () => {
  // Captured from cli/cli#14108, whose head branch lives in the contributor's
  // own fork (a differently-named repo at that) rather than in cli/cli.
  assert.equal(
    branchFromTreeHref("/loganrosen/cli-1/tree/loganrosen-fix-extension-saml-install", "cli", "cli"),
    null,
  );
});

test("branchFromTreeHref ignores an owner/repo casing difference", () => {
  assert.equal(branchFromTreeHref("/NSheaps/Some-Repo/tree/refs/heads/main", "nsheaps", "some-repo"), "main");
});

test("branchFromTreeHref rejects a href for a different repo, as a fork PR's head is", () => {
  assert.equal(branchFromTreeHref("/someone-else/r/tree/refs/heads/main", "o", "r"), null);
  assert.equal(branchFromTreeHref("/o/other-repo/tree/refs/heads/main", "o", "r"), null);
});

test("branchFromTreeHref rejects a ref that isn't a branch, and a href that isn't a tree link", () => {
  assert.equal(branchFromTreeHref("/o/r/tree/refs/tags/v1.0.0", "o", "r"), null);
  assert.equal(branchFromTreeHref("/o/r/tree/refs/heads/", "o", "r"), null);
  assert.equal(branchFromTreeHref("/o/r/blob/main/README.md", "o", "r"), null);
  assert.equal(branchFromTreeHref("/o/r/tree/", "o", "r"), null);
});

// ---------------------------------------------------------------------------
// Reading a file view's real ref out of its DOM (see scrapeBlobRef in src).
// The DOM lookups themselves aren't covered here - these are the pure pieces
// they're built out of, exercised on values captured from live github.com.
// ---------------------------------------------------------------------------

test("refNameFromRefSelectorLabel reads the full ref out of the ref picker's aria-label", () => {
  assert.equal(refNameFromRefSelectorLabel("main branch"), "main");
  assert.equal(
    refNameFromRefSelectorLabel("nate-ai/generic-grafana-jump branch"),
    "nate-ai/generic-grafana-jump",
  );
  assert.equal(refNameFromRefSelectorLabel("v1.0.0 tag"), "v1.0.0");
});

test("refNameFromRefSelectorLabel keeps a ref whose own name ends in the label's suffix", () => {
  assert.equal(refNameFromRefSelectorLabel("some branch branch"), "some branch");
});

test("refNameFromRefSelectorLabel rejects a label that isn't in that shape", () => {
  assert.equal(refNameFromRefSelectorLabel("main"), null);
  assert.equal(refNameFromRefSelectorLabel(" branch"), null);
  assert.equal(refNameFromRefSelectorLabel(""), null);
});

test("refNameFromEmbeddedData reads the ref out of the file view's embedded payload", () => {
  const payload = JSON.stringify({
    payload: {
      codeViewBlobLayoutRoute: {
        refInfo: { name: "nate-ai/generic-grafana-jump", refType: "branch", currentOid: "db2b479" },
      },
    },
  });
  assert.equal(refNameFromEmbeddedData(payload), "nate-ai/generic-grafana-jump");
});

test("refNameFromEmbeddedData decodes a ref name carrying JSON escapes", () => {
  assert.equal(refNameFromEmbeddedData('{"refInfo":{"name":"feature/caf\\u00e9","refType":"branch"}}'), "feature/café");
});

test("refNameFromEmbeddedData returns null when the payload has no refInfo", () => {
  assert.equal(refNameFromEmbeddedData('{"payload":{"repo":{"name":"r"}}}'), null);
  assert.equal(refNameFromEmbeddedData(""), null);
});

test("refMatchesBlobPath accepts a ref that spans several of the URL's path segments", () => {
  assert.equal(
    refMatchesBlobPath("/nsheaps/greasemonkey-scripts/blob/nate-ai/generic-grafana-jump/README.md", "nate-ai/generic-grafana-jump"),
    "nate-ai/generic-grafana-jump",
  );
  assert.equal(refMatchesBlobPath("/o/r/blob/main/README.md", "main"), "main");
  assert.equal(refMatchesBlobPath("/o/r/blob/main/src/deeply/nested.ts", "main"), "main");
});

test("refMatchesBlobPath compares against decoded path segments", () => {
  assert.equal(refMatchesBlobPath("/o/r/blob/my%20branch/README.md", "my branch"), "my branch");
  // A slashed ref can arrive percent-encoded inside a single segment rather than
  // as literal separators, so how many parts the ref's name has doesn't fix how
  // many segments of the URL it takes up - both readings have to be tried.
  assert.equal(refMatchesBlobPath("/o/r/blob/feature%2Fone/README.md", "feature/one"), "feature/one");
  assert.equal(refMatchesBlobPath("/o/r/blob/feature%2Fone/src/index.ts", "feature/one"), "feature/one");
  assert.equal(refMatchesBlobPath("/o/r/blob/feature/one/README.md", "feature/one"), "feature/one");
});

test("refMatchesBlobPath rejects a ref that isn't a leading run of the URL's segments", () => {
  // What a value gone stale during a soft navigation looks like: it describes
  // some other page, not the one on screen.
  assert.equal(refMatchesBlobPath("/o/r/blob/main/README.md", "some-other-branch"), null);
  assert.equal(refMatchesBlobPath("/o/r/blob/nate-ai/generic-grafana-jump/README.md", "nate-ai/something-else"), null);
  // A short commit SHA against the full one the URL carries.
  assert.equal(refMatchesBlobPath("/o/r/blob/db2b47905bd43b1fb58766bcf99a0725cc63e755/README.md", "db2b479"), null);
});

test("refMatchesBlobPath rejects a ref that would leave no file path behind it", () => {
  assert.equal(refMatchesBlobPath("/o/r/blob/main/README.md", "main/README.md"), null);
  assert.equal(refMatchesBlobPath("/o/r/blob/main/README.md", "main/README.md/extra"), null);
});

test("refMatchesBlobPath rejects a pathname that isn't a file view", () => {
  assert.equal(refMatchesBlobPath("/o/r/tree/main/src", "main"), null);
  assert.equal(refMatchesBlobPath("/o/r/blob/main", "main"), null);
  assert.equal(refMatchesBlobPath("/o/r", "main"), null);
});

test("refMatchesTreeRootPath accepts a ref that accounts for the whole tree path", () => {
  assert.equal(
    refMatchesTreeRootPath("/nsheaps/greasemonkey-scripts/tree/renovate/all-patch", "renovate/all-patch"),
    "renovate/all-patch",
  );
  assert.equal(refMatchesTreeRootPath("/o/r/tree/main", "main"), "main");
  assert.equal(refMatchesTreeRootPath("/o/r/tree/main/", "main"), "main");
});

test("refMatchesTreeRootPath compares against decoded path segments", () => {
  assert.equal(refMatchesTreeRootPath("/o/r/tree/my%20branch", "my branch"), "my branch");
  assert.equal(refMatchesTreeRootPath("/o/r/tree/feature%2Fone", "feature/one"), "feature/one");
  assert.equal(refMatchesTreeRootPath("/o/r/tree/feature/one", "feature/one"), "feature/one");
});

test("refMatchesTreeRootPath rejects a ref that leaves a directory path behind it", () => {
  // The page is then a directory below the repo root, which has no toolbar to
  // put links in - so this must not resolve to the repo home page.
  assert.equal(refMatchesTreeRootPath("/o/r/tree/main/packages", "main"), null);
  assert.equal(refMatchesTreeRootPath("/o/r/tree/renovate/all-patch/src", "renovate/all-patch"), null);
});

test("refMatchesTreeRootPath rejects a ref that isn't what the URL says at all", () => {
  assert.equal(refMatchesTreeRootPath("/o/r/tree/main", "some-other-branch"), null);
  // An abbreviated commit SHA in the ref picker against the full one in the URL.
  assert.equal(refMatchesTreeRootPath("/o/r/tree/db2b47905bd43b1fb58766bcf99a0725cc63e755", "db2b479"), null);
});

test("refMatchesTreeRootPath rejects a pathname that isn't a tree view", () => {
  assert.equal(refMatchesTreeRootPath("/o/r/blob/main/README.md", "main"), null);
  assert.equal(refMatchesTreeRootPath("/o/r/tree", "main"), null);
  assert.equal(refMatchesTreeRootPath("/o/r", "main"), null);
});

test("mayBeUnresolvedTreeRoot flags only the tree URLs the DOM still has to settle", () => {
  // Ambiguous: keep re-checking on DOM mutations until GitHub's header renders.
  assert.equal(mayBeUnresolvedTreeRoot("/o/r/tree/renovate/all-patch"), true);
  assert.equal(mayBeUnresolvedTreeRoot("/o/r/tree/main/packages"), true);
  // Already answered from the URL alone, or not a tree URL at all.
  assert.equal(mayBeUnresolvedTreeRoot("/o/r/tree/main"), false);
  assert.equal(mayBeUnresolvedTreeRoot("/o/r/tree/main/"), false);
  assert.equal(mayBeUnresolvedTreeRoot("/o/r"), false);
  assert.equal(mayBeUnresolvedTreeRoot("/o/r/blob/main/README.md"), false);
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

// A stand-in for the `.github/jump-links.config.yaml` a repo would check in:
// a header comment block (including the generated page/field reference the
// template ships with), then a few pages' worth of links using placeholders.
const CHECKED_IN_CONFIG_FIXTURE = [
  '# Config for the "GitHub jump links" userscript.',
  "#",
  "#   Page names, and the fields each one provides:",
  pageFieldsReference(),
  "",
  "pages:",
  "  - page: pr",
  "    links:",
  "      - name: CI dashboard",
  "        url: https://grafana.example.com/d/abc123/ci-overview?var-repo={{repoFullName}}&var-pr={{prNumber}}",
  "      - name: Runbook",
  "        url: https://runbooks.example.com/ci",
  "  - page: job",
  "    links:",
  "      - name: Job trace",
  '        url: https://grafana.example.com/explore?left=%7B%22query%22:%22%7Bjob_id%3D%5C%22{{jobId}}%5C%22%7D%22%7D',
  "  - page: repoHome",
  "    links:",
  "      - name: Service overview",
  "        url: https://grafana.example.com/d/def456/service?var-repo={{repoFullName}}",
].join("\n");

test("a repo config written the way the docs describe parses into a usable config", () => {
  // Guards the documented file format against drifting out of what the parser
  // actually reads - this is the shape of the file a real contributor's
  // browser fetches out of a repo's .github/ directory.
  const config = normalizeConfig(parseYamlLite(CHECKED_IN_CONFIG_FIXTURE));

  assert.deepEqual(
    config.pages.map((entry) => entry.page),
    // normalizeConfig puts the pages back in JUMP_PAGE_KINDS order, not the
    // order they happen to be written in the file.
    ["repoHome", "pr", "job"],
    "header comments and blank lines shouldn't leak into the parsed pages",
  );
  for (const entry of config.pages) {
    assert.equal(isJumpPageKind(entry.page), true);
    assert.ok(entry.links.length > 0);
    // Every link must actually show up on the page it's filed under, with all
    // of its placeholders filled in from that page's own fields.
    assert.deepEqual(applicableLinks(config, sampleContext(entry.page)), entry.links);
    for (const link of entry.links) {
      const url = renderTemplate(link.url, contextFields(sampleContext(entry.page)));
      assert.doesNotMatch(url, /\{\{\w+\}\}/, `${link.name} left a placeholder unfilled`);
    }
  }
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
