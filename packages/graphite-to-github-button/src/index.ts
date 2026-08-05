// The `// ==UserScript==` metadata block for this script lives in
// src/meta.json and is prepended to the compiled output by
// scripts/build-userscript.mjs. See that script for why it isn't inlined here.

const PATH_REGEX = /^\/github\/pr\/([^\/]+)\/([^\/]+)\/([^\/]+).*$/;
const SELECTOR =
  '[class^="PullRequestTitleBar_container_"] > div:nth-child(1) > div:nth-child(2)';

const addButton = (toolbar: HTMLElement) => {
  const match = window.location.pathname.match(PATH_REGEX);
  if (!match) return;

  const [_, org, repo, pr] = match;
  const gitHubLink = `https://github.com/${org}/${repo}/pull/${pr}`;

  if (document.getElementById("gitHubLink") != null) {
    return;
  }

  const anchorEl = document.createElement("a");
  anchorEl.setAttribute("id", "gitHubLink");
  anchorEl.setAttribute("href", gitHubLink);
  anchorEl.setAttribute("target", "_blank");
  anchorEl.setAttribute(
    "style",
    "background: #f0f0f333; padding: 6px; border-radius: 4px; flex-shrink: 0;"
  );
  anchorEl.appendChild(document.createTextNode("GitHub ↗️"));

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
