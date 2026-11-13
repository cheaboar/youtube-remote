(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.DouyinRemoteDOM = api;
})(typeof globalThis === "object" ? globalThis : this, function () {
  "use strict";

  // Douyin ships hashed CSS class names, but the semantic names below have stayed stable:
  // the feed list, the waterfall card item and its data-aweme-id are used by the site's own JS.
  const CARD = ".discover-video-card-item";
  const VIDEO_LINK = 'a[href*="/video/"], [href*="/video/"]';
  // The login prompt does not own the feed keyboard; arrows keep selecting the videos behind it.
  const OVERLAY = '[role="dialog"],[aria-modal="true"]';

  function visible(element) {
    if (!element?.isConnected) return false;
    const rect = element.getBoundingClientRect();
    if (!(rect.width > 0 && rect.height > 0)) return false;
    const style = getComputedStyle(element);
    return style.visibility !== "hidden" && style.display !== "none" &&
      (!element.checkVisibility || element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }));
  }

  function isGrid() {
    return location.pathname.startsWith("/jingxuan") || !!document.querySelector(".jingxuanFeedList");
  }

  function isVideo() {
    return /^\/(video|note)\//.test(location.pathname);
  }

  function routeKey() {
    const url = new URL(location.href);
    url.searchParams.sort();
    return url.pathname + url.search;
  }

  function gridRoot() {
    return [...document.querySelectorAll(".jingxuanFeedList, .jingxuan-scroll-element")].find(visible) || document;
  }

  function linkFor(card) {
    if (card.matches(VIDEO_LINK)) return card;
    return [...card.querySelectorAll(VIDEO_LINK)].find(visible) || card.querySelector(VIDEO_LINK) || null;
  }

  function idFor(card, link) {
    const attribute = (card.getAttribute("data-aweme-id") || "").trim();
    if (attribute) return attribute;
    const href = link?.getAttribute("href") || "";
    return href.match(/\/video\/(\d+)/)?.[1] || "";
  }

  function readCard(card) {
    if (!card || !visible(card) || card.closest("#douyin-remote-status")) return null;
    const link = linkFor(card);
    const id = idFor(card, link);
    if (!link || !id) return null;
    const rect = card.getBoundingClientRect();
    if (rect.width < 80 || rect.height < 60) return null;
    let href;
    try { href = new URL(link.getAttribute("href"), location.href).href; }
    catch (_) { href = `https://www.douyin.com/video/${id}`; }
    return { element: card, link, id, rect, href };
  }

  function cards() {
    const root = gridRoot();
    const result = new Map();
    for (const card of root.querySelectorAll(`${CARD}[data-aweme-id],${CARD}`)) {
      const item = readCard(card);
      if (item && !result.has(item.id)) result.set(item.id, item);
    }
    if (!result.size && isGrid()) {
      // Fallback for a future layout: treat each large, visible video link as its own card.
      // Only on grid pages: the video page's right rail is handled by railCards().
      for (const link of root.querySelectorAll('a[href*="/video/"]')) {
        const card = link.closest(CARD) || link;
        const item = readCard(card);
        if (item && !result.has(item.id)) result.set(item.id, item);
      }
    }
    return [...result.values()];
  }

  // The video page recommends more videos in a right-hand rail. `data-e2e="related-video"`
  // is the site's own semantic hook; the hashed `li` classes change between releases.
  function railRoot() {
    return [...document.querySelectorAll('[data-e2e="related-video"]')].find(visible) || null;
  }

  function railCards() {
    const root = railRoot();
    if (!root) return [];
    const current = location.pathname.match(/^\/(?:video|note)\/(\d+)/)?.[1] || "";
    const result = new Map();
    for (const link of root.querySelectorAll('a[href*="/video/"]')) {
      const card = link.closest("li") || link;
      const item = readCard(card);
      // The first rail card is often the current video itself.
      if (!item || item.id === current || result.has(item.id)) continue;
      result.set(item.id, item);
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

  function gridScroller() {
    const list = [...document.querySelectorAll(".jingxuanFeedList")].find(visible);
    return scrollParent(list) || list || document.scrollingElement;
  }

  // The video page scrolls an inner route container, not the document.
  function pageScroller() {
    const media = video();
    const parent = media && scrollParent(media);
    if (parent) return parent;
    const scroller = document.scrollingElement;
    return scroller && scroller.scrollHeight > scroller.clientHeight + 1 ? scroller : null;
  }

  function scrollForMore(element) {
    const parent = scrollParent(element) || gridScroller();
    const target = parent || window;
    const step = Math.min(480, Math.max(220, (parent?.clientHeight || innerHeight) * 0.8));
    target.scrollBy({ top: step, behavior: "instant" });
  }

  // The main player is a large visible <video>. The jingxuan grid may autoplay small hover
  // previews, so size matters: those previews must not turn the page into player mode.
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
    return media ? media.closest(".xgplayer") || media.parentElement || media : null;
  }

  function overlay() {
    return [...document.querySelectorAll(OVERLAY)].find(element => visible(element) &&
      !element.closest("#douyin-remote-status")) || null;
  }

  function searchInput() {
    return [...document.querySelectorAll('input[data-e2e="searchbar-input"],input[placeholder*="搜索"]')].find(visible) || null;
  }

  // Playback-page controls expose stable data-e2e names. Several sit in hover-only control
  // bars and measure 0×0, so control() deliberately does not require visibility.
  const CONTROLS = {
    like: '[data-e2e="video-player-digg"]',
    collect: '[data-e2e="video-player-collect"]',
    share: '[data-e2e="video-player-share"]',
    comment: '[data-e2e="feed-comment-icon"]',
    pageFullscreen: '[data-e2e="xgplayer-page-full-screen"]',
    prevVideo: '[data-e2e="video-switch-prev-arrow"]',
    nextVideo: '[data-e2e="video-switch-next-arrow"]'
  };
  function control(name) {
    return document.querySelector(CONTROLS[name]) || null;
  }
  function commentList() {
    return document.querySelector('[data-e2e="comment-list"]') || null;
  }
  function followButton() {
    for (const element of document.querySelectorAll('[data-e2e="user-info"] button, [data-e2e="user-info"] [role="button"]')) {
      const text = (element.textContent || "").replace(/\s+/g, "");
      if (text.includes("关注") && !text.includes("已关注")) return element;
    }
    return null;
  }

  function editing(target) {
    return target instanceof Element &&
      !!target.closest("input,textarea,select,[contenteditable]:not([contenteditable='false']),[role='textbox']");
  }

  return { visible, isGrid, isVideo, routeKey, cards, railCards, firstVisible, scrollParent, gridScroller,
    scrollForMore, pageScroller, video, player, overlay, searchInput, editing, control, commentList, followButton };
});
