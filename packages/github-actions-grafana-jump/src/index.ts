// ==UserScript==
// @name        GitHub Actions => Grafana jump button
// @description Add a button on github.com Actions pages (PR checks, branch-filtered runs, a single workflow's runs, and runner detail pages) that jumps to the matching Grafana drill-down dashboard
// @match       http*://www.github.com/*
// @match       http*://github.com/*
// @version      0.1.0
// @run-at      document-start
// @icon         data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==
// @grant        none
// @license      MIT
// @namespace https://www.github.com
// ==/UserScript==
//
// NOTE: This script is internal to Oura's infrastructure (it links to an internal
// Grafana instance) and is intentionally NOT published to GreasyFork. Do not add
// @downloadURL/@updateURL or wire this package into the changeset/publish flow.

/**
 * Grafana jump-button configuration.
 *
 * `baseUrl` and the dashboard `uid`s below are REAL and confirmed: they come from
 * live links recorded in existing internal docs that catalog the "App Developers"
 * Grafana folder (ADX-89 research/planning notes), not guesses.
 *   - `ciDevxReport` ("CI/DevX report dashboard") is built on Tempo/TraceQL GitHub
 *     Actions workflow+job spans and has per-run PR CI runtime, so it's the best fit
 *     for drilling into one PR/branch or one workflow's runs across branches.
 *   - `androidIosCi` ("Android & iOS CI") covers runner health and queue time, so
 *     it's the best fit for a single runner's activity.
 *
 * `varNames` is NOT confirmed. Nobody has pulled the dashboard JSON to verify the
 * actual Grafana template-variable names these dashboards use for filtering by
 * branch / PR number / workflow / runner - the values below are reasonable-looking
 * placeholders only. The `var-` query-param prefix itself is a genuine, documented
 * Grafana URL convention (see https://grafana.com/docs/grafana/latest/dashboards/build-dashboards/create-dashboard-url-variables/);
 * what's unverified is just the variable *name* string for each of these three
 * dashboards. Confirm via the Grafana UI (dashboard settings -> Variables) or by
 * exporting the dashboard JSON (e.g. with the `gcx` CLI) and drop this comment +
 * the TODOs below once confirmed.
 */
const GRAFANA_CONFIG = {
  baseUrl: "https://monitoring.oura.cloud",
  dashboards: {
    ciDevxReport: { uid: "pagrf6j", slug: "ci-devx-report-dashboard" },
    androidIosCi: { uid: "pap5g6z", slug: "android-ios-ci" },
  },
  // TODO(nathan): confirm these against the live dashboards' actual template
  // variable names - these are placeholders, not verified.
  varNames: {
    branch: "branch",
    prNumber: "pr_number",
    workflowName: "workflow_name",
    runnerName: "runner_name",
  },
};

// ---------------------------------------------------------------------------
// Pure logic: parsing the current location into a jump context, and building
// the resulting Grafana URL. Kept free of DOM access so it can be unit tested
// directly (see test/grafana-jump.test.js).
// ---------------------------------------------------------------------------

interface PrContext {
  kind: "pr";
  org: string;
  repo: string;
  prNumber: string;
}

interface BranchContext {
  kind: "branch";
  org: string;
  repo: string;
  branch: string;
}

interface RunnerContext {
  kind: "runner";
  scope: "repo" | "org";
  org: string;
  runnerId: string;
}

interface WorkflowContext {
  kind: "workflow";
  org: string;
  repo: string;
  workflowFile: string;
}

type JumpContext = PrContext | BranchContext | RunnerContext | WorkflowContext;

/**
 * Matches a pull request's own pages (Conversation/Commits/Checks/Files changed),
 * e.g. `/org/repo/pull/123` or `/org/repo/pull/123/checks`. Any sub-tab counts:
 * they all show CI activity for the same PR/branch, which is what the Grafana
 * dashboard filters by.
 */
function parsePrContext(pathname: string): PrContext | null {
  const match = pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/.*)?$/);
  if (!match) return null;
  const [, org, repo, prNumber] = match;
  return { kind: "pr", org, repo, prNumber };
}

/**
 * Extracts a `branch:<name>` filter out of a GitHub Actions search query string,
 * e.g. `is:success branch:main` or `branch:"feature/some branch"`. Returns null if
 * no branch filter is present.
 */
function extractBranchFromQuery(query: string): string | null {
  const quotedMatch = query.match(/branch:"([^"]*)"/);
  if (quotedMatch) return quotedMatch[1];

  const bareMatch = query.match(/branch:(\S+)/);
  return bareMatch ? bareMatch[1] : null;
}

/**
 * Matches the repo Actions tab filtered down to a single branch via
 * `?query=branch:<name>`, e.g. `/org/repo/actions?query=branch:my-feature`.
 */
function parseBranchContext(pathname: string, search: string): BranchContext | null {
  const pathMatch = pathname.match(/^\/([^/]+)\/([^/]+)\/actions\/?$/);
  if (!pathMatch) return null;

  const params = new URLSearchParams(search);
  const query = params.get("query");
  if (!query) return null;

  const branch = extractBranchFromQuery(query);
  if (!branch) return null;

  const [, org, repo] = pathMatch;
  return { kind: "branch", org, repo, branch };
}

/**
 * Matches a self-hosted runner's detail page, at either the repo scope
 * (`/org/repo/settings/actions/runners/<id>`) or the org scope
 * (`/organizations/<org>/settings/actions/runners/<id>`).
 */
function parseRunnerContext(pathname: string): RunnerContext | null {
  // Checked first: "/organizations/<org>/settings/..." would otherwise also
  // satisfy the repo-scope pattern below (with "organizations" mistaken for an
  // org name), since both just look like "/<segment>/<segment>/settings/...".
  const orgMatch = pathname.match(/^\/organizations\/([^/]+)\/settings\/actions\/runners\/(\d+)/);
  if (orgMatch) {
    const [, org, runnerId] = orgMatch;
    return { kind: "runner", scope: "org", org, runnerId };
  }

  const repoMatch = pathname.match(/^\/([^/]+)\/[^/]+\/settings\/actions\/runners\/(\d+)/);
  if (repoMatch) {
    const [, org, runnerId] = repoMatch;
    return { kind: "runner", scope: "repo", org, runnerId };
  }

  return null;
}

/**
 * Matches a single workflow's own page, showing its runs across all branches,
 * e.g. `/org/repo/actions/workflows/ci.yml`.
 */
function parseWorkflowContext(pathname: string): WorkflowContext | null {
  const match = pathname.match(/^\/([^/]+)\/([^/]+)\/actions\/workflows\/([^/?#]+)/);
  if (!match) return null;
  const [, org, repo, workflowFile] = match;
  return { kind: "workflow", org, repo, workflowFile };
}

/**
 * Resolves the current location into whichever jump context applies (PR/branch,
 * runner, or workflow-across-branches), or null if none match. Order doesn't
 * matter for correctness here since the four path shapes are mutually
 * exclusive, but runner and workflow paths are checked first since they're the
 * most specific.
 */
function resolveJumpContext(pathname: string, search: string): JumpContext | null {
  return (
    parseRunnerContext(pathname) ??
    parseWorkflowContext(pathname) ??
    parsePrContext(pathname) ??
    parseBranchContext(pathname, search)
  );
}

/**
 * Builds a Grafana dashboard URL with one or more template variables preset via
 * the `var-<name>=<value>` query convention.
 */
function buildDashboardUrl(
  dashboard: { uid: string; slug: string },
  vars: Record<string, string>,
): string {
  const params = Object.entries(vars)
    .map(([name, value]) => `var-${encodeURIComponent(name)}=${encodeURIComponent(value)}`)
    .join("&");
  const query = params ? `?${params}` : "";
  return `${GRAFANA_CONFIG.baseUrl}/d/${dashboard.uid}/${dashboard.slug}${query}`;
}

/** Builds the Grafana jump URL for a resolved context. */
function buildGrafanaJumpUrl(context: JumpContext): string {
  switch (context.kind) {
    case "pr":
      return buildDashboardUrl(GRAFANA_CONFIG.dashboards.ciDevxReport, {
        [GRAFANA_CONFIG.varNames.prNumber]: context.prNumber,
      });
    case "branch":
      return buildDashboardUrl(GRAFANA_CONFIG.dashboards.ciDevxReport, {
        [GRAFANA_CONFIG.varNames.branch]: context.branch,
      });
    case "workflow":
      return buildDashboardUrl(GRAFANA_CONFIG.dashboards.ciDevxReport, {
        [GRAFANA_CONFIG.varNames.workflowName]: context.workflowFile,
      });
    case "runner":
      return buildDashboardUrl(GRAFANA_CONFIG.dashboards.androidIosCi, {
        [GRAFANA_CONFIG.varNames.runnerName]: context.runnerId,
      });
  }
}

/** Human-readable label for the jump button, specific to the matched context. */
function labelForContext(context: JumpContext): string {
  switch (context.kind) {
    case "pr":
      return `Grafana: PR #${context.prNumber} CI ↗️`;
    case "branch":
      return `Grafana: ${context.branch} CI ↗️`;
    case "workflow":
      return `Grafana: ${context.workflowFile} runs ↗️`;
    case "runner":
      return `Grafana: runner ${context.runnerId} ↗️`;
  }
}

// ---------------------------------------------------------------------------
// DOM injection.
//
// GitHub's Actions/PR pages are a pjax/React SPA, and (confirmed by inspecting
// the live DOM while building this script) the header/toolbar elements are
// styled with Primer React's hashed CSS-module class names (e.g.
// "prc-TabNav-TabNavTabList-Ave63"), which are not stable across GitHub
// front-end deploys and unsafe to hardcode as selectors. Rather than anchor to
// one of those per-page toolbars, this script shows a single fixed-position
// button that appears whenever the current URL matches a supported context and
// disappears otherwise - this only depends on `location`, not on any specific
// GitHub toolbar DOM shape, so it degrades gracefully (no button, no navigation
// left to fix) if GitHub reshuffles the page layout again.
// ---------------------------------------------------------------------------

const BUTTON_ID = "grafanaJumpButton";

function renderJumpButton(context: JumpContext | null): void {
  const existing = document.getElementById(BUTTON_ID) as HTMLAnchorElement | null;

  if (!context) {
    existing?.remove();
    return;
  }

  const href = buildGrafanaJumpUrl(context);
  const label = labelForContext(context);

  const anchorEl = existing ?? document.createElement("a");
  anchorEl.setAttribute("id", BUTTON_ID);
  anchorEl.setAttribute("href", href);
  anchorEl.setAttribute("target", "_blank");
  anchorEl.setAttribute(
    "style",
    "position: fixed; bottom: 16px; right: 16px; z-index: 2147483647; " +
      "background: #F55F0E; color: #fff; padding: 8px 12px; border-radius: 6px; " +
      "font-size: 12px; font-weight: 600; text-decoration: none; " +
      "box-shadow: 0 1px 4px rgba(0,0,0,0.3);",
  );
  anchorEl.textContent = label;

  if (!existing) {
    document.body.appendChild(anchorEl);
  }
}

let lastLocationKey: string | undefined;

function checkLocation(): void {
  const { pathname, search } = window.location;
  const locationKey = `${pathname}${search}`;
  if (locationKey === lastLocationKey) return;
  lastLocationKey = locationKey;

  renderJumpButton(resolveJumpContext(pathname, search));
}

// Guarded so that requiring the compiled output under Node (see the test-only
// export hook below) never touches DOM/browser globals - `document` always
// exists in the real userscript context, so this runs unconditionally there.
if (typeof document !== "undefined") {
  const routeChangeObserver = new MutationObserver(checkLocation);
  routeChangeObserver.observe(document.body, { childList: true, subtree: true });
  checkLocation();
}

// ---------------------------------------------------------------------------
// Test-only export hook. `module` is a variable Node's CommonJS loader injects
// into every required file's scope (e.g. when test/grafana-jump.test.js
// `require()`s the compiled dist/index.js) - it does not exist in a browser
// script context, so `typeof module !== "undefined"` is false there and this
// is a no-op, never risking a ReferenceError on github.com. The `NodeModule`
// type for `module` itself comes from @types/node, already pulled in
// transitively via @types/greasemonkey; no explicit `declare` needed here.
// ---------------------------------------------------------------------------
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
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
  };
}
