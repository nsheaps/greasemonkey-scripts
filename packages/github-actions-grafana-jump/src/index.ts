// The `// ==UserScript==` metadata block for this script lives in
// src/meta.json and is prepended to the compiled output by
// scripts/build-userscript.mjs. See that script for why it isn't inlined here.
//
// Fully generic: no Grafana instance, dashboard UID, or template-variable name is
// baked in. On first use (or whenever nothing configured applies to the current
// page) the jump button opens an in-page configuration panel where you enter your
// own Grafana base URL and one or more dashboards, each with the template-variable
// names it uses for filtering by branch / PR number / workflow file / runner. Once
// configured, the button jumps straight to the matching dashboard, with a small
// "▾" menu to pick among multiple configured dashboards or to reopen the config
// panel. Config is persisted via GM.setValue/GM.getValue, scoped to this script.
//
// The `var-<name>=<value>` query-param convention used to preset a Grafana
// dashboard's template variables from a URL is a genuine, documented Grafana
// feature (see
// https://grafana.com/docs/grafana/latest/dashboards/build-dashboards/create-dashboard-url-variables/);
// what's dashboard-specific is only the variable *name* each dashboard happens to
// use, which you can find in the Grafana UI (dashboard settings -> Variables) or
// by exporting the dashboard JSON (e.g. with the `gcx` CLI).

// ---------------------------------------------------------------------------
// Config types. A GrafanaJumpConfig is entirely user-supplied (see the config
// panel below) and persisted as-is; there is no shipped default.
// ---------------------------------------------------------------------------

interface DashboardVarNames {
  branch?: string;
  prNumber?: string;
  workflowName?: string;
  runnerName?: string;
}

interface DashboardConfig {
  name: string;
  uid: string;
  slug: string;
  varNames: DashboardVarNames;
}

interface GrafanaJumpConfig {
  baseUrl: string;
  dashboards: DashboardConfig[];
}

function defaultConfig(): GrafanaJumpConfig {
  return { baseUrl: "", dashboards: [] };
}

/**
 * Defensively reshapes a value loaded from storage (or pasted/hand-edited) into
 * a well-formed GrafanaJumpConfig, dropping anything malformed rather than
 * throwing. Keeps the rest of the script free of null/undefined-shape checks.
 */
function normalizeConfig(raw: unknown): GrafanaJumpConfig {
  if (typeof raw !== "object" || raw === null) return defaultConfig();
  const obj = raw as Record<string, unknown>;

  const baseUrl = typeof obj.baseUrl === "string" ? obj.baseUrl.trim() : "";

  const dashboardsRaw = Array.isArray(obj.dashboards) ? obj.dashboards : [];
  const dashboards: DashboardConfig[] = dashboardsRaw
    .filter((d): d is Record<string, unknown> => typeof d === "object" && d !== null)
    .map((d) => {
      const varNamesRaw =
        typeof d.varNames === "object" && d.varNames !== null
          ? (d.varNames as Record<string, unknown>)
          : {};
      const varNames: DashboardVarNames = {};
      for (const key of ["branch", "prNumber", "workflowName", "runnerName"] as const) {
        const value = varNamesRaw[key];
        if (typeof value === "string" && value.trim() !== "") {
          varNames[key] = value.trim();
        }
      }
      return {
        name: typeof d.name === "string" ? d.name.trim() : "",
        uid: typeof d.uid === "string" ? d.uid.trim() : "",
        slug: typeof d.slug === "string" ? d.slug.trim() : "",
        varNames,
      };
    })
    // A dashboard with no uid can't be jumped to; drop it rather than emit a
    // broken link.
    .filter((d) => d.uid !== "");

  return { baseUrl, dashboards };
}

/** True once there's at least a base URL and one dashboard to jump to. */
function isConfigured(config: GrafanaJumpConfig): boolean {
  return config.baseUrl !== "" && config.dashboards.length > 0;
}

// ---------------------------------------------------------------------------
// Pure logic: parsing the current location into a jump context, and building
// the resulting Grafana URL. Kept free of DOM/GM access so it can be unit
// tested directly (see test/grafana-jump.test.js).
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
  // Only present for scope "repo" - an org-scoped runner page isn't under any
  // one repo, so there's nothing to look up a repo config for.
  repo?: string;
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

  const repoMatch = pathname.match(/^\/([^/]+)\/([^/]+)\/settings\/actions\/runners\/(\d+)/);
  if (repoMatch) {
    const [, org, repo, runnerId] = repoMatch;
    return { kind: "runner", scope: "repo", org, repo, runnerId };
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

/** Which DashboardVarNames key a given context kind is filtered by. */
function contextVarKey(kind: JumpContext["kind"]): keyof DashboardVarNames {
  switch (kind) {
    case "pr":
      return "prNumber";
    case "branch":
      return "branch";
    case "workflow":
      return "workflowName";
    case "runner":
      return "runnerName";
  }
}

/** The raw filter value (PR number, branch name, etc.) carried by a context. */
function contextFilterValue(context: JumpContext): string {
  switch (context.kind) {
    case "pr":
      return context.prNumber;
    case "branch":
      return context.branch;
    case "workflow":
      return context.workflowFile;
    case "runner":
      return context.runnerId;
  }
}

/**
 * Which of the configured dashboards can actually be jumped to for this
 * context - i.e. have a template-variable name configured for the field this
 * context kind filters by. A dashboard with no matching varName is left out
 * rather than linked to with no filter applied.
 */
function applicableDashboards(config: GrafanaJumpConfig, context: JumpContext): DashboardConfig[] {
  const key = contextVarKey(context.kind);
  return config.dashboards.filter((dashboard) => Boolean(dashboard.varNames[key]));
}

/**
 * The {org, repo} a jump context belongs to, for looking up that repo's
 * `.github/jump-links.config.yaml` - or null when the context isn't scoped to
 * one repo (an org-scoped runner page covers every repo in the org, so there's
 * no single repo config to fetch).
 */
function repoContextForJump(context: JumpContext): { org: string; repo: string } | null {
  switch (context.kind) {
    case "pr":
    case "branch":
    case "workflow":
      return { org: context.org, repo: context.repo };
    case "runner":
      return context.repo ? { org: context.org, repo: context.repo } : null;
  }
}

/** One dashboard paired with the base URL of the config it came from. */
interface ActiveDashboard {
  baseUrl: string;
  dashboard: DashboardConfig;
}

/**
 * Resolves which dashboards are actually offered as jump targets for a
 * context, given the user's own (personal, GM-storage) config and the
 * current repo's checked-in config (or null if there isn't one / it failed to
 * load). The personal config always wins outright when it has anything
 * applicable to this context - repoConfig is a fallback for contributors who
 * haven't set up their own config yet, not something merged dashboard-by-
 * dashboard with the personal one. Merging would require reconciling two
 * potentially different Grafana base URLs per dashboard; keeping the two
 * configs mutually exclusive per render avoids that entirely.
 */
function activeDashboards(
  personalConfig: GrafanaJumpConfig,
  repoConfig: GrafanaJumpConfig | null,
  context: JumpContext,
): ActiveDashboard[] {
  const personal = applicableDashboards(personalConfig, context);
  if (personal.length > 0) {
    return personal.map((dashboard) => ({ baseUrl: personalConfig.baseUrl, dashboard }));
  }
  if (!repoConfig) return [];
  return applicableDashboards(repoConfig, context).map((dashboard) => ({
    baseUrl: repoConfig.baseUrl,
    dashboard,
  }));
}

/**
 * Combines a repo's existing checked-in config with the current user's own
 * config, for exporting back into the repo - unlike activeDashboards() above,
 * this is a real union: the point of exporting is to publish your personal
 * dashboards for the rest of the repo, on top of whatever's already shared,
 * not to pick one source over the other. Dashboards are deduped by uid,
 * preferring the repo's own copy of a uid that appears in both (it may have
 * been intentionally edited by someone else since you last synced). baseUrl
 * prefers the repo's if it has one, since the merged dashboard list is
 * exported as a single file with one shared baseUrl field - if your personal
 * dashboards actually live under a *different* Grafana instance than the
 * repo's, this merge would produce an incorrect shared baseUrl for one set of
 * them; that caveat is surfaced in the exported file's header comment rather
 * than silently guessed at here.
 */
function mergeConfigsForExport(
  repoConfig: GrafanaJumpConfig | null,
  personalConfig: GrafanaJumpConfig,
): GrafanaJumpConfig {
  const merged = repoConfig ? [...repoConfig.dashboards] : [];
  const knownUids = new Set(merged.map((d) => d.uid));
  for (const dashboard of personalConfig.dashboards) {
    if (!knownUids.has(dashboard.uid)) {
      merged.push(dashboard);
      knownUids.add(dashboard.uid);
    }
  }
  return {
    baseUrl: repoConfig?.baseUrl || personalConfig.baseUrl,
    dashboards: merged,
  };
}

/**
 * Builds a Grafana dashboard URL with one or more template variables preset via
 * the `var-<name>=<value>` query convention.
 */
function buildDashboardUrl(
  baseUrl: string,
  dashboard: { uid: string; slug: string },
  vars: Record<string, string>,
): string {
  const params = Object.entries(vars)
    .map(([name, value]) => `var-${encodeURIComponent(name)}=${encodeURIComponent(value)}`)
    .join("&");
  const query = params ? `?${params}` : "";
  return `${baseUrl}/d/${dashboard.uid}/${dashboard.slug}${query}`;
}

/**
 * Builds the Grafana jump URL for one dashboard against a resolved context.
 * Assumes the dashboard is applicable (see applicableDashboards) - callers that
 * skip that check will just get a link with no var- filter applied.
 */
function buildJumpUrl(baseUrl: string, dashboard: DashboardConfig, context: JumpContext): string {
  const key = contextVarKey(context.kind);
  const varName = dashboard.varNames[key];
  const vars = varName ? { [varName]: contextFilterValue(context) } : {};
  return buildDashboardUrl(baseUrl, dashboard, vars);
}

/** Human-readable label for the jump button, specific to the matched context. */
function labelForContext(context: JumpContext): string {
  switch (context.kind) {
    case "pr":
      return `Grafana: PR #${context.prNumber} CI`;
    case "branch":
      return `Grafana: ${context.branch} CI`;
    case "workflow":
      return `Grafana: ${context.workflowFile} runs`;
    case "runner":
      return `Grafana: runner ${context.runnerId}`;
  }
}

// ---------------------------------------------------------------------------
// Repo config parsing. A repo can check in .github/jump-links.config.yaml to
// give every contributor the same dashboards without each of them filling in
// the config panel by hand (see activeDashboards() above for how it's
// combined with a contributor's own personal config).
//
// This is a small hand-rolled parser for a deliberate YAML *subset* - just
// enough to read {baseUrl, dashboards: [{...}]} - rather than a real YAML
// parser. Pulling in a full one (e.g. js-yaml) isn't a plain npm dependency
// here: a userscript has no bundler, so the only way to ship a third-party
// library alongside it is an `@require` of remote code fetched by the user's
// script manager at run time - that's a supply-chain surface (arbitrary
// third-party code, outside this repo's own build/audit process) worth
// avoiding for a format this small. Supported shape: 2-space-indented (or any
// consistent width) block mappings and sequences of block mappings, plain or
// single/double-quoted scalars, blank lines, and full-line `#` comments. No
// flow style (`{a: b}`/`[a, b]`), anchors, multi-line scalars, or tabs.
// ---------------------------------------------------------------------------

interface YamlLiteLine {
  indent: number;
  content: string;
}

function tokenizeYamlLite(text: string): YamlLiteLine[] {
  return text
    .split("\n")
    .map((line) => line.replace(/\r$/, ""))
    .filter((line) => line.trim() !== "" && !line.trim().startsWith("#"))
    .map((line) => ({
      indent: line.length - line.replace(/^ */, "").length,
      content: line.trim(),
    }));
}

function unquoteYamlLiteScalar(value: string): string {
  const trimmed = value.trim();
  const isQuoted =
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")));
  return isQuoted ? trimmed.slice(1, -1) : trimmed;
}

function isYamlLiteSeqItem(content: string): boolean {
  return content === "-" || content.startsWith("- ");
}

// A mutable cursor shared across the recursive parse* calls below, so a
// nested call resumes exactly where its caller left off.
interface YamlLiteCursor {
  i: number;
}

function parseYamlLiteMapEntry(
  lines: YamlLiteLine[],
  pos: YamlLiteCursor,
  indent: number,
): Record<string, unknown> {
  const line = lines[pos.i];
  const colonIdx = line.content.indexOf(":");
  if (colonIdx === -1) {
    // Malformed line for this format; skip it rather than throw, consistent
    // with normalizeConfig()'s general policy of dropping bad input.
    pos.i++;
    return {};
  }
  const key = line.content.slice(0, colonIdx).trim();
  const value = line.content.slice(colonIdx + 1).trim();
  pos.i++;
  if (value !== "") return { [key]: unquoteYamlLiteScalar(value) };
  if (pos.i < lines.length && lines[pos.i].indent > indent) {
    return { [key]: parseYamlLiteBlock(lines, pos, lines[pos.i].indent) };
  }
  return { [key]: "" };
}

function parseYamlLiteSequence(
  lines: YamlLiteLine[],
  pos: YamlLiteCursor,
  indent: number,
): unknown[] {
  const result: unknown[] = [];
  while (pos.i < lines.length && lines[pos.i].indent === indent && isYamlLiteSeqItem(lines[pos.i].content)) {
    const content = lines[pos.i].content;
    const rest = content === "-" ? "" : content.slice(2);

    if (rest === "") {
      pos.i++;
      const childIndent = pos.i < lines.length ? lines[pos.i].indent : indent;
      result.push(childIndent > indent ? parseYamlLiteBlock(lines, pos, childIndent) : "");
    } else if (rest.includes(":")) {
      // "- key: value" opens an inline mapping item. Its first key has no
      // line of its own to read an indent from - the dash and the space
      // after it occupy 2 columns, so sibling keys line up at indent + 2.
      // This is the one place a fixed offset is required rather than read
      // from the input, same as real YAML.
      const itemIndent = indent + 2;
      const colonIdx = rest.indexOf(":");
      const key = rest.slice(0, colonIdx).trim();
      const value = rest.slice(colonIdx + 1).trim();
      pos.i++;
      const map: Record<string, unknown> = {
        [key]:
          value !== ""
            ? unquoteYamlLiteScalar(value)
            : pos.i < lines.length && lines[pos.i].indent > itemIndent
              ? parseYamlLiteBlock(lines, pos, lines[pos.i].indent)
              : "",
      };
      while (pos.i < lines.length && lines[pos.i].indent === itemIndent) {
        Object.assign(map, parseYamlLiteMapEntry(lines, pos, itemIndent));
      }
      result.push(map);
    } else {
      pos.i++;
      result.push(unquoteYamlLiteScalar(rest));
    }
  }
  return result;
}

function parseYamlLiteBlock(lines: YamlLiteLine[], pos: YamlLiteCursor, indent: number): unknown {
  if (pos.i >= lines.length || lines[pos.i].indent !== indent) return {};
  if (isYamlLiteSeqItem(lines[pos.i].content)) return parseYamlLiteSequence(lines, pos, indent);

  const map: Record<string, unknown> = {};
  while (pos.i < lines.length && lines[pos.i].indent === indent && !isYamlLiteSeqItem(lines[pos.i].content)) {
    Object.assign(map, parseYamlLiteMapEntry(lines, pos, indent));
  }
  return map;
}

/** Parses the YAML subset described above into plain objects/arrays/strings. */
function parseYamlLite(text: string): unknown {
  const lines = tokenizeYamlLite(text);
  if (lines.length === 0) return {};
  return parseYamlLiteBlock(lines, { i: 0 }, lines[0].indent);
}

/**
 * Renders a plain scalar for the YAML-lite format above, quoting only when
 * necessary - kept minimal (not general YAML-correct) since it only ever has
 * to round-trip through parseYamlLite's own unquoting logic.
 */
function yamlLiteScalar(value: string): string {
  const needsQuoting =
    value === "" ||
    value !== value.trim() ||
    /^[\s\-?:,[\]{}#&*!|>'"%@`]/.test(value) ||
    /: |:$/.test(value) ||
    / #/.test(value);
  if (!needsQuoting) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Serializes a GrafanaJumpConfig into the YAML-lite format parseYamlLite reads. */
function configToYamlLite(config: GrafanaJumpConfig): string {
  const lines: string[] = [`baseUrl: ${yamlLiteScalar(config.baseUrl)}`];

  if (config.dashboards.length === 0) {
    lines.push("dashboards: []");
    return `${lines.join("\n")}\n`;
  }

  lines.push("dashboards:");
  for (const dashboard of config.dashboards) {
    lines.push(`  - name: ${yamlLiteScalar(dashboard.name)}`);
    lines.push(`    uid: ${yamlLiteScalar(dashboard.uid)}`);
    lines.push(`    slug: ${yamlLiteScalar(dashboard.slug)}`);
    const varEntries = Object.entries(dashboard.varNames).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string" && entry[1] !== "",
    );
    if (varEntries.length === 0) {
      lines.push("    varNames: {}");
    } else {
      lines.push("    varNames:");
      for (const [key, value] of varEntries) {
        lines.push(`      ${key}: ${yamlLiteScalar(value)}`);
      }
    }
  }
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Config persistence. Wrapped so the rest of the script only ever deals with a
// GrafanaJumpConfig object, never the raw JSON-string storage format.
// ---------------------------------------------------------------------------

const CONFIG_STORAGE_KEY = "grafanaJumpConfig.v1";

async function loadConfig(): Promise<GrafanaJumpConfig> {
  const raw = await GM.getValue(CONFIG_STORAGE_KEY, "");
  if (typeof raw !== "string" || raw === "") return defaultConfig();
  try {
    return normalizeConfig(JSON.parse(raw));
  } catch {
    return defaultConfig();
  }
}

async function saveConfig(config: GrafanaJumpConfig): Promise<void> {
  await GM.setValue(CONFIG_STORAGE_KEY, JSON.stringify(config));
}

// ---------------------------------------------------------------------------
// Repo config fetching. Cross-origin (github.com -> raw.githubusercontent.com)
// requests from an injected page script are subject to GitHub's own CSP, so
// this uses GM.xmlHttpRequest (granted in meta.json, with a matching
// @connect for raw.githubusercontent.com) rather than page-context fetch() -
// GM.xmlHttpRequest is exempt from the page's CSP/CORS by design, which is
// exactly why it exists.
//
// Cached per {org, repo} for the life of the tab: GitHub's Actions/PR pages
// are a single-page app, so navigating between pages in the same repo would
// otherwise re-fetch this on every checkLocation() call for no reason.
// ---------------------------------------------------------------------------

const REPO_CONFIG_PATH = ".github/jump-links.config.yaml";

const repoConfigCache = new Map<string, Promise<GrafanaJumpConfig | null>>();

function fetchRepoConfig(org: string, repo: string): Promise<GrafanaJumpConfig | null> {
  const key = `${org}/${repo}`;
  const cached = repoConfigCache.get(key);
  if (cached) return cached;

  const promise = new Promise<GrafanaJumpConfig | null>((resolve) => {
    const url =
      `https://raw.githubusercontent.com/${encodeURIComponent(org)}/${encodeURIComponent(repo)}` +
      `/HEAD/${REPO_CONFIG_PATH}`;
    GM.xmlHttpRequest({
      method: "GET",
      url,
      onload: (response: { status: number; responseText: string }) => {
        if (response.status !== 200) {
          resolve(null);
          return;
        }
        try {
          resolve(normalizeConfig(parseYamlLite(response.responseText)));
        } catch {
          resolve(null);
        }
      },
      onerror: () => resolve(null),
    });
  });
  repoConfigCache.set(key, promise);
  return promise;
}

const defaultBranchCache = new Map<string, Promise<string>>();

/**
 * GitHub's "create/edit file" web UI is addressed by branch name, not by the
 * "HEAD" alias fetchRepoConfig() above gets to use (that alias only exists
 * for raw.githubusercontent.com content URLs) - so building a link into that
 * UI needs the actual default branch name. Falls back to "main" on any
 * failure; worst case the resulting link's branch segment is wrong and
 * GitHub's own UI surfaces that, rather than anything failing silently.
 */
function resolveDefaultBranch(org: string, repo: string): Promise<string> {
  const key = `${org}/${repo}`;
  const cached = defaultBranchCache.get(key);
  if (cached) return cached;

  const promise = new Promise<string>((resolve) => {
    GM.xmlHttpRequest({
      method: "GET",
      url: `https://api.github.com/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}`,
      onload: (response: { status: number; responseText: string }) => {
        try {
          const data: unknown = JSON.parse(response.responseText);
          const branch =
            typeof data === "object" && data !== null && typeof (data as { default_branch?: unknown }).default_branch === "string"
              ? (data as { default_branch: string }).default_branch
              : "";
          resolve(branch || "main");
        } catch {
          resolve("main");
        }
      },
      onerror: () => resolve("main"),
    });
  });
  defaultBranchCache.set(key, promise);
  return promise;
}

/**
 * A link into GitHub's own "create new file" web UI, pre-filled with a path
 * and content. Committing from there goes through GitHub's normal auth/PR
 * flow (direct commit if you can push, a fork+PR if you can't) - this script
 * never touches the repo's git history itself, only hands GitHub's own UI a
 * suggested path and content to start from. Works the same whether or not
 * that path already exists: GitHub's create-file UI detects an existing file
 * at the given path and lets the pre-filled content replace it from there.
 */
function buildCreateFileUrl(org: string, repo: string, branch: string, path: string, content: string): string {
  const params = new URLSearchParams({ filename: path, value: content });
  return `https://github.com/${org}/${repo}/new/${branch}?${params.toString()}`;
}

const REPO_CONFIG_TEMPLATE = `# Config for the "GitHub Actions => Grafana jump button" userscript
# (https://github.com/nsheaps/greasemonkey-scripts/tree/main/packages/github-actions-grafana-jump).
# Gives every contributor to this repo the same dashboards without each of
# them configuring the userscript by hand. A contributor's own personal
# config (set via the userscript's own "Set up Grafana jump" panel) always
# takes priority over this file for any page it covers - this is only a
# fallback for pages nobody has personally configured.
#
# baseUrl: your Grafana instance's base URL (no trailing slash).
# dashboards: one entry per dashboard you want jumpable to. For each:
#   name     - display label for the jump button/menu.
#   uid      - the dashboard's UID (Grafana dashboard settings -> JSON Model,
#              or the segment right after /d/ in the dashboard's URL).
#   slug     - the URL slug right after the uid in the dashboard's URL.
#   varNames - which of this dashboard's template variables (if any) to
#              preset from the current GitHub page. Leave a field out if the
#              dashboard doesn't use that kind of filter.
baseUrl: https://grafana.example.com
dashboards:
  - name: CI Overview
    uid: REPLACE_WITH_DASHBOARD_UID
    slug: REPLACE_WITH_DASHBOARD_SLUG
    varNames:
      branch: branch
      prNumber: pr_number
      workflowName: workflow_file
      runnerName: runner_name
`;

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

const CONTAINER_ID = "grafanaJumpContainer";

const BUTTON_STYLE =
  "display: inline-block; background: #F55F0E; color: #fff; padding: 8px 12px; " +
  "border: none; border-radius: 6px 0 0 6px; font-size: 12px; font-weight: 600; " +
  "font-family: inherit; text-decoration: none; cursor: pointer; vertical-align: top;";

const TOGGLE_STYLE =
  "display: inline-block; background: #c94c0a; color: #fff; padding: 8px 8px; " +
  "border: none; border-left: 1px solid rgba(255,255,255,0.3); border-radius: 0 6px 6px 0; " +
  "font-size: 12px; font-family: inherit; cursor: pointer; vertical-align: top;";

const SOLO_BUTTON_STYLE =
  "display: inline-block; background: #57606a; color: #fff; padding: 8px 12px; " +
  "border: none; border-radius: 6px; font-size: 12px; font-weight: 600; " +
  "font-family: inherit; text-decoration: none; cursor: pointer;";

const MENU_STYLE =
  "position: absolute; bottom: 100%; right: 0; margin-bottom: 4px; background: #fff; " +
  "color: #24292f; border-radius: 6px; box-shadow: 0 4px 12px rgba(0,0,0,0.25); " +
  "min-width: 180px; overflow: hidden; font-family: inherit;";

const MENU_ITEM_STYLE =
  "display: block; padding: 8px 12px; font-size: 12px; text-decoration: none; " +
  "color: inherit; white-space: nowrap; cursor: pointer; background: none; " +
  "border: none; width: 100%; text-align: left; box-sizing: border-box;";

let currentConfig: GrafanaJumpConfig = defaultConfig();

// The current page's repo config (see the "Repo config fetching" section
// above), and the "org/repo" key it belongs to - null/undefined until a repo
// config has actually been fetched (or the current context isn't scoped to a
// single repo at all, e.g. the org-scoped runner page).
let currentRepoConfig: GrafanaJumpConfig | null = null;
let currentRepoConfigKey: string | undefined;

function closeMenu(): void {
  document.getElementById(`${CONTAINER_ID}-menu`)?.remove();
}

function openMenu(
  anchorContainer: HTMLElement,
  items: Array<{ label: string; onClick: () => void }>,
): void {
  closeMenu();
  const menu = document.createElement("div");
  menu.id = `${CONTAINER_ID}-menu`;
  menu.setAttribute("style", MENU_STYLE);

  for (const item of items) {
    const entry = document.createElement("button");
    entry.type = "button";
    entry.textContent = item.label;
    entry.setAttribute("style", MENU_ITEM_STYLE);
    entry.addEventListener("mouseenter", () => {
      entry.style.background = "#f6f8fa";
    });
    entry.addEventListener("mouseleave", () => {
      entry.style.background = "none";
    });
    entry.addEventListener("click", (event) => {
      event.stopPropagation();
      closeMenu();
      item.onClick();
    });
    menu.appendChild(entry);
  }

  anchorContainer.appendChild(menu);

  // Close on next outside click. Deferred so this listener doesn't also catch
  // the very click that opened the menu.
  setTimeout(() => {
    document.addEventListener("click", closeMenu, { once: true });
  }, 0);
}

function openConfigModal(repoCtx: { org: string; repo: string } | null): void {
  closeMenu();

  // Work on a deep-ish draft copy so Cancel leaves the saved config untouched.
  const draft: GrafanaJumpConfig = {
    baseUrl: currentConfig.baseUrl,
    dashboards: currentConfig.dashboards.map((d) => ({ ...d, varNames: { ...d.varNames } })),
  };

  const overlay = document.createElement("div");
  overlay.setAttribute(
    "style",
    "position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 2147483646; " +
      "display: flex; align-items: center; justify-content: center; font-family: sans-serif;",
  );
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) document.body.removeChild(overlay);
  });

  const panel = document.createElement("div");
  panel.setAttribute(
    "style",
    "background: #fff; color: #24292f; border-radius: 8px; padding: 20px; " +
      "width: 520px; max-width: 90vw; max-height: 85vh; overflow-y: auto; " +
      "box-shadow: 0 8px 24px rgba(0,0,0,0.4);",
  );
  panel.addEventListener("click", (event) => event.stopPropagation());

  const title = document.createElement("h2");
  title.textContent = "Configure Grafana jump";
  title.setAttribute("style", "margin: 0 0 12px; font-size: 16px;");
  panel.appendChild(title);

  const help = document.createElement("p");
  help.textContent =
    "Set your Grafana base URL and the dashboards to jump to. For each dashboard, " +
    "fill in whichever template-variable names it uses (dashboard settings -> " +
    "Variables) - leave the rest blank. A dashboard only shows up as a jump target " +
    "on pages matching a variable name you've filled in.";
  help.setAttribute("style", "margin: 0 0 16px; font-size: 12px; color: #57606a;");
  panel.appendChild(help);

  const baseUrlLabel = document.createElement("label");
  baseUrlLabel.textContent = "Grafana base URL";
  baseUrlLabel.setAttribute("style", "display: block; font-size: 12px; font-weight: 600; margin-bottom: 4px;");
  panel.appendChild(baseUrlLabel);

  const baseUrlInput = document.createElement("input");
  baseUrlInput.type = "text";
  baseUrlInput.placeholder = "https://grafana.example.com";
  baseUrlInput.value = draft.baseUrl;
  baseUrlInput.setAttribute(
    "style",
    "display: block; width: 100%; box-sizing: border-box; padding: 6px 8px; " +
      "margin-bottom: 16px; font-size: 13px; border: 1px solid #d0d7de; border-radius: 6px; " +
      // Explicit background/color: without these, browsers apply their own
      // dark-mode default styling to unstyled inputs, which can pair a dark
      // input background with dark text from this panel's own color rules
      // and make it unreadable. The whole modal is intentionally light-themed
      // regardless of the page's color scheme, so its inputs need to match.
      "background: #fff; color: #24292f;",
  );
  baseUrlInput.addEventListener("input", () => {
    draft.baseUrl = baseUrlInput.value.trim();
  });
  panel.appendChild(baseUrlInput);

  const dashboardsHeading = document.createElement("div");
  dashboardsHeading.textContent = "Dashboards";
  dashboardsHeading.setAttribute("style", "font-size: 12px; font-weight: 600; margin-bottom: 8px;");
  panel.appendChild(dashboardsHeading);

  const rowsContainer = document.createElement("div");
  panel.appendChild(rowsContainer);

  const textField = (
    parent: HTMLElement,
    labelText: string,
    value: string,
    onInput: (value: string) => void,
  ): void => {
    const wrapper = document.createElement("div");
    wrapper.setAttribute("style", "margin-bottom: 6px;");
    const label = document.createElement("label");
    label.textContent = labelText;
    label.setAttribute("style", "display: block; font-size: 11px; color: #57606a; margin-bottom: 2px;");
    const input = document.createElement("input");
    input.type = "text";
    input.value = value;
    input.setAttribute(
      "style",
      "display: block; width: 100%; box-sizing: border-box; padding: 4px 6px; " +
        "font-size: 12px; border: 1px solid #d0d7de; border-radius: 4px; " +
        "background: #fff; color: #24292f;",
    );
    input.addEventListener("input", () => onInput(input.value));
    wrapper.appendChild(label);
    wrapper.appendChild(input);
    parent.appendChild(wrapper);
  };

  const renderRows = (): void => {
    rowsContainer.innerHTML = "";
    draft.dashboards.forEach((dashboard, index) => {
      const row = document.createElement("div");
      row.setAttribute(
        "style",
        "border: 1px solid #d0d7de; border-radius: 6px; padding: 10px; margin-bottom: 10px; position: relative;",
      );

      const removeButton = document.createElement("button");
      removeButton.type = "button";
      removeButton.textContent = "Remove";
      removeButton.setAttribute(
        "style",
        "position: absolute; top: 8px; right: 8px; background: none; border: none; " +
          "color: #cf222e; font-size: 11px; cursor: pointer;",
      );
      removeButton.addEventListener("click", () => {
        draft.dashboards.splice(index, 1);
        renderRows();
      });
      row.appendChild(removeButton);

      textField(row, "Display name", dashboard.name, (value) => {
        dashboard.name = value;
      });
      textField(row, "Dashboard UID", dashboard.uid, (value) => {
        dashboard.uid = value.trim();
      });
      textField(row, "Dashboard slug", dashboard.slug, (value) => {
        dashboard.slug = value.trim();
      });

      const varsHeading = document.createElement("div");
      varsHeading.textContent = "Template variable names (leave blank if not used)";
      varsHeading.setAttribute("style", "font-size: 11px; color: #57606a; margin: 8px 0 4px;");
      row.appendChild(varsHeading);

      const varFields: Array<[keyof DashboardVarNames, string]> = [
        ["branch", "Branch"],
        ["prNumber", "PR number"],
        ["workflowName", "Workflow file"],
        ["runnerName", "Runner"],
      ];
      for (const [key, label] of varFields) {
        textField(row, label, dashboard.varNames[key] ?? "", (value) => {
          const trimmed = value.trim();
          if (trimmed === "") {
            delete dashboard.varNames[key];
          } else {
            dashboard.varNames[key] = trimmed;
          }
        });
      }

      rowsContainer.appendChild(row);
    });
  };
  renderRows();

  const addButton = document.createElement("button");
  addButton.type = "button";
  addButton.textContent = "+ Add dashboard";
  addButton.setAttribute(
    "style",
    "display: block; width: 100%; padding: 8px; margin-bottom: 16px; " +
      "background: #f6f8fa; border: 1px dashed #d0d7de; border-radius: 6px; " +
      "font-size: 12px; cursor: pointer;",
  );
  addButton.addEventListener("click", () => {
    draft.dashboards.push({ name: "", uid: "", slug: "", varNames: {} });
    renderRows();
  });
  panel.appendChild(addButton);

  if (repoCtx && (!currentRepoConfig || isConfigured(currentConfig))) {
    const repoSyncHeading = document.createElement("div");
    repoSyncHeading.textContent = `Share with ${repoCtx.org}/${repoCtx.repo}`;
    repoSyncHeading.setAttribute("style", "font-size: 12px; font-weight: 600; margin-bottom: 4px;");
    panel.appendChild(repoSyncHeading);

    const repoSyncHelp = document.createElement("p");
    repoSyncHelp.textContent =
      `Opens GitHub's own "create file" page for this repo's ${REPO_CONFIG_PATH}, pre-filled - ` +
      "review and commit (or open a PR) from there. Nothing is written until you do.";
    repoSyncHelp.setAttribute("style", "margin: 0 0 8px; font-size: 11px; color: #57606a;");
    panel.appendChild(repoSyncHelp);

    const repoSyncRow = document.createElement("div");
    repoSyncRow.setAttribute("style", "display: flex; gap: 8px; margin-bottom: 16px;");

    const secondaryButtonStyle =
      "flex: 1; padding: 6px 10px; font-size: 11px; border-radius: 6px; border: 1px solid #d0d7de; " +
      "background: #f6f8fa; color: #24292f; cursor: pointer;";

    const openCreateFileTab = (content: string): void => {
      void resolveDefaultBranch(repoCtx.org, repoCtx.repo).then((branch) => {
        const url = buildCreateFileUrl(repoCtx.org, repoCtx.repo, branch, REPO_CONFIG_PATH, content);
        window.open(url, "_blank");
      });
    };

    if (!currentRepoConfig) {
      const templateButton = document.createElement("button");
      templateButton.type = "button";
      templateButton.textContent = "📄 Create repo config template";
      templateButton.setAttribute("style", secondaryButtonStyle);
      templateButton.addEventListener("click", () => openCreateFileTab(REPO_CONFIG_TEMPLATE));
      repoSyncRow.appendChild(templateButton);
    }

    if (isConfigured(currentConfig)) {
      // Exports the saved config, not unsaved edits in this draft - if you've
      // just added a dashboard, Save first so the export includes it.
      const exportButton = document.createElement("button");
      exportButton.type = "button";
      exportButton.textContent = "⬆️ Export my config to repo";
      exportButton.setAttribute("style", secondaryButtonStyle);
      exportButton.addEventListener("click", () => {
        const merged = mergeConfigsForExport(currentRepoConfig, currentConfig);
        openCreateFileTab(configToYamlLite(merged));
      });
      repoSyncRow.appendChild(exportButton);
    }

    // The outer `if` above already guarantees at least one of the two
    // buttons was added.
    panel.appendChild(repoSyncRow);
  }

  const actions = document.createElement("div");
  actions.setAttribute("style", "display: flex; justify-content: flex-end; gap: 8px;");

  const cancelButton = document.createElement("button");
  cancelButton.type = "button";
  cancelButton.textContent = "Cancel";
  cancelButton.setAttribute(
    "style",
    "padding: 6px 14px; font-size: 12px; border-radius: 6px; border: 1px solid #d0d7de; " +
      "background: #fff; cursor: pointer;",
  );
  cancelButton.addEventListener("click", () => document.body.removeChild(overlay));
  actions.appendChild(cancelButton);

  const saveButton = document.createElement("button");
  saveButton.type = "button";
  saveButton.textContent = "Save";
  saveButton.setAttribute(
    "style",
    "padding: 6px 14px; font-size: 12px; border-radius: 6px; border: none; " +
      "background: #1f883d; color: #fff; cursor: pointer;",
  );
  saveButton.addEventListener("click", () => {
    void (async () => {
      const cleaned = normalizeConfig(draft);
      await saveConfig(cleaned);
      currentConfig = cleaned;
      document.body.removeChild(overlay);
      checkLocation(true);
    })();
  });
  actions.appendChild(saveButton);

  panel.appendChild(actions);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);
}

function renderJumpButton(context: JumpContext | null): void {
  const existing = document.getElementById(CONTAINER_ID);

  if (!context) {
    existing?.remove();
    return;
  }

  const active = activeDashboards(currentConfig, currentRepoConfig, context);

  const container = existing ?? document.createElement("div");
  container.id = CONTAINER_ID;
  container.setAttribute(
    "style",
    "position: fixed; bottom: 16px; right: 16px; z-index: 2147483647;",
  );
  container.innerHTML = "";

  if (active.length === 0) {
    const setupButton = document.createElement("button");
    setupButton.type = "button";
    setupButton.textContent = isConfigured(currentConfig)
      ? "⚙️ No dashboard configured for this page"
      : "⚙️ Set up Grafana jump";
    setupButton.setAttribute("style", SOLO_BUTTON_STYLE);
    setupButton.addEventListener("click", (event) => {
      event.stopPropagation();
      openConfigModal(repoContextForJump(context));
    });
    container.appendChild(setupButton);
  } else {
    const [primary, ...rest] = active;
    const label = labelForContext(context);

    const jumpLink = document.createElement("a");
    jumpLink.setAttribute("href", buildJumpUrl(primary.baseUrl, primary.dashboard, context));
    jumpLink.setAttribute("target", "_blank");
    jumpLink.setAttribute("style", BUTTON_STYLE);
    jumpLink.textContent = active.length > 1 ? `${label} (${primary.dashboard.name}) ↗️` : `${label} ↗️`;
    container.appendChild(jumpLink);

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.textContent = "▾";
    toggle.setAttribute("style", TOGGLE_STYLE);
    toggle.addEventListener("click", (event) => {
      event.stopPropagation();
      const items = [
        ...active.map(({ baseUrl, dashboard }) => ({
          label: `↗️ ${dashboard.name || dashboard.uid}`,
          onClick: () => window.open(buildJumpUrl(baseUrl, dashboard, context), "_blank"),
        })),
        { label: "⚙️ Edit dashboards...", onClick: () => openConfigModal(repoContextForJump(context)) },
      ];
      openMenu(container, items);
    });
    container.appendChild(toggle);

    // rest is intentionally unused beyond being included in `active` above;
    // named for clarity when reading the destructure at a glance.
    void rest;
  }

  if (!existing) {
    document.body.appendChild(container);
  }
}

let lastLocationKey: string | undefined;

function checkLocation(force = false): void {
  const { pathname, search } = window.location;
  const locationKey = `${pathname}${search}`;
  if (!force && locationKey === lastLocationKey) return;
  lastLocationKey = locationKey;

  const context = resolveJumpContext(pathname, search);
  renderJumpButton(context);

  const repoCtx = context ? repoContextForJump(context) : null;
  const repoKey = repoCtx ? `${repoCtx.org}/${repoCtx.repo}` : undefined;
  if (repoKey === currentRepoConfigKey) return;

  currentRepoConfigKey = repoKey;
  currentRepoConfig = null;
  if (repoCtx) {
    void fetchRepoConfig(repoCtx.org, repoCtx.repo).then((config) => {
      // Guard against a slow response landing after the user has already
      // navigated to a different repo (or one with no repo context at all).
      if (currentRepoConfigKey !== repoKey) return;
      currentRepoConfig = config;
      checkLocation(true);
    });
  }
}

// Guarded so that requiring the compiled output under Node (see the test-only
// export hook below) never touches DOM/GM/browser globals - `document` always
// exists in the real userscript context, so this runs unconditionally there.
if (typeof document !== "undefined") {
  void (async () => {
    currentConfig = await loadConfig();

    const routeChangeObserver = new MutationObserver(() => checkLocation());
    routeChangeObserver.observe(document.body, { childList: true, subtree: true });
    checkLocation();
  })();
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
    contextVarKey,
    contextFilterValue,
    applicableDashboards,
    repoContextForJump,
    activeDashboards,
    mergeConfigsForExport,
    buildDashboardUrl,
    buildJumpUrl,
    labelForContext,
    defaultConfig,
    normalizeConfig,
    isConfigured,
    parseYamlLite,
    configToYamlLite,
    buildCreateFileUrl,
  };
}
