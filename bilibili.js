(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.BilibiliRemoteDOM = api;
})(typeof globalThis === "object" ? globalThis : this, function () {
  "use strict";

  // Bilibili's feed card and recommendation card classes have been stable for years; only the
  // video id is needed from the href, so hashed inner class names never matter.
  const CARD = ".bili-video-card";
  const RAIL_CARD = ".video-page-card-small";
  const VIDEO_LINK = 'a[href*="/video/BV"]';
  const OVERLAY = '[role="dialog"],[aria-modal="true"]';

  function visible(element) {
    if (!element?.isConnected) return false;
    const rect = element.getBoundingClientRect();
    if (!(rect.width > 0 && rect.height > 0)) return false;
    const style = getComputedStyle(element);
    return style.visibility !== "hidden" && style.display !== "none" &&
      (!element.checkVisibility || element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }));
  }

  function isVideo() {
    return /^\/video\//.test(location.pathname);
  }

  function isGrid() {
    return !isVideo();
  }

  function routeKey() {
    const url = new URL(location.href);
    url.searchParams.sort();
    return url.pathname + url.search;
  }

  function linkFor(card) {
    if (card.matches?.(VIDEO_LINK)) return card;
    return [...card.querySelectorAll(VIDEO_LINK)].find(visible) || card.querySelector(VIDEO_LINK) || null;
  }

  function idFor(link) {
    const href = link?.getAttribute("href") || "";
    return href.match(/\/video\/(BV[0-9A-Za-z]+)/)?.[1] || "";
  }

  function readCard(card, { requireVisible = true } = {}) {
    if (!card || card.closest("#bilibili-remote-status")) return null;
    if (requireVisible && !visible(card)) return null;
    const link = linkFor(card);
    const id = idFor(link);
    if (!link || !id) return null;
    const rect = card.getBoundingClientRect();
    if (rect.width < 80 || rect.height < 60) return null;
    let href;
    try { href = new URL(link.getAttribute("href"), location.href).href; }
    catch (_) { href = `https://www.bilibili.com/video/${id}`; }
    return { element: card, link, id, rect, href };
  }

  function cards() {
    // The video page's right rail has its own card class. Feed cards only belong to list pages.
    if (isVideo()) return [];
    const result = new Map();
    for (const card of document.querySelectorAll(CARD)) {
      const item = readCard(card);
      if (item && !result.has(item.id)) result.set(item.id, item);
    }
    if (!result.size) {
      // Future layout fallback: a large visible video link acts as its own card.
      for (const link of document.querySelectorAll(VIDEO_LINK)) {
        const card = link.closest(CARD) || link;
        const item = readCard(card);
        if (item && !result.has(item.id)) result.set(item.id, item);
      }
    }
    return [...result.values()];
  }

  function railCards() {
    if (!isVideo()) return [];
    const current = location.pathname.match(/^\/video\/(BV[0-9A-Za-z]+)/)?.[1] || "";
    const result = new Map();
    for (const card of document.querySelectorAll(RAIL_CARD)) {
      const item = readCard(card);
      if (!item || item.id === current || result.has(item.id)) continue;
      result.set(item.id, item);
    }
    return [...result.values()];
  }

  function firstVisible(items) {
    return items.find(({ rect }) => rect.top >= 64 && rect.top < innerHeight && rect.bottom > 64) ||
      items.find(({ rect }) => rect.bottom > 80) || items[0] || null;
  }

  function scrollParent(element) {
    for (let parent = element?.parentElement; parent && parent !== document.body && parent !== document.documentElement; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      if (/^(auto|scroll|overlay)$/.test(style.overflowY) && parent.scrollHeight > parent.clientHeight + 1) return parent;
    }
    return null;
  }

  function pageScroller() {
    const scroller = document.scrollingElement;
    return scroller && scroller.scrollHeight > scroller.clientHeight + 1 ? scroller : null;
  }

  function scrollForMore() {
    const target = scrollParent(document.querySelector(CARD)) || pageScroller() || window;
    const step = Math.min(720, Math.max(260, (target.clientHeight || innerHeight) * 0.8));
    target.scrollBy({ top: step, behavior: "instant" });
  }

  // Only a large visible <video> is the player. Feed thumbnails can preview on hover.
  function video() {
    let best = null;
    let bestArea = 0;
    for (const element of document.querySelectorAll("video")) {
      if (!visible(element)) continue;
      const rect = element.getBoundingClientRect();
      const area = Math.min(rect.width, innerWidth) * Math.min(rect.height, innerHeight);
      if (area > bestArea) { best = element; bestArea = area; }
    }
    return best && bestArea >= innerWidth * innerHeight * 0.15 ? best : null;
  }

  function player() {
    const media = video();
    return media?.closest("#bilibili-player,.bpx-player-container") ||
      document.querySelector("#bilibili-player,.bpx-player-container") || null;
  }

  function overlay() {
    return [...document.querySelectorAll(OVERLAY)].find(element => visible(element) &&
      !element.closest("#bilibili-remote-status")) || null;
  }

  function searchInput() {
    return [...document.querySelectorAll(".nav-search-input,input[placeholder*='搜索']")].find(visible) || null;
  }

  // The toolbar under the player exposes these stable class names. Hover-only player controls
  // measure 0×0, so control() deliberately does not require visibility.
  const CONTROLS = {
    like: ".video-like",
    coin: ".video-coin",
    fav: ".video-fav",
    share: ".video-share-wrap",
    pageFullscreen: ".bpx-player-ctrl-web",
    danmaku: ".bui-danmaku-switch-input",
    nextEpisode: ".bpx-player-ctrl-next"
  };
  function control(name) {
    return document.querySelector(CONTROLS[name]) || null;
  }

  function commentList() {
    return document.querySelector("#commentapp") || document.querySelector("bili-comments") || null;
  }

  function editing(target) {
    return target instanceof Element &&
      !!target.closest("input,textarea,select,[contenteditable]:not([contenteditable='false']),[role='textbox']");
  }

  return { visible, isGrid, isVideo, routeKey, cards, railCards, firstVisible, scrollParent, pageScroller,
    scrollForMore, video, player, overlay, searchInput, editing, control, commentList };
});
