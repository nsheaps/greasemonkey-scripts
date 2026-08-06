// ==UserScript==
// @name        Graphite => GitHub button
// @version     0.3.8
// @description Add a button to go from app.graphite.dev to github.com
// @author      Nathan Heaps
// @namespace   https://app.graphite.dev
// @match       https://app.graphite.dev/*
// @run-at      document-start
// @icon        data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==
// @grant       none
// @license     MIT
// @downloadURL https://github.com/nsheaps/greasemonkey-scripts/releases/latest/download/graphite-to-github-button.user.js
// @updateURL   https://github.com/nsheaps/greasemonkey-scripts/releases/latest/download/graphite-to-github-button.user.js
// ==/UserScript==
"use strict";
// The `// ==UserScript==` metadata block for this script lives in
// src/meta.json and is prepended to the compiled output by
// scripts/build-userscript.mjs. See that script for why it isn't inlined here.
const PATH_REGEX = /^\/github\/pr\/([^\/]+)\/([^\/]+)\/([^\/]+).*$/;
const SELECTOR = '[class^="PullRequestTitleBar_container_"] > div:nth-child(1) > div:nth-child(2)';
const addButton = (toolbar) => {
    const match = window.location.pathname.match(PATH_REGEX);
    if (!match)
        return;
    const [_, org, repo, pr] = match;
    const gitHubLink = `https://github.com/${org}/${repo}/pull/${pr}`;
    if (document.getElementById("gitHubLink") != null) {
        return;
    }
    const anchorEl = document.createElement("a");
    anchorEl.setAttribute("id", "gitHubLink");
    anchorEl.setAttribute("href", gitHubLink);
    anchorEl.setAttribute("target", "_blank");
    anchorEl.setAttribute("rel", "noopener noreferrer");
    anchorEl.setAttribute("style", "background: #f0f0f333; padding: 6px; border-radius: 4px; flex-shrink: 0;");
    anchorEl.appendChild(document.createTextNode("GitHub ↗️"));
    toolbar.appendChild(anchorEl);
};
const toolbarObserver = new MutationObserver((_, observer) => {
    const toolbar = document.querySelector(SELECTOR);
    if (toolbar) {
        observer.disconnect();
        addButton(toolbar);
    }
});
let lastPathname;
const routeChangeObserver = new MutationObserver(() => {
    const { pathname } = window.location;
    if (pathname !== lastPathname) {
        lastPathname = pathname;
        if (pathname.match(PATH_REGEX)) {
            toolbarObserver.observe(document.body, {
                childList: true,
                subtree: true,
            });
        }
    }
});
routeChangeObserver.observe(document.body, { childList: true, subtree: true });
