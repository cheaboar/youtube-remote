(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.YoukuRemoteDOM = api;
})(typeof globalThis === "object" ? globalThis : this, function () {
  "use strict";

  // Youku ships hashed class suffixes, but the card prefix and the video href shape are stable.
  const CARD = '[class*="yk_card_"]';
  const RAIL_LINK = "a.new-pic-text-item";
  const VIDEO_HREF = 'a[href*="v.youku.com/video"],a[href*="v.youku.com/v_show"]';
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
    return /^v\./.test(location.hostname) || location.pathname.startsWith("/v_show/");
  }

  function isGrid() {
    return !isVideo();
  }

  function routeKey() {
    const url = new URL(location.href);
    url.searchParams.sort();
    return url.hostname + url.pathname + url.search;
  }

  function idFor(link) {
    if (!link) return "";
    try {
      const url = new URL(link.getAttribute("href"), location.href);
      return url.searchParams.get("vid") || url.searchParams.get("s") ||
        url.pathname.match(/\/v_show\/id_([^/.]+)\.html/)?.[1] || "";
    } catch (_) {
      return "";
    }
  }

  function currentId() {
    try {
      const url = new URL(location.href);
      return url.searchParams.get("vid") ||
        url.pathname.match(/\/v_show\/id_([^/.]+)\.html/)?.[1] || "";
    } catch (_) {
      return "";
    }
  }

  function linkFor(card) {
    if (card.matches?.(VIDEO_HREF)) return card;
    return [...card.querySelectorAll(VIDEO_HREF)].find(visible) || card.querySelector(VIDEO_HREF) || null;
  }

  function readCard(card, { requireVisible = true } = {}) {
    if (!card || card.closest("#youku-remote-status")) return null;
    if (requireVisible && !visible(card)) return null;
    const link = linkFor(card);
    const id = idFor(link);
    if (!link || !id) return null;
    const rect = card.getBoundingClientRect();
    if (rect.width < 80 || rect.height < 60) return null;
    let href;
    try { href = new URL(link.getAttribute("href"), location.href).href; }
    catch (_) { href = link.getAttribute("href"); }
    return { element: card, link, id, rect, href };
  }

  function cards() {
    if (isVideo()) return [];
    const result = new Map();
    for (const card of document.querySelectorAll(CARD)) {
      // The home feed is a set of horizontal carousels clipped by a shared container. Only cards
      // fully inside the viewport are selectable; moving to a clipped card would scroll the whole
      // page sideways instead of the row.
      const rect = card.getBoundingClientRect();
      if (rect.left < -1 || rect.right > innerWidth + 1) continue;
      const item = readCard(card);
      if (item && !result.has(item.id)) result.set(item.id, item);
    }
    return [...result.values()];
  }

  function railCards() {
    if (!isVideo()) return [];
    const current = currentId();
    const result = new Map();
    for (const link of document.querySelectorAll(RAIL_LINK)) {
      if (!visible(link)) continue;
      const rect = link.getBoundingClientRect();
      if (rect.left < innerWidth * 0.55 || rect.width < 100 || rect.height < 40) continue;
      const id = idFor(link);
      if (!id || id === current || result.has(id)) continue;
      let href;
      try { href = new URL(link.getAttribute("href"), location.href).href; }
      catch (_) { href = link.getAttribute("href"); }
      result.set(id, { element: link, link, id, rect, href });
    }
    return [...result.values()];
  }

  function firstVisible(items) {
    return items.find(({ rect }) => rect.top >= 60 && rect.top < innerHeight && rect.bottom > 60) ||
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
    const target = pageScroller() || window;
    const step = Math.min(720, Math.max(220, (target.clientHeight || innerHeight) * 0.8));
    target.scrollBy({ top: step, behavior: "instant" });
  }

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
    return media?.closest(".player-container,.youku-player") ||
      document.querySelector(".player-container,.youku-player") || null;
  }

  function overlay() {
    return [...document.querySelectorAll(OVERLAY)].find(element => visible(element) &&
      !element.closest("#youku-remote-status")) || null;
  }

  function searchInput() {
    return [...document.querySelectorAll('input[class*="search_search_input"],input[placeholder*="搜索"]')]
      .find(visible) || null;
  }

  // Youku's player page no longer exposes like/favorite/share controls; interactions live inside
  // recommendation cards. The panel lists only controls that actually exist.
  function nextEpisodeControl() {
    const active = document.querySelector(".box-anthology-item.active");
    const next = active?.nextElementSibling;
    return next?.classList.contains("box-anthology-item") && visible(next) ? next : null;
  }
  const CONTROLS = {
    pageFullscreen: ".kui-webfullscreen-icon-0",
    nextEpisode: nextEpisodeControl
  };
  function control(name) {
    const value = CONTROLS[name];
    if (typeof value === "function") return value();
    const element = typeof value === "string" ? document.querySelector(value) : null;
    return element && visible(element) ? element : null;
  }

  function commentList() {
    return null;
  }

  function editing(target) {
    return target instanceof Element &&
      !!target.closest("input,textarea,select,[contenteditable]:not([contenteditable='false']),[role='textbox']");
  }

  return { visible, isGrid, isVideo, routeKey, cards, railCards, firstVisible, scrollParent, pageScroller,
    scrollForMore, video, player, overlay, searchInput, editing, control, commentList };
});
