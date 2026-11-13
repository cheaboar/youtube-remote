(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.GoogleRemoteDOM = api;
})(typeof globalThis === "object" ? globalThis : this, function () {
  "use strict";

  // Google's result page keeps two stable ids: `#rso` holds the organic results and `#search`
  // wraps the whole column. Each result is a block containing a heading link; the block class
  // names (`MjjYud`, `g`) change between releases, so they only pick the box that is highlighted.
  const BLOCK = "div.MjjYud, div.g, div[data-hveid]";
  const GOOGLE = /(^|\.)google\.[a-z.]+$/i;

  function visible(element) {
    if (!element?.isConnected) return false;
    const rect = element.getBoundingClientRect();
    if (!(rect.width > 0 && rect.height > 0)) return false;
    const style = getComputedStyle(element);
    return style.visibility !== "hidden" && style.display !== "none" &&
      (!element.checkVisibility || element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }));
  }

  function isSearch() {
    return location.pathname === "/search";
  }

  function routeKey() {
    const url = new URL(location.href);
    url.searchParams.sort();
    return url.pathname + url.search;
  }

  function searchInput() {
    return [...document.querySelectorAll('textarea[name="q"],input[name="q"]')].find(visible) || null;
  }

  // Tabs, tools and cached links point back into Google itself; only `/url` redirects lead to a
  // real result and are unwrapped.
  function resolveHref(value) {
    let url;
    try { url = new URL(value, location.href); }
    catch (_) { return ""; }
    if (!/^https?:$/.test(url.protocol)) return "";
    if (!GOOGLE.test(url.hostname)) return url.href;
    if (url.pathname !== "/url") return "";
    const target = url.searchParams.get("q") || url.searchParams.get("url") || "";
    try {
      const real = new URL(target);
      return /^https?:$/.test(real.protocol) ? real.href : "";
    } catch (_) { return ""; }
  }

  // Ads live outside `#rso`, and "people also ask" headings sit in buttons rather than links,
  // so a heading link under the organic list is exactly one search result.
  function cards() {
    const root = [...document.querySelectorAll("#rso, #search")].find(visible);
    if (!root) return [];
    const result = new Map();
    for (const heading of root.querySelectorAll("a[href] h3")) {
      if (!visible(heading)) continue;
      const link = heading.closest("a[href]");
      if (!link) continue;
      const href = resolveHref(link.getAttribute("href"));
      if (!href || result.has(href)) continue;
      const element = link.closest(BLOCK) || link;
      if (!visible(element)) continue;
      const rect = element.getBoundingClientRect();
      if (rect.width < 160 || rect.height < 36) continue;
      result.set(href, { element, link, id: href, rect, href,
        label: (heading.textContent || "").replace(/\s+/g, " ").trim() });
    }
    return [...result.values()].sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);
  }

  function firstVisible(items) {
    return items.find(({ rect }) => rect.top >= 60 && rect.top < innerHeight && rect.bottom > 60) ||
      items.find(({ rect }) => rect.bottom > 80) || items[0] || null;
  }

  // The footer's pager keeps the long-standing `pnnext` / `pnprev` ids. `pnprev` exists but is
  // hidden on the first page, so the visibility check alone decides whether a page exists. The
  // label fallback stays inside the footer containers: scanning every link on a mutating page
  // would be wasteful, and Google's pager has carried these ids for years.
  function pageLink(rel) {
    const label = rel === "next" ? /下一?页|Next/i : /上一?页|Previous/i;
    const direct = document.getElementById(rel === "next" ? "pnnext" : "pnprev");
    const link = direct ? visible(direct) ? direct : null
      : [...document.querySelectorAll("#foot a[href], #botstuff a[href], footer a[href]")]
        .find(element => visible(element) && label.test(`${element.getAttribute("aria-label") || ""} ${element.textContent || ""}`)) || null;
    if (!link) return null;
    try { return { element: link, href: new URL(link.getAttribute("href"), location.href).href }; }
    catch (_) { return null; }
  }

  function editing(target) {
    return target instanceof Element &&
      !!target.closest("input,textarea,select,[contenteditable]:not([contenteditable='false']),[role='textbox']");
  }

  return { visible, isSearch, routeKey, cards, searchInput, firstVisible, pageLink, editing };
});
