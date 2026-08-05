// ==UserScript==
// @name        Github => Graphite button
// @version     0.3.4
// @description Add a button to go from app.graphite.dev to github.com
// @namespace   https://www.github.com
// @match       http*://www.github.com/*
// @match       http*://github.com/*
// @run-at      document-start
// @icon        data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==
// @grant       none
// @license     MIT
// @downloadURL https://github.com/nsheaps/greasemonkey-scripts/releases/latest/download/github-to-graphite-button.user.js
// @updateURL   https://github.com/nsheaps/greasemonkey-scripts/releases/latest/download/github-to-graphite-button.user.js
// ==/UserScript==
"use strict";
// The `// ==UserScript==` metadata block for this script lives in
// src/meta.json and is prepended to the compiled output by
// scripts/build-userscript.mjs. See that script for why it isn't inlined here.
const PATH_REGEX = /^\/([^\/]+)\/([^\/]+)\/pull\/([^\/]+).*$/;
const SELECTOR = '[class^="gh-header-actions"]';
const addButton = (toolbar) => {
    const match = window.location.pathname.match(PATH_REGEX);
    if (!match)
        return;
    const [_, org, repo, pr] = match;
    const graphiteLink = `https://app.graphite.dev/github/pr/${org}/${repo}/${pr}/`;
    if (document.getElementById("graphiteLink") != null) {
        return;
    }
    const anchorEl = document.createElement("a");
    anchorEl.setAttribute("id", "graphiteLink");
    anchorEl.setAttribute("href", graphiteLink);
    anchorEl.setAttribute("target", "_blank");
    anchorEl.setAttribute("rel", "noopener noreferrer");
    anchorEl.setAttribute("class", "Button--secondary Button--small Button");
    anchorEl.appendChild(document.createTextNode("Graphite ↗️"));
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
