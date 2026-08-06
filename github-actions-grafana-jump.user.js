// ==UserScript==
// @name        GitHub Actions => Grafana jump button
// @version     0.2.3
// @description Add a button on github.com Actions pages (PR checks, branch-filtered runs, a single workflow's runs, and runner detail pages) that jumps to a matching Grafana drill-down dashboard you configure yourself
// @author      Nathan Heaps
// @namespace   https://www.github.com
// @match       http*://www.github.com/*
// @match       http*://github.com/*
// @run-at      document-start
// @icon        data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==
// @grant       GM.setValue
// @grant       GM.getValue
// @license     MIT
// @downloadURL https://github.com/nsheaps/greasemonkey-scripts/releases/latest/download/github-actions-grafana-jump.user.js
// @updateURL   https://github.com/nsheaps/greasemonkey-scripts/releases/latest/download/github-actions-grafana-jump.user.js
// ==/UserScript==
"use strict";
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
function defaultConfig() {
    return { baseUrl: "", dashboards: [] };
}
/**
 * Defensively reshapes a value loaded from storage (or pasted/hand-edited) into
 * a well-formed GrafanaJumpConfig, dropping anything malformed rather than
 * throwing. Keeps the rest of the script free of null/undefined-shape checks.
 */
function normalizeConfig(raw) {
    if (typeof raw !== "object" || raw === null)
        return defaultConfig();
    const obj = raw;
    const baseUrl = typeof obj.baseUrl === "string" ? obj.baseUrl.trim() : "";
    const dashboardsRaw = Array.isArray(obj.dashboards) ? obj.dashboards : [];
    const dashboards = dashboardsRaw
        .filter((d) => typeof d === "object" && d !== null)
        .map((d) => {
        const varNamesRaw = typeof d.varNames === "object" && d.varNames !== null
            ? d.varNames
            : {};
        const varNames = {};
        for (const key of ["branch", "prNumber", "workflowName", "runnerName"]) {
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
function isConfigured(config) {
    return config.baseUrl !== "" && config.dashboards.length > 0;
}
/**
 * Matches a pull request's own pages (Conversation/Commits/Checks/Files changed),
 * e.g. `/org/repo/pull/123` or `/org/repo/pull/123/checks`. Any sub-tab counts:
 * they all show CI activity for the same PR/branch, which is what the Grafana
 * dashboard filters by.
 */
function parsePrContext(pathname) {
    const match = pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/.*)?$/);
    if (!match)
        return null;
    const [, org, repo, prNumber] = match;
    return { kind: "pr", org, repo, prNumber };
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
function parseWorkflowContext(pathname) {
    const match = pathname.match(/^\/([^/]+)\/([^/]+)\/actions\/workflows\/([^/?#]+)/);
    if (!match)
        return null;
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
function resolveJumpContext(pathname, search) {
    return (parseRunnerContext(pathname) ??
        parseWorkflowContext(pathname) ??
        parsePrContext(pathname) ??
        parseBranchContext(pathname, search));
}
/** Which DashboardVarNames key a given context kind is filtered by. */
function contextVarKey(kind) {
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
function contextFilterValue(context) {
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
function applicableDashboards(config, context) {
    const key = contextVarKey(context.kind);
    return config.dashboards.filter((dashboard) => Boolean(dashboard.varNames[key]));
}
/**
 * Builds a Grafana dashboard URL with one or more template variables preset via
 * the `var-<name>=<value>` query convention.
 */
function buildDashboardUrl(baseUrl, dashboard, vars) {
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
function buildJumpUrl(baseUrl, dashboard, context) {
    const key = contextVarKey(context.kind);
    const varName = dashboard.varNames[key];
    const vars = varName ? { [varName]: contextFilterValue(context) } : {};
    return buildDashboardUrl(baseUrl, dashboard, vars);
}
/** Human-readable label for the jump button, specific to the matched context. */
function labelForContext(context) {
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
// Config persistence. Wrapped so the rest of the script only ever deals with a
// GrafanaJumpConfig object, never the raw JSON-string storage format.
// ---------------------------------------------------------------------------
const CONFIG_STORAGE_KEY = "grafanaJumpConfig.v1";
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
const BUTTON_STYLE = "display: inline-block; background: #F55F0E; color: #fff; padding: 8px 12px; " +
    "border: none; border-radius: 6px 0 0 6px; font-size: 12px; font-weight: 600; " +
    "font-family: inherit; text-decoration: none; cursor: pointer; vertical-align: top;";
const TOGGLE_STYLE = "display: inline-block; background: #c94c0a; color: #fff; padding: 8px 8px; " +
    "border: none; border-left: 1px solid rgba(255,255,255,0.3); border-radius: 0 6px 6px 0; " +
    "font-size: 12px; font-family: inherit; cursor: pointer; vertical-align: top;";
const SOLO_BUTTON_STYLE = "display: inline-block; background: #57606a; color: #fff; padding: 8px 12px; " +
    "border: none; border-radius: 6px; font-size: 12px; font-weight: 600; " +
    "font-family: inherit; text-decoration: none; cursor: pointer;";
const MENU_STYLE = "position: absolute; bottom: 100%; right: 0; margin-bottom: 4px; background: #fff; " +
    "color: #24292f; border-radius: 6px; box-shadow: 0 4px 12px rgba(0,0,0,0.25); " +
    "min-width: 180px; overflow: hidden; font-family: inherit;";
const MENU_ITEM_STYLE = "display: block; padding: 8px 12px; font-size: 12px; text-decoration: none; " +
    "color: inherit; white-space: nowrap; cursor: pointer; background: none; " +
    "border: none; width: 100%; text-align: left; box-sizing: border-box;";
let currentConfig = defaultConfig();
function closeMenu() {
    document.getElementById(`${CONTAINER_ID}-menu`)?.remove();
}
function openMenu(anchorContainer, items) {
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
function openConfigModal() {
    closeMenu();
    // Work on a deep-ish draft copy so Cancel leaves the saved config untouched.
    const draft = {
        baseUrl: currentConfig.baseUrl,
        dashboards: currentConfig.dashboards.map((d) => ({ ...d, varNames: { ...d.varNames } })),
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
        "width: 520px; max-width: 90vw; max-height: 85vh; overflow-y: auto; " +
        "box-shadow: 0 8px 24px rgba(0,0,0,0.4);");
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
    baseUrlInput.setAttribute("style", "display: block; width: 100%; box-sizing: border-box; padding: 6px 8px; " +
        "margin-bottom: 16px; font-size: 13px; border: 1px solid #d0d7de; border-radius: 6px;");
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
            "font-size: 12px; border: 1px solid #d0d7de; border-radius: 4px;");
        input.addEventListener("input", () => onInput(input.value));
        wrapper.appendChild(label);
        wrapper.appendChild(input);
        parent.appendChild(wrapper);
    };
    const renderRows = () => {
        rowsContainer.innerHTML = "";
        draft.dashboards.forEach((dashboard, index) => {
            const row = document.createElement("div");
            row.setAttribute("style", "border: 1px solid #d0d7de; border-radius: 6px; padding: 10px; margin-bottom: 10px; position: relative;");
            const removeButton = document.createElement("button");
            removeButton.type = "button";
            removeButton.textContent = "Remove";
            removeButton.setAttribute("style", "position: absolute; top: 8px; right: 8px; background: none; border: none; " +
                "color: #cf222e; font-size: 11px; cursor: pointer;");
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
            const varFields = [
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
                    }
                    else {
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
    addButton.setAttribute("style", "display: block; width: 100%; padding: 8px; margin-bottom: 16px; " +
        "background: #f6f8fa; border: 1px dashed #d0d7de; border-radius: 6px; " +
        "font-size: 12px; cursor: pointer;");
    addButton.addEventListener("click", () => {
        draft.dashboards.push({ name: "", uid: "", slug: "", varNames: {} });
        renderRows();
    });
    panel.appendChild(addButton);
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
function renderJumpButton(context) {
    const existing = document.getElementById(CONTAINER_ID);
    if (!context) {
        existing?.remove();
        return;
    }
    const applicable = applicableDashboards(currentConfig, context);
    const container = existing ?? document.createElement("div");
    container.id = CONTAINER_ID;
    container.setAttribute("style", "position: fixed; bottom: 16px; right: 16px; z-index: 2147483647;");
    container.innerHTML = "";
    if (applicable.length === 0) {
        const setupButton = document.createElement("button");
        setupButton.type = "button";
        setupButton.textContent = isConfigured(currentConfig)
            ? "⚙️ No dashboard configured for this page"
            : "⚙️ Set up Grafana jump";
        setupButton.setAttribute("style", SOLO_BUTTON_STYLE);
        setupButton.addEventListener("click", (event) => {
            event.stopPropagation();
            openConfigModal();
        });
        container.appendChild(setupButton);
    }
    else {
        const [primary, ...rest] = applicable;
        const label = labelForContext(context);
        const jumpLink = document.createElement("a");
        jumpLink.setAttribute("href", buildJumpUrl(currentConfig.baseUrl, primary, context));
        jumpLink.setAttribute("target", "_blank");
        jumpLink.setAttribute("style", BUTTON_STYLE);
        jumpLink.textContent = applicable.length > 1 ? `${label} (${primary.name}) ↗️` : `${label} ↗️`;
        container.appendChild(jumpLink);
        const toggle = document.createElement("button");
        toggle.type = "button";
        toggle.textContent = "▾";
        toggle.setAttribute("style", TOGGLE_STYLE);
        toggle.addEventListener("click", (event) => {
            event.stopPropagation();
            const items = [
                ...applicable.map((dashboard) => ({
                    label: `↗️ ${dashboard.name || dashboard.uid}`,
                    onClick: () => window.open(buildJumpUrl(currentConfig.baseUrl, dashboard, context), "_blank"),
                })),
                { label: "⚙️ Edit dashboards...", onClick: openConfigModal },
            ];
            openMenu(container, items);
        });
        container.appendChild(toggle);
        // rest is intentionally unused beyond being included in `applicable` above;
        // named for clarity when reading the destructure at a glance.
        void rest;
    }
    if (!existing) {
        document.body.appendChild(container);
    }
}
let lastLocationKey;
function checkLocation(force = false) {
    const { pathname, search } = window.location;
    const locationKey = `${pathname}${search}`;
    if (!force && locationKey === lastLocationKey)
        return;
    lastLocationKey = locationKey;
    renderJumpButton(resolveJumpContext(pathname, search));
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
        buildDashboardUrl,
        buildJumpUrl,
        labelForContext,
        defaultConfig,
        normalizeConfig,
        isConfigured,
    };
}
//# sourceMappingURL=index.js.map