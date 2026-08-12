// ==UserScript==
// @name        GitHub Actions => Grafana jump button
// @version     0.2.12
// @description Add your own jump links to github.com pages (repo home, file views, pull requests and the PR list, the branch list, and the Actions tab down to a single job) - each link is a name and a URL you write yourself, with values from the current page filled in
// @author      Nathan Heaps
// @namespace   https://www.github.com
// @match       http*://www.github.com/*
// @match       http*://github.com/*
// @run-at      document-start
// @icon        data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==
// @grant       GM.setValue
// @grant       GM.getValue
// @grant       GM.xmlHttpRequest
// @connect     raw.githubusercontent.com
// @connect     github.com
// @license     MIT
// @downloadURL https://raw.githubusercontent.com/nsheaps/greasemonkey-scripts/latest/packages/github-actions-grafana-jump/dist/script.user.js
// @updateURL   https://raw.githubusercontent.com/nsheaps/greasemonkey-scripts/latest/packages/github-actions-grafana-jump/dist/script.user.js
// ==/UserScript==
"use strict";
// The `// ==UserScript==` metadata block for this script lives in
// src/meta.json and is prepended to the compiled output by
// scripts/build-userscript.mjs. See that script for why it isn't inlined here.
//
// Adds "jump links" to github.com pages: links out of whatever GitHub page
// you're on and into your own tools, with values from the current page filled
// in. Nothing about any particular tool is baked in - a jump link is just a
// display name plus a URL template, and the template is filled in from the
// fields the current page provides (repo, org, branch, PR number, workflow
// file, runner, run ID, job ID, and more - see ContextFieldKey below). A
// Grafana dashboard link, a Tempo trace search, a wiki page, a runbook: they
// are all just URLs you write out in full, with `{{fieldKey}}` placeholders
// wherever a page value belongs.
//
// Links are configured per GitHub page (a PR page, a workflow run page, a
// branch list page, ...) rather than inferred, so a link only ever shows up
// where you said it should. Configuration comes from two places: your own
// personal config, edited in an in-page panel and persisted via
// GM.setValue/GM.getValue, and a repo's checked-in
// .github/jump-links.config.yaml, which gives every contributor to that repo
// the same links without each of them configuring anything. See
// activeLinks() for how the two combine.
//
// Where the links appear depends on the page - see the "DOM injection" section
// near the bottom. Most pages get one button per link in GitHub's own header
// toolbar; list pages (the PR list, the branch list) instead get a small link
// per row, revealed on hover, scoped to that row's own PR or branch.
const CONTEXT_FIELD_KEYS = [
    "repo",
    "org",
    "repoFullName",
    "branch",
    "prNumber",
    "workflowName",
    "runnerName",
    "runnerGroupName",
    "runId",
    "jobId",
    "serverUrl",
    "apiUrl",
];
function isContextFieldKey(key) {
    return CONTEXT_FIELD_KEYS.includes(key);
}
function defaultConfig() {
    return { pages: [] };
}
/**
 * Reshapes one raw links[] entry into a well-formed JumpLink, or null if it
 * has no URL to open at all - callers drop nulls rather than keeping a link
 * that could only ever go nowhere. A blank name is kept as-is and filled in at
 * display time (see linkDisplayName()).
 */
function normalizeLink(raw) {
    const name = typeof raw.name === "string" ? raw.name.trim() : "";
    // A URL can't contain a newline in the YAML-lite format it also has to
    // round-trip through (see "Repo config parsing" below), which has no
    // multi-line scalar support - collapse one defensively rather than silently
    // exporting an invalid file.
    const url = typeof raw.url === "string" ? raw.url.replace(/\s*\n\s*/g, " ").trim() : "";
    if (url === "")
        return null;
    return { name, url };
}
/**
 * Defensively reshapes a value loaded from storage (or pasted/hand-edited)
 * into a well-formed JumpLinksConfig, dropping anything malformed rather than
 * throwing. Keeps the rest of the script free of null/undefined-shape checks.
 * Unknown page names are dropped (a typo'd page can never match a real page,
 * so keeping it would only ever hide the mistake), and two entries naming the
 * same page are merged into one rather than letting the second shadow the
 * first.
 */
function normalizeConfig(raw) {
    if (typeof raw !== "object" || raw === null)
        return defaultConfig();
    const obj = raw;
    const pagesRaw = Array.isArray(obj.pages) ? obj.pages : [];
    const byPage = new Map();
    for (const entry of pagesRaw) {
        if (typeof entry !== "object" || entry === null)
            continue;
        const entryObj = entry;
        const page = typeof entryObj.page === "string" ? entryObj.page.trim() : "";
        if (!isJumpPageKind(page))
            continue;
        const links = (Array.isArray(entryObj.links) ? entryObj.links : [])
            .filter((link) => typeof link === "object" && link !== null)
            .map(normalizeLink)
            .filter((link) => link !== null);
        if (links.length === 0)
            continue;
        const existing = byPage.get(page);
        if (existing) {
            existing.push(...links);
        }
        else {
            byPage.set(page, links);
        }
    }
    // Emitted in JUMP_PAGE_KINDS order rather than input order, so a config's
    // serialized form doesn't depend on how it happened to be typed in.
    const pages = JUMP_PAGE_KINDS.filter((page) => byPage.has(page)).map((page) => ({
        page,
        links: byPage.get(page),
    }));
    return { pages };
}
/** True once there's at least one link configured for at least one page. */
function isConfigured(config) {
    return config.pages.length > 0;
}
/** The links configured for one page kind, or an empty list if none are. */
function linksForPage(config, page) {
    return config.pages.find((entry) => entry.page === page)?.links ?? [];
}
/** The text to show on a link's button - its name, or its URL if unnamed. */
function linkDisplayName(link) {
    return link.name || link.url;
}
/**
 * Every supported page kind, in the order they're listed in configs and in the
 * config panel: repo-wide pages first, then pull requests, then the Actions
 * tab from broadest to narrowest, then self-hosted runner administration.
 */
const JUMP_PAGE_KINDS = [
    "repoHome",
    "repoFile",
    "pr",
    "prList",
    "branchList",
    "actionsList",
    "branch",
    "workflow",
    "run",
    "job",
    "runner",
    "runnerGroup",
];
function isJumpPageKind(value) {
    return JUMP_PAGE_KINDS.includes(value);
}
/** Short human-readable name for a page kind, for the config panel. */
const JUMP_PAGE_LABELS = {
    repoHome: "Repo home page",
    repoFile: "File view",
    pr: "Pull request",
    prList: "Pull request list",
    branchList: "Branch list",
    actionsList: "Actions tab",
    branch: "Actions tab, filtered to a branch",
    workflow: "One workflow's runs",
    run: "One workflow run",
    job: "One job in a workflow run",
    runner: "Self-hosted runner",
    runnerGroup: "Runner group",
};
/**
 * Path prefixes that look like `/<org>/<repo>` but aren't - GitHub's own
 * global pages and the org-settings routes parseRunnerContext() matches. Only
 * needed by parseRepoHomeContext(), the one parser whose pattern is loose
 * enough (any two path segments) to swallow them.
 */
const RESERVED_OWNER_SEGMENTS = [
    "organizations",
    "orgs",
    "settings",
    "notifications",
    "explore",
    "topics",
    "collections",
    "sponsors",
    "marketplace",
    "codespaces",
    "apps",
    "search",
    "new",
    "login",
    "logout",
    "dashboard",
    "account",
    "pulls",
    "issues",
];
/** Matches a repo's own landing page, e.g. `/org/repo`. */
function parseRepoHomeContext(pathname) {
    const match = pathname.match(/^\/([^/]+)\/([^/]+)\/?$/);
    if (!match)
        return null;
    const [, org, repo] = match;
    if (RESERVED_OWNER_SEGMENTS.includes(org.toLowerCase()))
        return null;
    return { kind: "repoHome", org, repo };
}
/**
 * Matches a single file being viewed at some ref, e.g.
 * `/org/repo/blob/main/README.md`. A branch name containing a slash is
 * genuinely ambiguous in this URL shape (GitHub doesn't encode the separator),
 * so the first segment after `/blob/` is taken as the branch - which is the
 * whole branch name except on such a branch, where it's the first part of it.
 * That truncated reading is corrected against the ref GitHub itself resolved
 * the URL to, read from the page's DOM by scrapeBlobRef() and layered on top of
 * this result - the same way a run page's DOM-only ref is (see
 * repoConfigTarget()). This stays the pure, synchronous, always-available
 * reading, and the one that stands if the DOM has no answer.
 *
 * A directory view (`/tree/<ref>/<path>`) is not matched: it's a different page,
 * and its header doesn't carry the toolbar this script's buttons go in (verified
 * live - the repo header actions element is simply absent there). The repo's own
 * root at a ref (`/tree/<ref>` with no path after it) does have that toolbar and
 * is matched, as a repo home page - see parseRepoTreeRootContext().
 */
function parseRepoFileContext(pathname) {
    const match = pathname.match(/^\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/.+$/);
    if (!match)
        return null;
    const [, org, repo, branch] = match;
    return { kind: "repoFile", org, repo, branch: decodeURIComponent(branch) };
}
/**
 * Matches the repo's own root viewed at some ref, e.g. `/org/repo/tree/main` -
 * which GitHub renders as the same page as `/org/repo`, with the same header
 * toolbar, just showing another branch's tree. So it resolves to a
 * RepoHomeContext carrying that ref rather than to a page kind of its own.
 *
 * Only the unambiguous single-segment form is read here: with exactly one segment
 * after `/tree/`, that segment is the whole ref and there's no path it could be
 * hiding. Two or more segments are genuinely ambiguous - `/tree/renovate/all-patch`
 * is equally readable as the root at ref `renovate/all-patch` or as directory
 * `all-patch` at ref `renovate` - and nothing in the URL settles it, the same
 * ambiguity parseRepoFileContext() documents. That case is settled against the ref
 * GitHub itself resolved the page to, read from the DOM by
 * scrapeRepoTreeRootContext() and layered on top of this pure reading.
 */
function parseRepoTreeRootContext(pathname) {
    const match = pathname.match(/^\/([^/]+)\/([^/]+)\/tree\/([^/]+)\/?$/);
    if (!match)
        return null;
    const [, org, repo, branch] = match;
    return { kind: "repoHome", org, repo, branch: decodeURIComponent(branch) };
}
/**
 * Matches a pull request's own pages (Conversation/Commits/Checks/Files changed),
 * e.g. `/org/repo/pull/123` or `/org/repo/pull/123/checks`. Any sub-tab counts:
 * they all show the same PR, which is what a link's `{{prNumber}}` refers to.
 */
function parsePrContext(pathname) {
    const match = pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/.*)?$/);
    if (!match)
        return null;
    const [, org, repo, prNumber] = match;
    return { kind: "pr", org, repo, prNumber };
}
/** Matches the repo's pull request list, e.g. `/org/repo/pulls`. */
function parsePrListContext(pathname) {
    const match = pathname.match(/^\/([^/]+)\/([^/]+)\/pulls\/?$/);
    if (!match)
        return null;
    const [, org, repo] = match;
    return { kind: "prList", org, repo };
}
/**
 * Matches the repo's branch list, e.g. `/org/repo/branches` - including its
 * sub-tabs (`/branches/all`, `/branches/yours`, `/branches/stale`), which are
 * the same list under a different filter.
 */
function parseBranchListContext(pathname) {
    const match = pathname.match(/^\/([^/]+)\/([^/]+)\/branches(?:\/[^/]*)?\/?$/);
    if (!match)
        return null;
    const [, org, repo] = match;
    return { kind: "branchList", org, repo };
}
/**
 * Extracts a `branch:<name>` filter out of a GitHub Actions search query string,
 * e.g. `is:success branch:main` or `branch:"feature/some branch"`. Returns null if
 * no branch filter is present.
 */
function extractBranchFromQuery(query) {
    const quotedMatch = query.match(/branch:"([^"]*)"/);
    if (quotedMatch)
        return quotedMatch[1];
    const bareMatch = query.match(/branch:(\S+)/);
    return bareMatch ? bareMatch[1] : null;
}
/**
 * Matches the repo Actions tab filtered down to a single branch via
 * `?query=branch:<name>`, e.g. `/org/repo/actions?query=branch:my-feature`.
 * The same page unfiltered is an ActionsListContext instead - see
 * resolveJumpContext(), which tries this first.
 */
function parseBranchContext(pathname, search) {
    const pathMatch = pathname.match(/^\/([^/]+)\/([^/]+)\/actions\/?$/);
    if (!pathMatch)
        return null;
    const params = new URLSearchParams(search);
    const query = params.get("query");
    if (!query)
        return null;
    const branch = extractBranchFromQuery(query);
    if (!branch)
        return null;
    const [, org, repo] = pathMatch;
    return { kind: "branch", org, repo, branch };
}
/** Matches the repo Actions tab, e.g. `/org/repo/actions`. */
function parseActionsListContext(pathname) {
    const match = pathname.match(/^\/([^/]+)\/([^/]+)\/actions\/?$/);
    if (!match)
        return null;
    const [, org, repo] = match;
    return { kind: "actionsList", org, repo };
}
/**
 * Matches a self-hosted runner's detail page, at either the repo scope
 * (`/org/repo/settings/actions/runners/<id>`) or the org scope
 * (`/organizations/<org>/settings/actions/runners/<id>`).
 */
function parseRunnerContext(pathname) {
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
 * Matches an organization's runner group detail page, e.g.
 * `/organizations/<org>/settings/actions/runner-groups/<id>`. Runner groups
 * are an org-level concept for pooling self-hosted runners across repos, so
 * unlike parseRunnerContext there's no repo-scoped equivalent to match.
 */
function parseRunnerGroupContext(pathname) {
    const match = pathname.match(/^\/organizations\/([^/]+)\/settings\/actions\/runner-groups\/(\d+)/);
    if (!match)
        return null;
    const [, org, groupId] = match;
    return { kind: "runnerGroup", org, groupId };
}
/**
 * Matches a single workflow's own page, showing its runs across all branches,
 * e.g. `/org/repo/actions/workflows/ci.yml`.
 */
function parseWorkflowContext(pathname) {
    const match = pathname.match(/^\/([^/]+)\/([^/]+)\/actions\/workflows\/([^/?#]+)/);
    if (!match)
        return null;
    const [, org, repo, workflowFile] = match;
    return { kind: "workflow", org, repo, workflowFile };
}
/**
 * Matches a workflow run's own page, or one job's logs within it, e.g.
 * `/org/repo/actions/runs/123456` or `/org/repo/actions/runs/123456/job/789`.
 */
function parseRunContext(pathname) {
    const match = pathname.match(/^\/([^/]+)\/([^/]+)\/actions\/runs\/(\d+)(?:\/job\/(\d+))?/);
    if (!match)
        return null;
    const [, org, repo, runId, jobId] = match;
    return jobId ? { kind: "job", org, repo, runId, jobId } : { kind: "run", org, repo, runId };
}
/**
 * Resolves the current location into whichever jump context applies, or null
 * if none match. Order matters where two patterns overlap: the org-settings
 * runner paths before the looser repo-scoped ones, the branch-filtered Actions
 * tab before the same page unfiltered, and the two-segment repo home page last
 * of all, since its pattern is the loosest here.
 */
function resolveJumpContext(pathname, search) {
    return (parseRunnerGroupContext(pathname) ??
        parseRunnerContext(pathname) ??
        parseRunContext(pathname) ??
        parseWorkflowContext(pathname) ??
        parseBranchContext(pathname, search) ??
        parseActionsListContext(pathname) ??
        parsePrContext(pathname) ??
        parsePrListContext(pathname) ??
        parseBranchListContext(pathname) ??
        parseRepoFileContext(pathname) ??
        parseRepoTreeRootContext(pathname) ??
        parseRepoHomeContext(pathname));
}
/**
 * The GitHub web UI's own origin and API origin - always present regardless
 * of context, the same way `github.server_url`/`github.api_url` are always
 * present in a GitHub Actions workflow's `github` context. Not derived from
 * the page at all (github.com's web UI has no non-github.com origin to
 * derive), but exposed as fields anyway so a link template can build a
 * fully-qualified URL back into GitHub or its API without hardcoding either.
 */
const GITHUB_SERVER_URL = "https://github.com";
const GITHUB_API_URL = "https://api.github.com";
/**
 * All page-provided fields available for a given context, keyed the same way
 * as a link URL's `{{placeholders}}`. Only the fields the current page
 * actually carries are present - a link only shows up when every placeholder
 * it uses is one of these (see applicableLinks()).
 *
 * `repo`/`org`/`repoFullName` are included for every context scoped to a
 * single repo (everything except the org-scoped runner and runnerGroup pages),
 * not just the more specific ones, so a link that only cares about the repo
 * name can be configured on any page within that repo. `serverUrl`/`apiUrl`
 * are always present (see above) since every context is on github.com.
 *
 * For the two list pages this returns only the page-level fields; the field
 * each individual row contributes (that row's own PR number or branch name)
 * comes from rowFieldKey() instead.
 */
function contextFields(context) {
    const common = { serverUrl: GITHUB_SERVER_URL, apiUrl: GITHUB_API_URL };
    const repoFields = (repo) => ({
        repo,
        org: context.org,
        repoFullName: `${context.org}/${repo}`,
    });
    switch (context.kind) {
        // The repo home page provides the same fields whether or not its URL names a
        // ref (`/org/repo` vs `/org/repo/tree/<ref>`); that ref only decides which
        // ref its repo config is read at - see RepoHomeContext.
        case "repoHome":
        case "prList":
        case "branchList":
        case "actionsList":
            return { ...common, ...repoFields(context.repo) };
        case "repoFile":
            return { ...common, ...repoFields(context.repo), branch: context.branch };
        case "pr":
            return { ...common, ...repoFields(context.repo), prNumber: context.prNumber };
        case "branch":
            return { ...common, ...repoFields(context.repo), branch: context.branch };
        case "workflow":
            return { ...common, ...repoFields(context.repo), workflowName: context.workflowFile };
        case "run":
            return { ...common, ...repoFields(context.repo), runId: context.runId };
        case "job":
            return {
                ...common,
                ...repoFields(context.repo),
                runId: context.runId,
                jobId: context.jobId,
            };
        case "runner":
            return {
                ...common,
                ...(context.repo ? repoFields(context.repo) : { org: context.org }),
                runnerName: context.runnerId,
            };
        case "runnerGroup":
            return { ...common, org: context.org, runnerGroupName: context.groupId };
    }
}
/**
 * On a list page, the one field each row contributes on top of the page-level
 * ones - a PR list row knows its own PR number, a branch list row its own
 * branch name. Null for every other page kind, which has a single set of
 * fields for the whole page.
 */
function rowFieldKey(kind) {
    switch (kind) {
        case "prList":
            return "prNumber";
        case "branchList":
            return "branch";
        default:
            return null;
    }
}
/** Whether a page kind renders its links per row rather than once per page. */
function isListPageKind(kind) {
    return rowFieldKey(kind) !== null;
}
/**
 * Every field key a link configured for this context can reference: the fields
 * the page itself provides, plus (on a list page) the one each row provides.
 * Returned in CONTEXT_FIELD_KEYS order so it reads the same way everywhere
 * it's shown, rather than in whatever order contextFields() happens to build.
 */
function availableFieldKeys(context) {
    const fields = contextFields(context);
    const rowKey = rowFieldKey(context.kind);
    return CONTEXT_FIELD_KEYS.filter((key) => Boolean(fields[key]) || key === rowKey);
}
/**
 * A representative context for a page kind, used to answer "which fields does
 * this kind of page provide" without being on such a page - for the config
 * panel's per-page field hint and the repo config template's header comment.
 * The values are placeholders; only which keys are present is meaningful.
 */
function sampleContext(page) {
    switch (page) {
        case "repoHome":
            return { kind: "repoHome", org: "org", repo: "repo" };
        case "repoFile":
            return { kind: "repoFile", org: "org", repo: "repo", branch: "main" };
        case "pr":
            return { kind: "pr", org: "org", repo: "repo", prNumber: "1" };
        case "prList":
            return { kind: "prList", org: "org", repo: "repo" };
        case "branchList":
            return { kind: "branchList", org: "org", repo: "repo" };
        case "actionsList":
            return { kind: "actionsList", org: "org", repo: "repo" };
        case "branch":
            return { kind: "branch", org: "org", repo: "repo", branch: "main" };
        case "workflow":
            return { kind: "workflow", org: "org", repo: "repo", workflowFile: "ci.yml" };
        case "run":
            return { kind: "run", org: "org", repo: "repo", runId: "1" };
        case "job":
            return { kind: "job", org: "org", repo: "repo", runId: "1", jobId: "2" };
        case "runner":
            return { kind: "runner", scope: "repo", org: "org", repo: "repo", runnerId: "1" };
        case "runnerGroup":
            return { kind: "runnerGroup", org: "org", groupId: "1" };
    }
}
/** Which ContextFieldKey `{{placeholders}}` a template string actually references. */
function placeholderFields(template) {
    const found = new Set();
    const placeholderPattern = /\{\{(\w+)\}\}/g;
    let match;
    while ((match = placeholderPattern.exec(template))) {
        if (isContextFieldKey(match[1]))
            found.add(match[1]);
    }
    return [...found];
}
/**
 * Substitutes `{{fieldKey}}` placeholders in a URL template with values from
 * the current page (see contextFields()). A placeholder for a field this page
 * doesn't have (which shouldn't happen for a link applicableLinks() already
 * let through, but could for a stray typo) is left untouched rather than
 * silently blanked out, so a malformed URL is visibly broken instead of
 * quietly pointing somewhere wrong.
 */
function renderTemplate(template, fields) {
    return template.replace(/\{\{(\w+)\}\}/g, (whole, key) => {
        const value = isContextFieldKey(key) ? fields[key] : undefined;
        return value ?? whole;
    });
}
/**
 * Which of the links configured for this page can actually be shown - i.e.
 * every `{{placeholder}}` the link's URL uses is a field this page provides.
 * A link that needs a field the page doesn't have is left out entirely, rather
 * than linked to with a literal `{{placeholder}}` still in its URL. A link
 * using no placeholders at all is always shown: it's a fixed URL that doesn't
 * depend on the page beyond having been configured for it.
 */
function applicableLinks(config, context) {
    const available = availableFieldKeys(context);
    return linksForPage(config, context.kind).filter((link) => placeholderFields(link.url).every((key) => available.includes(key)));
}
function repoContextForJump(context) {
    switch (context.kind) {
        case "repoHome":
            // Only carries a ref when reached as `/org/repo/tree/<ref>`; the plain
            // `/org/repo` URL names none, and reads the default branch as before.
            return context.branch
                ? { org: context.org, repo: context.repo, branch: context.branch }
                : { org: context.org, repo: context.repo };
        case "pr":
        case "prList":
        case "branchList":
        case "actionsList":
        case "workflow":
        case "run":
        case "job":
            return { org: context.org, repo: context.repo };
        case "repoFile":
        case "branch":
            return { org: context.org, repo: context.repo, branch: context.branch };
        case "runner":
            return context.repo ? { org: context.org, repo: context.repo } : null;
        case "runnerGroup":
            return null;
    }
}
/**
 * Resolves which links are actually offered on a page, given the user's own
 * (personal, GM-storage) config and the current repo's checked-in config (or
 * null if there isn't one / it failed to load). The personal config wins
 * outright when it has anything applicable to this page - the repo config is a
 * fallback for contributors who haven't set up their own links yet, not
 * something merged link-by-link with the personal one, so a contributor who
 * has configured a page sees exactly what they configured there.
 */
function activeLinks(personalConfig, repoConfig, context) {
    const personal = applicableLinks(personalConfig, context);
    if (personal.length > 0)
        return personal;
    if (!repoConfig)
        return [];
    return applicableLinks(repoConfig, context);
}
/**
 * Combines a repo's existing checked-in config with the current user's own
 * config, for exporting back into the repo - unlike activeLinks() above, this
 * is a real union: the point of exporting is to publish your own links for the
 * rest of the repo, on top of whatever's already shared, not to pick one
 * source over the other. Links are deduped per page by URL, keeping the repo's
 * own copy of a URL that appears in both (its name may have been deliberately
 * reworded by someone else since you last synced).
 */
function mergeConfigsForExport(repoConfig, personalConfig) {
    const pages = [];
    for (const page of JUMP_PAGE_KINDS) {
        const repoLinks = repoConfig ? linksForPage(repoConfig, page) : [];
        const links = [...repoLinks];
        const knownUrls = new Set(links.map((link) => link.url));
        for (const link of linksForPage(personalConfig, page)) {
            if (knownUrls.has(link.url))
                continue;
            links.push(link);
            knownUrls.add(link.url);
        }
        if (links.length > 0)
            pages.push({ page, links });
    }
    return { pages };
}
function tokenizeYamlLite(text) {
    return text
        .split("\n")
        .map((line) => line.replace(/\r$/, ""))
        .filter((line) => line.trim() !== "" && !line.trim().startsWith("#"))
        .map((line) => ({
        indent: line.length - line.replace(/^ */, "").length,
        content: line.trim(),
    }));
}
function unquoteYamlLiteScalar(value) {
    const trimmed = value.trim();
    if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
        // Reverses the escaping yamlLiteScalar() applies when it double-quotes a
        // value: a backslash followed by a backslash or a double quote is that
        // literal character, unescaped. Single-quoted scalars (below) never get
        // this treatment - yamlLiteScalar() only ever produces double-quoted
        // output; single-quote support here is only for reading hand-written
        // ones, which this format has no backslash-escaping convention for.
        return trimmed.slice(1, -1).replace(/\\(["\\])/g, "$1");
    }
    if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
        return trimmed.slice(1, -1);
    }
    return trimmed;
}
function isYamlLiteSeqItem(content) {
    return content === "-" || content.startsWith("- ");
}
function parseYamlLiteMapEntry(lines, pos, indent) {
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
    if (value !== "")
        return { [key]: unquoteYamlLiteScalar(value) };
    if (pos.i < lines.length && lines[pos.i].indent > indent) {
        return { [key]: parseYamlLiteBlock(lines, pos, lines[pos.i].indent) };
    }
    // A sequence under a key is conventionally written at the *same* indent as
    // the key rather than deeper ("links:" then "- name: ..." both at indent 4),
    // which is valid YAML and the form a hand-written config is most likely to
    // use, so it's read here too. Only sequence items qualify: a sibling mapping
    // key at the same indent is the next entry in this same mapping, not a value
    // for this one.
    if (pos.i < lines.length && lines[pos.i].indent === indent && isYamlLiteSeqItem(lines[pos.i].content)) {
        return { [key]: parseYamlLiteSequence(lines, pos, indent) };
    }
    return { [key]: "" };
}
function parseYamlLiteSequence(lines, pos, indent) {
    const result = [];
    while (pos.i < lines.length && lines[pos.i].indent === indent && isYamlLiteSeqItem(lines[pos.i].content)) {
        const content = lines[pos.i].content;
        const rest = content === "-" ? "" : content.slice(2);
        if (rest === "") {
            pos.i++;
            const childIndent = pos.i < lines.length ? lines[pos.i].indent : indent;
            result.push(childIndent > indent ? parseYamlLiteBlock(lines, pos, childIndent) : "");
        }
        else if (rest.includes(":")) {
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
            const map = {
                [key]: value !== ""
                    ? unquoteYamlLiteScalar(value)
                    : pos.i < lines.length && lines[pos.i].indent > itemIndent
                        ? parseYamlLiteBlock(lines, pos, lines[pos.i].indent)
                        : "",
            };
            while (pos.i < lines.length && lines[pos.i].indent === itemIndent && !isYamlLiteSeqItem(lines[pos.i].content)) {
                Object.assign(map, parseYamlLiteMapEntry(lines, pos, itemIndent));
            }
            result.push(map);
        }
        else {
            pos.i++;
            result.push(unquoteYamlLiteScalar(rest));
        }
    }
    return result;
}
function parseYamlLiteBlock(lines, pos, indent) {
    if (pos.i >= lines.length || lines[pos.i].indent !== indent)
        return {};
    if (isYamlLiteSeqItem(lines[pos.i].content))
        return parseYamlLiteSequence(lines, pos, indent);
    const map = {};
    while (pos.i < lines.length && lines[pos.i].indent === indent && !isYamlLiteSeqItem(lines[pos.i].content)) {
        Object.assign(map, parseYamlLiteMapEntry(lines, pos, indent));
    }
    return map;
}
/** Parses the YAML subset described above into plain objects/arrays/strings. */
function parseYamlLite(text) {
    const lines = tokenizeYamlLite(text);
    if (lines.length === 0)
        return {};
    return parseYamlLiteBlock(lines, { i: 0 }, lines[0].indent);
}
/**
 * Renders a plain scalar for the YAML-lite format above, quoting only when
 * necessary - kept minimal (not general YAML-correct) since it only ever has
 * to round-trip through parseYamlLite's own unquoting logic.
 */
function yamlLiteScalar(value) {
    const needsQuoting = value === "" ||
        value !== value.trim() ||
        /^[\s\-?:,[\]{}#&*!|>'"%@`]/.test(value) ||
        /: |:$/.test(value) ||
        / #/.test(value);
    if (!needsQuoting)
        return value;
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
/** Serializes a JumpLinksConfig into the YAML-lite format parseYamlLite reads. */
function configToYamlLite(config) {
    if (config.pages.length === 0)
        return "pages: []\n";
    const lines = ["pages:"];
    for (const entry of config.pages) {
        lines.push(`  - page: ${yamlLiteScalar(entry.page)}`);
        lines.push("    links:");
        for (const link of entry.links) {
            lines.push(`      - name: ${yamlLiteScalar(link.name)}`);
            lines.push(`        url: ${yamlLiteScalar(link.url)}`);
        }
    }
    return `${lines.join("\n")}\n`;
}
// ---------------------------------------------------------------------------
// Config persistence. Wrapped so the rest of the script only ever deals with a
// JumpLinksConfig object, never the raw JSON-string storage format.
// ---------------------------------------------------------------------------
// Bumped from .v1 alongside the move to page-keyed links: a v1 value is a
// different shape entirely (a flat list of Grafana-specific dashboard/trace
// targets), which normalizeConfig() would read as an empty config rather than
// anything meaningful, so it's left in place under its old key instead of
// being read and silently discarded.
const CONFIG_STORAGE_KEY = "jumpLinksConfig.v2";
async function loadConfig() {
    const raw = await GM.getValue(CONFIG_STORAGE_KEY, "");
    if (typeof raw !== "string" || raw === "")
        return defaultConfig();
    try {
        return normalizeConfig(JSON.parse(raw));
    }
    catch {
        return defaultConfig();
    }
}
async function saveConfig(config) {
    await GM.setValue(CONFIG_STORAGE_KEY, JSON.stringify(config));
}
// ---------------------------------------------------------------------------
// Update notification. Compares the version currently running (GM.info.script
// .version, which the user's script manager has already updated in the
// background per @updateURL/@downloadURL by the time this runs) against the
// version we last recorded seeing - not against "the latest available
// version" over the network. There is nothing to poll for: if the two
// differ, the script manager already applied an update just now, and this is
// purely a local, no-network notice of that fact (mirroring cept's own
// UpdateToast, which fires after a service worker update reloads the page,
// not before one is available).
// ---------------------------------------------------------------------------
const LAST_SEEN_VERSION_KEY = "grafanaJumpLastSeenVersion.v1";
const CHANGELOG_URL = "https://github.com/nsheaps/greasemonkey-scripts/blob/main/packages/github-actions-grafana-jump/CHANGELOG.md";
/**
 * Whether `current` is a genuine update over `lastSeen`, not just this
 * script's first-ever run (an empty lastSeen, nothing stored yet) or a
 * no-op reload on the same version.
 */
function isVersionUpdate(lastSeen, current) {
    return lastSeen !== "" && lastSeen !== current;
}
/**
 * Records the currently-running version as "seen", returning the previously
 * recorded version - a toast is due iff isVersionUpdate(previous, current).
 * Always records (even on first run) so next time has something to compare
 * against.
 */
async function recordSeenVersion(current) {
    const previous = await GM.getValue(LAST_SEEN_VERSION_KEY, "");
    await GM.setValue(LAST_SEEN_VERSION_KEY, current);
    return typeof previous === "string" ? previous : "";
}
const TOAST_ID = "grafanaJumpUpdateToast";
const TOAST_AUTO_DISMISS_MS = 10000;
const TOAST_EXIT_MS = 300;
const TOAST_BASE_STYLE = "position: fixed; bottom: 1.5rem; left: 50%; z-index: 2147483647; display: flex; " +
    "align-items: center; gap: 0.75rem; padding: 0.75rem 1.25rem; border-radius: 0.5rem; " +
    "background: #1a1a2e; color: #e0e0e0; font-size: 0.875rem; " +
    "font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; " +
    "box-shadow: 0 4px 12px rgba(0,0,0,0.3); pointer-events: auto; " +
    "transition: opacity 0.3s ease, transform 0.3s ease;";
const TOAST_HIDDEN_STYLE = `${TOAST_BASE_STYLE} opacity: 0; transform: translateX(-50%) translateY(1rem);`;
const TOAST_SHOWN_STYLE = `${TOAST_BASE_STYLE} opacity: 1; transform: translateX(-50%) translateY(0);`;
/**
 * Shows a toast noting the update, linking to this package's own CHANGELOG.md
 * (generated per-release by release-it/conventional-changelog - see
 * .release-it.js - so it's already up to date for whatever version this is
 * without this script generating anything itself). Styled after cept's own
 * UpdateToast component (packages/web/src/UpdateToast.tsx): a dark, centered,
 * bottom-fixed pill that fades/slides in, then back out before removal.
 * Auto-dismisses after 10s per the same design, but this toast has no
 * "visible" prop to drive that from - the timer and the fade-out it triggers
 * are both owned here instead.
 */
function showUpdateToast(newVersion) {
    document.getElementById(TOAST_ID)?.remove();
    const toast = document.createElement("div");
    toast.id = TOAST_ID;
    toast.setAttribute("role", "status");
    toast.setAttribute("aria-live", "polite");
    toast.setAttribute("style", TOAST_HIDDEN_STYLE);
    const link = document.createElement("a");
    link.textContent = `GitHub jump links updated to v${newVersion} — see what's new`;
    link.setAttribute("href", CHANGELOG_URL);
    link.setAttribute("target", "_blank");
    link.setAttribute("rel", "noopener noreferrer");
    link.setAttribute("style", "color: inherit; text-decoration: underline;");
    toast.appendChild(link);
    let dismissTimer;
    const dismiss = () => {
        if (dismissTimer)
            clearTimeout(dismissTimer);
        toast.setAttribute("style", TOAST_HIDDEN_STYLE);
        setTimeout(() => toast.remove(), TOAST_EXIT_MS);
    };
    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.textContent = "×";
    closeButton.setAttribute("aria-label", "Dismiss notification");
    closeButton.setAttribute("style", "background: none; border: none; color: #888; cursor: pointer; font-size: 1.1rem; " +
        "line-height: 1; padding: 0 0.25rem;");
    closeButton.addEventListener("click", dismiss);
    toast.appendChild(closeButton);
    document.body.appendChild(toast);
    // Deferred a frame so the transition in TOAST_SHOWN_STYLE actually
    // animates from TOAST_HIDDEN_STYLE, rather than the browser coalescing
    // both style writes into one and skipping straight to the end state.
    requestAnimationFrame(() => toast.setAttribute("style", TOAST_SHOWN_STYLE));
    dismissTimer = setTimeout(dismiss, TOAST_AUTO_DISMISS_MS);
}
async function checkForUpdate() {
    const current = GM.info.script.version;
    const previous = await recordSeenVersion(current);
    if (isVersionUpdate(previous, current))
        showUpdateToast(current);
}
// ---------------------------------------------------------------------------
// Repo config fetching. Cross-origin (github.com -> raw.githubusercontent.com)
// requests from an injected page script are subject to GitHub's own CSP, so
// this uses GM.xmlHttpRequest (granted in meta.json, with a matching
// @connect for raw.githubusercontent.com) rather than page-context fetch() -
// GM.xmlHttpRequest is exempt from the page's CSP/CORS by design, which is
// exactly why it exists.
//
// Cached per {org, repo, ref} for the life of the tab: GitHub's pages are a
// single-page app, so navigating between pages in the same repo would
// otherwise re-fetch this on every checkLocation() call for no reason.
// ---------------------------------------------------------------------------
const REPO_CONFIG_PATH = ".github/jump-links.config.yaml";
/**
 * Which ref a repo config is read at when the page doesn't name one: the
 * default branch, via the alias raw.githubusercontent.com accepts in place of
 * a branch name. Doubles as the cache key's ref for that case, so a
 * default-branch fetch and a fetch of some specific branch for the same repo
 * are two distinct cache entries rather than one shadowing the other.
 */
const DEFAULT_BRANCH_REF = "HEAD";
function repoConfigCacheKey(org, repo, branch) {
    return `${org}/${repo}@${branch ?? DEFAULT_BRANCH_REF}`;
}
/**
 * The raw.githubusercontent.com URL a repo's config file is read from, at the
 * given branch or (when none is given) at the default branch.
 *
 * A branch name can itself contain slashes (`renovate/all-patch`), and those
 * have to stay literal slashes in the path for the ref to resolve, so the ref
 * is encoded segment by segment rather than as one component - percent-encoding
 * the separator would leave a name that no longer matches the branch. (Both
 * forms happen to resolve on raw.githubusercontent.com today, but only the
 * literal-slash form is the URL the branch actually has.)
 */
function repoConfigUrl(org, repo, branch) {
    const ref = branch
        ? branch.split("/").map(encodeURIComponent).join("/")
        : DEFAULT_BRANCH_REF;
    return (`https://raw.githubusercontent.com/${encodeURIComponent(org)}/${encodeURIComponent(repo)}` +
        `/${ref}/${REPO_CONFIG_PATH}`);
}
const repoConfigCache = new Map();
function fetchRepoConfig(org, repo, branch) {
    const key = repoConfigCacheKey(org, repo, branch);
    const cached = repoConfigCache.get(key);
    if (cached)
        return cached;
    const promise = new Promise((resolve) => {
        const url = repoConfigUrl(org, repo, branch);
        GM.xmlHttpRequest({
            method: "GET",
            url,
            onload: (response) => {
                if (response.status !== 200) {
                    resolve(null);
                    return;
                }
                try {
                    resolve(normalizeConfig(parseYamlLite(response.responseText)));
                }
                catch {
                    resolve(null);
                }
            },
            onerror: () => resolve(null),
        });
    });
    repoConfigCache.set(key, promise);
    return promise;
}
const defaultBranchCache = new Map();
/**
 * GitHub's "create/edit file" web UI is addressed by branch name, not by the
 * "HEAD" alias fetchRepoConfig() above gets to use (that alias only exists
 * for raw.githubusercontent.com content URLs) - so building a link into that
 * UI needs the actual default branch name.
 *
 * Deliberately does NOT call the `api.github.com` REST API: that's a
 * different host than github.com, so the browser's github.com session
 * cookie isn't sent along, and an unauthenticated request to it 404s for any
 * private repo (GitHub hides private-repo existence from anonymous
 * requests) - silently falling back to "main", which is wrong whenever a
 * private repo's actual default branch isn't literally that (confirmed
 * broken this way against a real private repo). Fetching the repo's own
 * `https://github.com/<org>/<repo>` page instead reuses the same
 * already-authenticated browser session the user is Browsing with (GitHub is
 * itself same-origin/same-session as the page this script runs on), and
 * every repo page embeds its `defaultBranch` in a JSON blob for its own
 * React app to read - this just reads the same value out of the response
 * text via regex rather than a full JSON parse, since which specific React
 * route embeds it (and under what surrounding JSON shape) varies page to
 * page, but the `"defaultBranch":"<name>"` substring itself does not. Falls
 * back to "main" only if that pattern isn't found at all; worst case the
 * resulting link's branch segment is wrong and GitHub's own UI surfaces
 * that, rather than anything failing silently.
 */
function resolveDefaultBranch(org, repo) {
    const key = `${org}/${repo}`;
    const cached = defaultBranchCache.get(key);
    if (cached)
        return cached;
    const promise = new Promise((resolve) => {
        GM.xmlHttpRequest({
            method: "GET",
            url: `https://github.com/${encodeURIComponent(org)}/${encodeURIComponent(repo)}`,
            onload: (response) => {
                const match = response.responseText.match(/"defaultBranch":"([^"]+)"/);
                resolve(match ? match[1] : "main");
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
function buildCreateFileUrl(org, repo, branch, path, content) {
    const params = new URLSearchParams({ filename: path, value: content });
    return `https://github.com/${org}/${repo}/new/${branch}?${params.toString()}`;
}
/**
 * The `# page: available fields` reference block that goes in a config file's
 * header comment, generated from contextFields()/rowFieldKey() rather than
 * written out by hand, so the documentation can't drift away from what the
 * code actually provides.
 */
function pageFieldsReference() {
    return JUMP_PAGE_KINDS.map((page) => `#     ${page}: ${availableFieldKeys(sampleContext(page)).join(", ")}`).join("\n");
}
const REPO_CONFIG_TEMPLATE = `# Config for the "GitHub jump links" userscript
# (https://github.com/nsheaps/greasemonkey-scripts/tree/main/packages/github-actions-grafana-jump).
# Gives every contributor to this repo the same jump links without each of
# them configuring the userscript by hand. A contributor's own personal
# config (set via the userscript's own "Set up links" panel) always takes
# priority over this file for any page it covers - this is only a fallback
# for pages nobody has personally configured.
#
# pages: one entry per kind of GitHub page, listing the links to show there.
#   A link only ever shows up on the page it's listed under.
#
#   page  - which kind of GitHub page these links belong on, one of the names
#           listed below.
#   links - name (the button's text, yours to word however you like) and url
#           (the full URL to open, with \`{{fieldKey}}\` placeholders filled in
#           from the current page). A link whose URL uses a field its page
#           doesn't provide is skipped rather than shown with a broken URL.
#
#   Page names, and the fields each one provides (named after GitHub Actions'
#   own \`github\` context, as far as a page's URL provides an equivalent
#   value):
${pageFieldsReference()}
#
#   On the two list pages (prList, branchList) the links show up once per row,
#   and prNumber/branch is that row's own PR or branch rather than the page's.
pages:
  - page: pr
    links:
      - name: CI dashboard
        url: https://grafana.example.com/d/REPLACE_WITH_UID/ci-overview?var-repo={{repoFullName}}&var-pr={{prNumber}}
  - page: job
    links:
      - name: Job trace
        url: https://grafana.example.com/explore?schemaVersion=1&orgId=1&left=%7B%22queries%22:%5B%7B%22query%22:%22%7Bresource.github.job_id%3D%5C%22{{jobId}}%5C%22%7D%22%7D%5D%7D
  - page: repoHome
    links:
      - name: Runbook
        url: https://runbooks.example.com/{{repoFullName}}
`;
// ---------------------------------------------------------------------------
// DOM injection.
//
// Most supported pages have a real GitHub toolbar to put buttons in, and the
// links go there (renderToolbarButtons()), styled with GitHub's own Primer
// button classes so they read as part of the page rather than as an
// add-on. Which element that toolbar is differs per page, and several of
// GitHub's own header elements are styled with Primer React's hashed
// CSS-module class names (e.g. "prc-TabNav-TabNavTabList-Ave63") which are not
// stable across GitHub front-end deploys - so PAGE_TOOLBAR_SELECTORS below is
// deliberately limited to selectors confirmed against the live DOM, preferring
// data-testid attributes and non-hashed class names.
//
// GitHub's pages are a single-page app, and a React header can re-render and
// discard an injected container without the URL changing at all, so placement
// is re-checked on every DOM mutation rather than only on navigation. Each
// container records what it was last filled with (CONTENT_SIGNATURE_ATTR) so an
// unchanged one is left completely untouched - otherwise re-checking would
// itself be a DOM mutation, and mutation-driven re-checking would loop.
//
// Two page kinds work differently:
//
//   - The PR list and branch list are lists of things, and a page-level button
//     couldn't say which row it meant. They get a small link per row instead,
//     revealed when that row is hovered or focused, scoped to that row's own PR
//     number or branch name - see LIST_ROW_SPECS and renderRowLinks().
//   - Pages with no known toolbar (the self-hosted runner and runner-group
//     settings pages) fall back to a single fixed-position floating button,
//     which only depends on `location` rather than any GitHub DOM shape. The
//     same fallback covers a page whose toolbar simply isn't in the DOM yet, or
//     has moved since these selectors were confirmed, so there's always some
//     way to reach the links and the config panel.
// ---------------------------------------------------------------------------
/**
 * Where each page kind's links go, confirmed against the live github.com DOM.
 * A page kind absent from this table has no known toolbar and uses the
 * floating fallback instead (see renderJumpLinks()).
 */
const PAGE_TOOLBAR_SELECTORS = {
    // The Pin / Watch / Fork / Star list in the repo header. Present with the same
    // testid and the same <ul> shape both on `/org/repo` and on the same page at a
    // ref (`/org/repo/tree/<ref>`), which is why both resolve to this one page kind
    // - and absent on a directory view below the root, which is why that one isn't
    // matched at all (both verified against the live DOM).
    repoHome: '[data-testid="repo-header-actions"]',
    // The raw/edit button group in a file's own header - a non-hashed class,
    // unlike the Primer React module classes around it.
    repoFile: ".react-blob-header-edit-and-raw-actions",
    pr: '[class^="prc-PageHeader-Actions-"]',
    // The whole Actions family shares one non-hashed class. On the Actions tab
    // and a workflow's own page this element is also what holds the run filter
    // box and its dropdowns, so appending here puts the buttons in the same row
    // as the filter, which is where they were asked for.
    actionsList: ".PageHeader-actions",
    branch: ".PageHeader-actions",
    workflow: ".PageHeader-actions",
    run: ".PageHeader-actions",
    job: ".PageHeader-actions",
};
const FLOATING_CONTAINER_ID = "jumpLinksFloatingContainer";
const TOOLBAR_CONTAINER_ID = "jumpLinksToolbarContainer";
const ROW_CONTAINER_CLASS = "jumpLinksRowContainer";
const ROW_MARKER_CLASS = "jumpLinksRow";
const ROW_STYLE_ID = "jumpLinksRowStyle";
const FLOATING_BUTTON_STYLE = "display: inline-block; background: #57606a; color: #fff; padding: 8px 12px; " +
    "border: none; border-radius: 6px; font-size: 12px; font-weight: 600; " +
    "font-family: inherit; text-decoration: none; cursor: pointer;";
const ROW_LINK_STYLE = "font-size: 12px; text-decoration: none; white-space: nowrap; padding: 0 4px;";
let currentConfig = defaultConfig();
// The current page's repo config (see the "Repo config fetching" section
// above), and the "org/repo@ref" key it belongs to - null/undefined until a
// repo config has actually been fetched (or the current context isn't scoped to
// a single repo at all, e.g. the org-scoped runner page). The ref is part of the
// key, not just the cache's, so moving between two branches of the same repo
// re-reads the config rather than keeping the first branch's copy.
let currentRepoConfig = null;
let currentRepoConfigKey;
function openConfigModal(repoCtx) {
    // Work on a deep copy so Cancel leaves the saved config untouched.
    const draft = {
        pages: currentConfig.pages.map((entry) => ({
            page: entry.page,
            links: entry.links.map((link) => ({ ...link })),
        })),
    };
    const overlay = document.createElement("div");
    overlay.setAttribute("style", "position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 2147483646; " +
        "display: flex; align-items: center; justify-content: center; font-family: sans-serif;");
    overlay.addEventListener("click", (event) => {
        if (event.target === overlay)
            document.body.removeChild(overlay);
    });
    const panel = document.createElement("div");
    panel.setAttribute("style", "background: #fff; color: #24292f; border-radius: 8px; padding: 20px; " +
        "width: 560px; max-width: 90vw; max-height: 85vh; overflow-y: auto; " +
        "box-shadow: 0 8px 24px rgba(0,0,0,0.4);");
    panel.addEventListener("click", (event) => event.stopPropagation());
    const title = document.createElement("h2");
    title.textContent = "Configure jump links";
    title.setAttribute("style", "margin: 0 0 12px; font-size: 16px;");
    panel.appendChild(title);
    const help = document.createElement("p");
    help.textContent =
        "Links are grouped by the kind of GitHub page they show up on. Each link is a name " +
            "(the button's text, yours to word however you like) and a full URL, with {{fieldKey}} " +
            "placeholders filled in from the page you're on. Each group lists the fields that page " +
            "provides; a link using a field its page doesn't provide is skipped rather than shown " +
            "with a broken URL.";
    help.setAttribute("style", "margin: 0 0 16px; font-size: 12px; color: #57606a;");
    panel.appendChild(help);
    const groupsContainer = document.createElement("div");
    panel.appendChild(groupsContainer);
    const textField = (parent, labelText, value, onInput) => {
        const wrapper = document.createElement("div");
        wrapper.setAttribute("style", "margin-bottom: 6px;");
        const label = document.createElement("label");
        label.textContent = labelText;
        label.setAttribute("style", "display: block; font-size: 11px; color: #57606a; margin-bottom: 2px;");
        const input = document.createElement("input");
        input.type = "text";
        input.value = value;
        input.setAttribute("style", "display: block; width: 100%; box-sizing: border-box; padding: 4px 6px; " +
            "font-size: 12px; border: 1px solid #d0d7de; border-radius: 4px; " +
            // Explicit background/color: without these, browsers apply their own
            // dark-mode default styling to unstyled inputs, which can pair a dark
            // input background with dark text from this panel's own color rules
            // and make it unreadable. The whole modal is intentionally
            // light-themed regardless of the page's color scheme, so its inputs
            // need to match.
            "background: #fff; color: #24292f;");
        input.addEventListener("input", () => onInput(input.value));
        wrapper.appendChild(label);
        wrapper.appendChild(input);
        parent.appendChild(wrapper);
    };
    const renderGroups = () => {
        groupsContainer.innerHTML = "";
        for (const entry of draft.pages) {
            const group = document.createElement("div");
            group.setAttribute("style", "border: 1px solid #d0d7de; border-radius: 6px; padding: 10px; margin-bottom: 12px;");
            const heading = document.createElement("div");
            heading.textContent = JUMP_PAGE_LABELS[entry.page];
            heading.setAttribute("style", "font-size: 12px; font-weight: 600;");
            group.appendChild(heading);
            const fieldsHint = document.createElement("div");
            fieldsHint.textContent = `Fields: ${availableFieldKeys(sampleContext(entry.page))
                .map((key) => `{{${key}}}`)
                .join(" ")}`;
            fieldsHint.setAttribute("style", "font-size: 11px; color: #57606a; margin: 2px 0 8px;");
            group.appendChild(fieldsHint);
            entry.links.forEach((link, linkIndex) => {
                const row = document.createElement("div");
                row.setAttribute("style", "border-top: 1px solid #eaeef2; padding-top: 8px; margin-top: 8px; position: relative;");
                const removeButton = document.createElement("button");
                removeButton.type = "button";
                removeButton.textContent = "Remove";
                removeButton.setAttribute("style", "position: absolute; top: 8px; right: 0; background: none; border: none; " +
                    "color: #cf222e; font-size: 11px; cursor: pointer;");
                removeButton.addEventListener("click", () => {
                    entry.links.splice(linkIndex, 1);
                    if (entry.links.length === 0) {
                        draft.pages = draft.pages.filter((candidate) => candidate !== entry);
                    }
                    renderGroups();
                });
                row.appendChild(removeButton);
                textField(row, "Link text", link.name, (value) => {
                    link.name = value;
                });
                textField(row, "URL", link.url, (value) => {
                    link.url = value;
                });
                group.appendChild(row);
            });
            const addLinkButton = document.createElement("button");
            addLinkButton.type = "button";
            addLinkButton.textContent = "+ Add another link here";
            addLinkButton.setAttribute("style", "display: block; width: 100%; padding: 6px; margin-top: 10px; " +
                "background: #f6f8fa; border: 1px dashed #d0d7de; border-radius: 6px; " +
                "font-size: 11px; cursor: pointer;");
            addLinkButton.addEventListener("click", () => {
                entry.links.push({ name: "", url: "" });
                renderGroups();
            });
            group.appendChild(addLinkButton);
            groupsContainer.appendChild(group);
        }
    };
    renderGroups();
    const addRow = document.createElement("div");
    addRow.setAttribute("style", "display: flex; gap: 8px; margin-bottom: 16px;");
    const pageSelect = document.createElement("select");
    pageSelect.setAttribute("style", "flex: 1; padding: 6px 8px; font-size: 12px; border: 1px solid #d0d7de; " +
        "border-radius: 6px; background: #fff; color: #24292f;");
    for (const page of JUMP_PAGE_KINDS) {
        const option = document.createElement("option");
        option.value = page;
        option.textContent = JUMP_PAGE_LABELS[page];
        pageSelect.appendChild(option);
    }
    addRow.appendChild(pageSelect);
    const addPageButton = document.createElement("button");
    addPageButton.type = "button";
    addPageButton.textContent = "+ Add a link for this page";
    addPageButton.setAttribute("style", "padding: 6px 12px; background: #f6f8fa; border: 1px dashed #d0d7de; " +
        "border-radius: 6px; font-size: 12px; cursor: pointer;");
    addPageButton.addEventListener("click", () => {
        const page = pageSelect.value;
        if (!isJumpPageKind(page))
            return;
        const existing = draft.pages.find((entry) => entry.page === page);
        if (existing) {
            existing.links.push({ name: "", url: "" });
        }
        else {
            draft.pages.push({ page, links: [{ name: "", url: "" }] });
            // Kept in the canonical page order rather than the order groups happened
            // to be added in, matching what normalizeConfig() will persist.
            draft.pages.sort((a, b) => JUMP_PAGE_KINDS.indexOf(a.page) - JUMP_PAGE_KINDS.indexOf(b.page));
        }
        renderGroups();
    });
    addRow.appendChild(addPageButton);
    panel.appendChild(addRow);
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
        const secondaryButtonStyle = "flex: 1; padding: 6px 10px; font-size: 11px; border-radius: 6px; border: 1px solid #d0d7de; " +
            "background: #f6f8fa; color: #24292f; cursor: pointer;";
        const openCreateFileTab = (content) => {
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
            // just added a link, Save first so the export includes it.
            const exportButton = document.createElement("button");
            exportButton.type = "button";
            exportButton.textContent = "⬆️ Export my links to repo";
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
    cancelButton.setAttribute("style", "padding: 6px 14px; font-size: 12px; border-radius: 6px; border: 1px solid #d0d7de; " +
        "background: #fff; cursor: pointer;");
    cancelButton.addEventListener("click", () => document.body.removeChild(overlay));
    actions.appendChild(cancelButton);
    const saveButton = document.createElement("button");
    saveButton.type = "button";
    saveButton.textContent = "Save";
    saveButton.setAttribute("style", "padding: 6px 14px; font-size: 12px; border-radius: 6px; border: none; " +
        "background: #1f883d; color: #fff; cursor: pointer;");
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
/**
 * Applies this script's look for the given placement - GitHub's own Primer
 * utility classes when sitting among GitHub's real toolbar buttons (the same
 * classes github-to-graphite-button uses, so these match GitHub's own buttons
 * rather than standing out), or a plain custom style when floating free of any
 * GitHub styling context.
 */
function styleJumpButton(el, variant) {
    if (variant === "toolbar") {
        el.setAttribute("class", "Button--secondary Button--small Button");
        return;
    }
    el.setAttribute("style", FLOATING_BUTTON_STYLE);
}
/**
 * Records what a container was last filled with, so an unchanged container can
 * be left alone. This matters beyond saving work: containers are re-checked on
 * every DOM mutation (see checkLocation()), so rewriting one when nothing
 * changed would trigger another mutation and loop.
 */
const CONTENT_SIGNATURE_ATTR = "data-jump-links-content";
/**
 * Fills a container (the floating button's own div, or a wrapper dropped into
 * one of GitHub's toolbars) with one button per applicable link, plus a gear
 * button to open the config panel - shared between the two placements so they
 * can't drift out of sync on behavior, only on styling. A no-op if the
 * container already holds exactly this content.
 */
function populateJumpContainer(container, context, links, variant) {
    const fields = contextFields(context);
    const signature = JSON.stringify([variant, fields, links]);
    if (container.getAttribute(CONTENT_SIGNATURE_ATTR) === signature)
        return;
    container.setAttribute(CONTENT_SIGNATURE_ATTR, signature);
    container.innerHTML = "";
    if (links.length === 0) {
        const setupButton = document.createElement("button");
        setupButton.type = "button";
        setupButton.textContent = "⚙️ Set up links";
        styleJumpButton(setupButton, variant);
        setupButton.addEventListener("click", (event) => {
            event.stopPropagation();
            openConfigModal(repoContextForJump(context));
        });
        container.appendChild(setupButton);
        return;
    }
    for (const link of links) {
        const anchor = document.createElement("a");
        anchor.setAttribute("href", renderTemplate(link.url, fields));
        anchor.setAttribute("target", "_blank");
        anchor.setAttribute("rel", "noopener noreferrer");
        anchor.textContent = `${linkDisplayName(link)} ↗️`;
        styleJumpButton(anchor, variant);
        container.appendChild(anchor);
    }
    const editButton = document.createElement("button");
    editButton.type = "button";
    editButton.textContent = "⚙️";
    editButton.setAttribute("aria-label", "Edit jump links");
    editButton.setAttribute("title", "Edit jump links");
    styleJumpButton(editButton, variant);
    editButton.addEventListener("click", (event) => {
        event.stopPropagation();
        openConfigModal(repoContextForJump(context));
    });
    container.appendChild(editButton);
}
/**
 * Injects the links into GitHub's own toolbar for this page kind. Returns
 * whether it actually placed something there; false (no known toolbar for this
 * page kind, or the toolbar hasn't rendered into the DOM yet on this pass)
 * means the caller falls back to the floating button instead.
 */
function renderToolbarButtons(context, links) {
    const selector = PAGE_TOOLBAR_SELECTORS[context.kind];
    if (!selector)
        return false;
    const toolbar = document.querySelector(selector);
    if (!toolbar)
        return false;
    // Some of these toolbars are lists (the repo home page's is a <ul> of Pin /
    // Watch / Fork buttons), so the wrapper has to be a list item there to keep
    // the markup valid and pick up the list's own spacing.
    const wrapperTag = toolbar.tagName === "UL" || toolbar.tagName === "OL" ? "li" : "span";
    const existing = document.getElementById(TOOLBAR_CONTAINER_ID);
    // Reused only if it's still the right element in the right place - a wrapper
    // left over from a different page kind, or one GitHub has since re-rendered
    // out of its toolbar, is replaced rather than moved.
    const reusable = existing && existing.tagName.toLowerCase() === wrapperTag && existing.parentElement === toolbar
        ? existing
        : null;
    if (!reusable)
        existing?.remove();
    const container = reusable ?? document.createElement(wrapperTag);
    container.id = TOOLBAR_CONTAINER_ID;
    container.setAttribute("style", "display: inline-flex; align-items: center; gap: 4px; margin-left: 8px;");
    populateJumpContainer(container, context, links, "toolbar");
    if (!reusable)
        toolbar.appendChild(container);
    return true;
}
const LIST_ROW_SPECS = {
    prList: {
        rowSelector: "div.js-issue-row[id^='issue_']",
        fieldValue: (row) => {
            const number = row.id.replace(/^issue_/, "");
            return /^\d+$/.test(number) ? number : null;
        },
        // The row's right-hand meta cell (assignees, comment count), which is
        // already right-aligned; the title cell is the fallback for a narrow
        // layout where GitHub drops that cell entirely.
        slot: (row) => row.querySelector(":scope > div > div.text-right") ??
            row.querySelector(":scope > div > div.flex-auto"),
        position: "start",
    },
    branchList: {
        rowSelector: "tr",
        fieldValue: (row) => {
            const href = row.querySelector("a[href*='/tree/']")?.getAttribute("href");
            if (!href)
                return null;
            const match = href.match(/^\/[^/]+\/[^/]+\/tree\/(.+)$/);
            return match ? decodeURIComponent(match[1]) : null;
        },
        // The branch-name cell, right after GitHub's own copy-branch-name button.
        // The row's action cell (delete branch, branch menu) would be the obvious
        // home, but it's a ~70px cell at the far right of a table that already
        // overflows its horizontal scroller, so anything added there lands
        // off-screen; the branch-name cell has room to spare and is always visible.
        slot: (row) => row.querySelector("a[href*='/tree/']")?.closest("td") ?? null,
        position: "end",
    },
};
/**
 * Reveals a row's links only while that row is hovered or keyboard-focused,
 * the same mechanism Primer uses for its own trailing row actions
 * (`.ActionListItem--trailingActionHover:is(:hover, :focus-within)
 * .ActionListItem-trailingAction`). Fading rather than hiding keeps the links
 * in the tab order, so they're reachable by keyboard - at which point
 * :focus-within makes them visible.
 */
function ensureRowStyle() {
    if (document.getElementById(ROW_STYLE_ID))
        return;
    const style = document.createElement("style");
    style.id = ROW_STYLE_ID;
    style.textContent =
        `.${ROW_CONTAINER_CLASS} { display: inline-flex; align-items: center; gap: 4px; ` +
            "opacity: 0; transition: opacity 80ms ease-in; }" +
            `\n:is(.${ROW_MARKER_CLASS}:hover, .${ROW_MARKER_CLASS}:focus-within) .${ROW_CONTAINER_CLASS} { opacity: 1; }`;
    document.head.appendChild(style);
}
function removeRowLinks() {
    for (const container of document.querySelectorAll(`.${ROW_CONTAINER_CLASS}`))
        container.remove();
    for (const row of document.querySelectorAll(`.${ROW_MARKER_CLASS}`)) {
        row.classList.remove(ROW_MARKER_CLASS);
    }
}
// The links currently rendered into list rows, so an unchanged set can be left
// alone. This matters beyond saving work: rows are re-rendered on every DOM
// mutation (see checkLocation()), so touching the DOM when nothing changed
// would trigger another mutation and loop.
let renderedRowSignature;
function renderRowLinks(context, links) {
    const spec = LIST_ROW_SPECS[context.kind];
    const rowKey = rowFieldKey(context.kind);
    if (!spec || !rowKey)
        return;
    const signature = JSON.stringify(links);
    if (signature !== renderedRowSignature) {
        removeRowLinks();
        renderedRowSignature = signature;
    }
    ensureRowStyle();
    const pageFields = contextFields(context);
    for (const row of document.querySelectorAll(spec.rowSelector)) {
        if (row.querySelector(`.${ROW_CONTAINER_CLASS}`))
            continue;
        const value = spec.fieldValue(row);
        if (value === null)
            continue;
        const slot = spec.slot(row);
        if (!slot)
            continue;
        const fields = { ...pageFields };
        fields[rowKey] = value;
        const container = document.createElement("span");
        container.className = ROW_CONTAINER_CLASS;
        for (const link of links) {
            const anchor = document.createElement("a");
            anchor.setAttribute("href", renderTemplate(link.url, fields));
            anchor.setAttribute("target", "_blank");
            anchor.setAttribute("rel", "noopener noreferrer");
            anchor.setAttribute("class", "Link--secondary");
            anchor.setAttribute("style", ROW_LINK_STYLE);
            anchor.textContent = `${linkDisplayName(link)} ↗️`;
            container.appendChild(anchor);
        }
        row.classList.add(ROW_MARKER_CLASS);
        if (spec.position === "end")
            slot.appendChild(container);
        else
            slot.insertBefore(container, slot.firstChild);
    }
}
/**
 * Renders this page's links wherever they belong - per row on a list page, in
 * GitHub's own toolbar where there is one, else as the floating fallback.
 * Returns whether this needs re-running on a later DOM mutation: true on a
 * list page (rows mount, paginate, and re-render as you use the page) and for
 * a toolbar that hasn't rendered into the DOM yet, in which case the floating
 * button also shows as a visible stand-in for that gap rather than nothing.
 */
function renderJumpLinks(context) {
    const floating = document.getElementById(FLOATING_CONTAINER_ID);
    if (!context) {
        floating?.remove();
        document.getElementById(TOOLBAR_CONTAINER_ID)?.remove();
        removeRowLinks();
        renderedRowSignature = undefined;
        return false;
    }
    const links = activeLinks(currentConfig, currentRepoConfig, context);
    if (isListPageKind(context.kind) && links.length > 0) {
        document.getElementById(TOOLBAR_CONTAINER_ID)?.remove();
        floating?.remove();
        renderRowLinks(context, links);
        return true;
    }
    removeRowLinks();
    renderedRowSignature = undefined;
    if (renderToolbarButtons(context, links)) {
        // Placed in GitHub's own toolbar - no floating button needed too. Still
        // worth re-checking on later mutations: GitHub's React header can
        // re-render and throw the container away without the URL changing, and
        // then it has to go back in (confirmed happening on a workflow run page).
        floating?.remove();
        return true;
    }
    document.getElementById(TOOLBAR_CONTAINER_ID)?.remove();
    const container = floating ?? document.createElement("div");
    container.id = FLOATING_CONTAINER_ID;
    container.setAttribute("style", "position: fixed; bottom: 16px; right: 16px; z-index: 2147483647; " +
        "display: flex; align-items: center; gap: 4px;");
    populateJumpContainer(container, context, links, "floating");
    if (!floating) {
        document.body.appendChild(container);
    }
    // Keep watching only if this page kind is supposed to have a toolbar; a page
    // with none is done as soon as the floating button is up.
    return Boolean(PAGE_TOOLBAR_SELECTORS[context.kind]) || isListPageKind(context.kind);
}
// ---------------------------------------------------------------------------
// Which ref a workflow run ran on. Unlike every other page kind, a run's URL
// (`/actions/runs/<id>`) says nothing about its ref, so the only place to read
// it is the run page's own DOM - which means this can't live with the pure
// context parsing above.
//
// The run summary header states what triggered the run, and the branch there is
// a link to that branch's tree, confirmed against the live github.com DOM:
//
//   <div class="d-flex flex-wrap col-triggered-content ...">
//     <a class="Link--primary ..." href="/apps/renovate">renovate[bot]</a>
//     <div ...>opened #50</div>
//     <a class="d-inline-block branch-name css-truncate css-truncate-target"
//        href="/nsheaps/greasemonkey-scripts/tree/refs/heads/renovate/all-patch"
//        >renovate/all-patch</a>
//   </div>
//
// Both classes used to find it are GitHub's own non-hashed ones on a
// server-rendered (not Primer React) part of the page, and the ref is taken from
// the link's href rather than its text, which is truncated for display.
//
// A run triggered by a pull request resolves to the PR's head branch, which is
// the same link in the same place (verified on a real PR-triggered run) - that
// is the branch whose config file you'd be editing to try a change out, so it's
// the useful answer rather than a case to skip. A cross-repo (fork) PR's head
// branch doesn't exist in the repo being browsed, so the href's own repo has to
// match this page's before its ref is used; when it doesn't, there's no
// override and the config comes from the default branch as before.
//
// Job pages have no such element anywhere in their DOM - checked both on a
// direct load and after navigating into a job from its run page - so a job page
// never gets an override and reads its config from the default branch. That's
// the same safe fallback as any run page whose header hasn't rendered yet:
// better a stale-but-real config than a guessed ref.
// ---------------------------------------------------------------------------
const RUN_BRANCH_SELECTOR = ".col-triggered-content a.branch-name";
/**
 * The branch name a run header's branch link points at, or null if that href
 * isn't a branch in the given repo. Handles both forms GitHub writes: the fully
 * qualified `refs/heads/<branch>` this link currently uses, and a bare
 * `<branch>`. A ref in any other namespace (`refs/tags/...`) is not a branch and
 * is rejected rather than fetched as one.
 */
function branchFromRunTreeHref(href, org, repo) {
    const match = href.match(/^\/([^/]+)\/([^/]+)\/tree\/(.+)$/);
    if (!match)
        return null;
    const [, hrefOrg, hrefRepo, rawRef] = match;
    // GitHub treats owner and repo names case-insensitively, and the href is
    // whatever casing GitHub rendered, which needn't match the URL's.
    if (hrefOrg.toLowerCase() !== org.toLowerCase())
        return null;
    if (hrefRepo.toLowerCase() !== repo.toLowerCase())
        return null;
    const ref = decodeURIComponent(rawRef);
    if (ref.startsWith("refs/heads/")) {
        const branch = ref.slice("refs/heads/".length);
        return branch === "" ? null : branch;
    }
    // Stripped to the bare branch name rather than kept qualified so a run page
    // and the branch-filtered Actions tab for the same branch share one cache
    // entry (see repoConfigCacheKey()).
    if (ref.startsWith("refs/"))
        return null;
    return ref;
}
/**
 * The branch a run/job page's run ran on, read from the live DOM, or undefined
 * if this isn't such a page or the branch can't be determined from it. Called
 * on every checkLocation() pass rather than awaited once, so a header that
 * hasn't rendered yet is simply picked up on a later DOM mutation - the same way
 * renderToolbarButtons() handles a toolbar that isn't in the DOM yet.
 */
function scrapeRunBranch(context) {
    if (context.kind !== "run" && context.kind !== "job")
        return undefined;
    const href = document.querySelector(RUN_BRANCH_SELECTOR)?.getAttribute("href");
    if (!href)
        return undefined;
    return branchFromRunTreeHref(href, context.org, context.repo) ?? undefined;
}
// ---------------------------------------------------------------------------
// Which ref a code-browsing page is actually at. Neither
// `/org/repo/blob/<ref>/<path>` nor `/org/repo/tree/<ref>` marks where the ref
// ends, so a ref containing a slash makes both URL shapes genuinely ambiguous:
// `/blob/nate-ai/generic-grafana-jump/README.md` is equally readable as branch
// `nate-ai` + path `generic-grafana-jump/README.md` or branch
// `nate-ai/generic-grafana-jump` + path `README.md`, and
// `/tree/renovate/all-patch` as the repo root at branch `renovate/all-patch` or
// directory `all-patch` at branch `renovate`. Only the repo's real ref list
// settles either, which is why the pure parsers can't: parseRepoFileContext()
// takes the first segment, right on any ref without a slash and truncated on one
// with, and parseRepoTreeRootContext() only reads the single-segment form at all.
//
// GitHub has already done that resolution to render the page, and states the
// answer twice in the page's own DOM - the same two places on a file view and on
// a repo tree page (all confirmed against live github.com, on a hard load and
// after a soft navigation that switched refs, including the branch-selector
// switch from the repo home page that lands on `/tree/<ref>`; both are
// re-rendered by GitHub's client-side router, so neither goes stale):
//
//   <button id="ref-picker-repos-header-ref-selector"
//           aria-label="nate-ai/generic-grafana-jump branch" ...>
//   <script type="application/json" data-target="react-app.embeddedData">
//     ... "refInfo":{"name":"nate-ai/generic-grafana-jump", ...} ...
//
// So the ref is read from the page rather than reconstructed from a ref list
// fetched over the network. That is GitHub's own answer for this exact URL, it
// costs no requests (so there's nothing to rate-limit and nothing to cache), and
// it works the same on a private repo - whereas api.github.com is a different
// host that the browser's github.com session cookie isn't sent to, so listing a
// private repo's branches there 404s anonymously, the same trap documented on
// resolveDefaultBranch() above.
//
// Whichever source answers, the value is only trusted if it's a valid reading of
// the URL on screen (see refMatchesBlobPath() and refMatchesTreeRootPath()), so a
// value belonging to some other page can't win. When neither source answers -
// GitHub changes this markup, or it hasn't rendered yet - there's no override: a
// file view keeps its truncated first-segment reading, and an ambiguous
// `/tree/<a>/<b>` URL stays unmatched rather than being guessed at as either a
// slashed ref or a directory. Nothing here guesses a ref.
// ---------------------------------------------------------------------------
const REF_PICKER_SELECTOR = "#ref-picker-repos-header-ref-selector";
const EMBEDDED_DATA_SELECTOR = 'script[type="application/json"][data-target="react-app.embeddedData"]';
/**
 * The ref name out of the ref-picker button's `aria-label`, which reads
 * `<full ref name> branch` (or `... tag`), or null if the label isn't in
 * that shape. Read from the label rather than the button's text because the text
 * is truncated for display. The name is matched greedily so a ref literally
 * named `something branch` still yields the whole name.
 */
function refNameFromRefSelectorLabel(label) {
    const match = label.match(/^(.+) (?:branch|tag)$/);
    return match ? match[1] : null;
}
/**
 * The ref name out of the page's embedded React payload, or null if it isn't in
 * there. Matched by regex rather than parsed as JSON and walked, because
 * `refInfo` sits under whichever route key the payload happens to be built
 * around (`payload.codeViewBlobLayoutRoute.refInfo` and
 * `payload.codeViewLayoutRoute.refInfo` both carry it today) - the same reason
 * resolveDefaultBranch() regexes for `defaultBranch`. A ref name can contain
 * characters JSON escapes, so escape sequences are consumed as part of the value
 * and then decoded, rather than the value being cut short at the first
 * backslash.
 */
function refNameFromEmbeddedData(payloadText) {
    const match = payloadText.match(/"refInfo":\{"name":"((?:[^"\\]|\\.)*)"/);
    if (!match)
        return null;
    try {
        return JSON.parse(`"${match[1]}"`);
    }
    catch {
        return null;
    }
}
/**
 * Whether `ref` is a valid reading of a file view's URL - i.e. some leading run
 * of the `/`-separated segments after `/blob/`, decoded and rejoined, is exactly
 * `ref`, with at least one segment left over to be the file path. Returns the
 * ref when it is and null when it isn't.
 *
 * How many segments the ref takes up isn't known ahead of time - that's the
 * whole ambiguity - so every possible split is tried. A slash inside the ref can
 * also arrive percent-encoded within a single segment (`/blob/my%2Fbranch/...`,
 * which parseRepoFileContext() already reads correctly) rather than as a literal
 * separator, so one segment can contribute more than one part of the name and
 * the comparison is on the rejoined name rather than segment by segment.
 *
 * This is what makes reading the ref out of the DOM safe: a value that doesn't
 * describe the URL on screen is rejected instead of used. That covers a scraped
 * value going stale (GitHub re-rendering late during a soft navigation) and the
 * short-commit-SHA case, where the picker shows an abbreviated SHA that isn't
 * the full one the URL carries - in both cases there's no override and the
 * first-segment reading stands, which for a SHA URL is already the whole ref.
 */
function refMatchesBlobPath(pathname, ref) {
    const match = pathname.match(/^\/[^/]+\/[^/]+\/blob\/(.+)$/);
    if (!match)
        return null;
    const encodedSegments = match[1].split("/");
    // A segment contributes at least one `/`-separated part of the name, so the ref
    // can't span more segments than it has parts, and the last segment is always
    // the file path rather than any part of the ref.
    const maxSegments = Math.min(ref.split("/").length, encodedSegments.length - 1);
    for (let count = 1; count <= maxSegments; count++) {
        let candidate;
        try {
            candidate = encodedSegments.slice(0, count).map(decodeURIComponent).join("/");
        }
        catch {
            // A malformed percent-escape can't be compared against a ref name; treat it
            // as no match rather than letting decodeURIComponent throw out of here.
            return null;
        }
        if (candidate === ref)
            return ref;
    }
    return null;
}
/**
 * Whether `ref` is a valid reading of a repo tree page's URL - i.e. everything
 * after `/tree/`, decoded and rejoined, is exactly `ref` with nothing left over.
 * Returns the ref when it is and null when it isn't.
 *
 * Simpler than refMatchesBlobPath() because there's no path to leave room for:
 * this only ever answers "is this URL the repo root at `ref`", and a leftover
 * segment means it's a directory below the root instead - a page this script
 * doesn't handle, so it must not match. A trailing slash is ignored, and (as on a
 * file view) a slash inside the ref can arrive percent-encoded within one segment
 * rather than as a literal separator, so the comparison is on the decoded,
 * rejoined name.
 */
function refMatchesTreeRootPath(pathname, ref) {
    const match = pathname.match(/^\/[^/]+\/[^/]+\/tree\/(.+?)\/?$/);
    if (!match)
        return null;
    let candidate;
    try {
        candidate = match[1].split("/").map(decodeURIComponent).join("/");
    }
    catch {
        // A malformed percent-escape can't be compared against a ref name; treat it
        // as no match rather than letting decodeURIComponent throw out of here.
        return null;
    }
    return candidate === ref ? ref : null;
}
/**
 * Both refs the current page's own DOM states, in the order they're tried. Every
 * caller tries them all in turn rather than only the first one with a value, so a
 * source that answers with something that doesn't match the URL can't shadow one
 * that answers correctly.
 */
function domRefCandidates() {
    const label = document.querySelector(REF_PICKER_SELECTOR)?.getAttribute("aria-label");
    const embedded = document.querySelector(EMBEDDED_DATA_SELECTOR)?.textContent;
    return [
        label ? refNameFromRefSelectorLabel(label) : null,
        embedded ? refNameFromEmbeddedData(embedded) : null,
    ];
}
/**
 * The ref a file view is at, read from the live DOM, or undefined if this isn't
 * a file view or neither DOM source gives a ref that matches the URL. Like
 * scrapeRunBranch(), called on every checkLocation() pass rather than awaited
 * once, so an element that hasn't rendered yet is simply picked up on a later
 * DOM mutation.
 */
function scrapeBlobRef(context, pathname) {
    if (context.kind !== "repoFile")
        return undefined;
    for (const candidate of domRefCandidates()) {
        if (!candidate)
            continue;
        const ref = refMatchesBlobPath(pathname, candidate);
        if (ref)
            return ref;
    }
    return undefined;
}
/**
 * The repo home context a `/tree/<ref>` URL resolves to when its ref spans more
 * than one path segment, which parseRepoTreeRootContext() can't read on its own -
 * or null when the page's own DOM doesn't say a ref that accounts for the whole
 * URL, which is exactly the case where the URL is a directory below the root
 * rather than the root at a slashed ref.
 *
 * Unlike scrapeBlobRef()/scrapeRunBranch(), which only correct the ref of a
 * context that already matched, this decides whether there's a context at all -
 * so it's consulted only after the pure resolution has come up empty (see
 * resolveJumpContextFromPage()), never in a position to reinterpret a page that
 * already matched on its URL alone.
 */
function scrapeRepoTreeRootContext(pathname) {
    const match = pathname.match(/^\/([^/]+)\/([^/]+)\/tree\/.+$/);
    if (!match)
        return null;
    const [, org, repo] = match;
    for (const candidate of domRefCandidates()) {
        if (!candidate)
            continue;
        const ref = refMatchesTreeRootPath(pathname, candidate);
        if (ref)
            return { kind: "repoHome", org, repo, branch: ref };
    }
    return null;
}
/**
 * The current page's jump context, including the one reading of a URL that needs
 * the DOM to settle: a repo root at a ref containing a slash, which no reading of
 * the URL alone can tell apart from a directory view (see
 * scrapeRepoTreeRootContext()).
 */
function resolveJumpContextFromPage(pathname, search) {
    return resolveJumpContext(pathname, search) ?? scrapeRepoTreeRootContext(pathname);
}
/**
 * Whether this URL could still turn out to be a repo root at a slashed ref once
 * the DOM says which ref it's at - i.e. the ambiguous multi-segment `/tree/`
 * shape. Keeps checkLocation() re-checking on later DOM mutations instead of
 * settling on "no context here" from a first pass that ran before GitHub's header
 * had rendered. A URL that really is a directory view keeps being re-checked and
 * keeps not matching, which costs two querySelectors per mutation and no DOM
 * writes.
 */
function mayBeUnresolvedTreeRoot(pathname) {
    return /^\/[^/]+\/[^/]+\/tree\/[^/]+\/.+$/.test(pathname);
}
/**
 * Where to read the current page's repo config from - the ref its own URL names
 * (see repoContextForJump()), corrected by whichever ref the page's own DOM
 * carries: a run page's branch link, or a file view's resolved ref.
 */
function repoConfigTarget(context, pathname) {
    const target = repoContextForJump(context);
    if (!target)
        return null;
    const domRef = scrapeRunBranch(context) ?? scrapeBlobRef(context, pathname);
    return domRef ? { ...target, branch: domRef } : target;
}
let lastLocationKey;
// True while the current page still needs re-rendering on DOM mutations - see
// renderJumpLinks()'s return value. Keeps checkLocation() re-rendering on
// every subsequent DOM mutation (instead of only on a pathname/search change)
// until the toolbar lands, and for the whole time a list page is open.
let renderPending = false;
function checkLocation(force = false) {
    const { pathname, search } = window.location;
    const locationKey = `${pathname}${search}`;
    const locationChanged = force || locationKey !== lastLocationKey;
    if (!locationChanged && !renderPending)
        return;
    lastLocationKey = locationKey;
    const context = resolveJumpContextFromPage(pathname, search);
    renderPending =
        renderJumpLinks(context) || (context === null && mayBeUnresolvedTreeRoot(pathname));
    // Deliberately not gated on locationChanged: on a run page, and on a file view
    // at a ref containing a slash, the ref comes out of the DOM (see
    // repoConfigTarget()), which may only have rendered by a later mutation-driven
    // pass, at which point the config has to be re-read at that ref even though
    // the URL never changed. Every pass that resolves the same target as last time
    // stops at the key check just below, so re-checking here costs nothing.
    const repoCtx = context ? repoConfigTarget(context, pathname) : null;
    const repoKey = repoCtx ? repoConfigCacheKey(repoCtx.org, repoCtx.repo, repoCtx.branch) : undefined;
    if (repoKey === currentRepoConfigKey)
        return;
    currentRepoConfigKey = repoKey;
    currentRepoConfig = null;
    if (repoCtx) {
        void fetchRepoConfig(repoCtx.org, repoCtx.repo, repoCtx.branch).then((config) => {
            // Guard against a slow response landing after the user has already
            // navigated to a different repo (or one with no repo context at all).
            if (currentRepoConfigKey !== repoKey)
                return;
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
        void checkForUpdate();
    })();
}
// ---------------------------------------------------------------------------
// Test-only export hook. `module` is a variable Node's CommonJS loader injects
// into every required file's scope (e.g. when test/jump-links.test.js
// `require()`s the compiled dist/index.js) - it does not exist in a browser
// script context, so `typeof module !== "undefined"` is false there and this
// is a no-op, never risking a ReferenceError on github.com. The `NodeModule`
// type for `module` itself comes from @types/node, already pulled in
// transitively via @types/greasemonkey; no explicit `declare` needed here.
// ---------------------------------------------------------------------------
if (typeof module !== "undefined" && module.exports) {
    module.exports = {
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
        branchFromRunTreeHref,
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
    };
}
//# sourceMappingURL=index.js.map