// The `// ==UserScript==` metadata block for this script lives in
// src/meta.json and is prepended to the compiled output by
// scripts/build-userscript.mjs. See that script for why it isn't inlined here.

const PATH_REGEX = /^\/([^\/]+)\/([^\/]+)\/pull\/([^\/]+).*$/;
const SELECTOR = '[class^="gh-header-actions"]';

const addButton = (toolbar: HTMLElement) => {
  const match = window.location.pathname.match(PATH_REGEX);
  if (!match) return;
  
  const [_, org, repo, pr] = match;
  const graphiteLink = `https://app.graphite.dev/github/pr/${org}/${repo}/${pr}/`;

  if (document.getElementById("graphiteLink") != null) {
    return;
  }

  const anchorEl = document.createElement("a");
  anchorEl.setAttribute("id", "graphiteLink");
  anchorEl.setAttribute("href", graphiteLink);
  anchorEl.setAttribute("target", "_blank");
  anchorEl.setAttribute("class", "Button--secondary Button--small Button");
  anchorEl.appendChild(document.createTextNode("Graphite ↗️"));

  toolbar.appendChild(anchorEl);
};

const toolbarObserver = new MutationObserver((_, observer) => {
  const toolbar = document.querySelector(SELECTOR) as HTMLElement;
  if (toolbar) {
    observer.disconnect();
    addButton(toolbar);
  }
});

let lastPathname: string | undefined;
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
