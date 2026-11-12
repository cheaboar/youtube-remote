(function () {
  "use strict";
  const cards = ["ytd-rich-item-renderer", "ytd-video-renderer", "ytd-grid-video-renderer", "ytd-compact-video-renderer",
    "ytd-playlist-renderer", "ytd-grid-playlist-renderer", "ytd-compact-playlist-renderer", "ytd-radio-renderer",
    "ytd-compact-radio-renderer", "ytd-reel-item-renderer", "ytd-playlist-panel-video-renderer", "yt-lockup-view-model",
    "ytm-shorts-lockup-view-model", "ytm-shorts-lockup-view-model-v2", "yt-shorts-lockup-view-model"].join(",");
  const ads = "ytd-ad-slot-renderer,ytd-display-ad-renderer,ytd-promoted-video-renderer,ytd-promoted-sparkles-web-renderer,ytd-in-feed-ad-layout-renderer,ytd-search-pyv-renderer,[is-ad]";
  const isWatch = () => location.pathname === "/watch";
  const isShorts = () => location.pathname.startsWith("/shorts/");
  function visible(element) {
    if (!element?.isConnected) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== "hidden" &&
      (!element.checkVisibility || element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }));
  }
  function routeKey() {
    const u = new URL(location.href);
    if (isWatch()) return `/watch?${new URLSearchParams([...u.searchParams].filter(([k]) => ["v", "list", "index"].includes(k)))}`;
    ["pp", "si", "feature"].forEach((k) => u.searchParams.delete(k));
    u.searchParams.sort();
    return u.pathname + u.search;
  }
  function identity(href, area = "list") {
    try {
      const u = new URL(href, location.href);
      if (u.hostname !== "www.youtube.com") return null;
      if (area === "guide") return `guide:${u.pathname}${u.search}`;
      if (u.pathname === "/watch" && u.searchParams.get("v")) return `video:${u.searchParams.get("v")}`;
      if (u.pathname === "/playlist" && u.searchParams.get("list")) return `playlist:${u.searchParams.get("list")}`;
      if (/^\/(shorts|live)\/[^/]+/.test(u.pathname)) return u.pathname;
    } catch (_) { /* Ignore unrelated links. */ }
    return null;
  }
  function watchRoot() { return [...document.querySelectorAll("ytd-watch-flexy")].find(visible) || document; }
  function candidates(area = "list") {
    if (area === "guide") return guideItems();
    let roots = [document];
    if (area === "list") {
      const pages = [...document.querySelectorAll(location.pathname === "/results" ? "ytd-search" : "ytd-browse")];
      if (pages.length) roots = pages.filter(visible);
    }
    if (area === "playlist") roots = [...watchRoot().querySelectorAll("ytd-playlist-panel-renderer")].filter(visible);
    if (area === "recommendations") roots = [...watchRoot().querySelectorAll("#related, #secondary, ytd-watch-next-secondary-results-renderer")].filter(visible);
    const result = new Map();
    for (const root of roots) for (const link of root.querySelectorAll("a[href]")) {
      const id = identity(link.href);
      if (!id) continue;
      const element = link.closest(cards);
      if (!element || !root.contains(element) || result.has(element) || !visible(element)) continue;
      // YouTube changes the URL before hiding its cached watch page on history back.
      if (area === "list" && element.closest("ytd-watch-flexy,ytd-watch-grid,ytd-reel-video-renderer")) continue;
      if (element.closest(ads) || element.querySelector(ads)) continue;
      if (area === "recommendations" && element.closest("ytd-playlist-panel-renderer")) continue;
      result.set(element, { element, link, id, rect: element.getBoundingClientRect() });
    }
    // Nested renderer generations may wrap the same card; use only the inner card.
    const values = [...result.values()];
    return values.filter((item) => !values.some((other) => other !== item && item.element.contains(other.element)));
  }
  function firstVisible(items) {
    return items.find((item) => item.rect.bottom > 70 && item.rect.top < innerHeight) || items[0];
  }
  function guideItems() {
    const roots = [...document.querySelectorAll("ytd-guide-renderer,ytd-mini-guide-renderer")].filter(visible);
    const result = new Map();
    for (const root of roots) for (const link of root.querySelectorAll("a[href]")) {
      const element = link.closest("ytd-guide-entry-renderer,ytd-mini-guide-entry-renderer");
      const id = identity(link.href, "guide");
      if (!element || !root.contains(element) || !id || !visible(element) || !visible(link) || link.getAttribute("aria-disabled") === "true") continue;
      if (!result.has(id)) result.set(id, { element, link, id, rect: element.getBoundingClientRect() });
    }
    return [...result.values()].sort((a, b) => a.rect.top - b.rect.top);
  }
  function guideButton() {
    return [...document.querySelectorAll("#guide-button button,button#guide-button")].find(visible);
  }
  function guideExpanded() {
    // A drawer owns the guide on narrow layouts. Its opened attribute is authoritative even
    // while the off-screen drawer still has a non-zero box in some YouTube layouts.
    const drawers = [...document.querySelectorAll("tp-yt-app-drawer")].filter(drawer =>
      visible(drawer) && drawer.querySelector("ytd-guide-renderer"));
    if (drawers.length) return drawers.some(drawer => drawer.hasAttribute("opened") ||
      drawer.hasAttribute("persistent") || drawer.getAttribute("aria-expanded") === "true");
    // On wide layouts the full guide is docked; the mini guide is the collapsed state.
    return [...document.querySelectorAll("ytd-guide-renderer")].some(root =>
      visible(root) && root.querySelector("ytd-guide-entry-renderer"));
  }
  function sidebar() {
    const playlist = candidates("playlist");
    if (playlist.length) return { area: "playlist", items: playlist,
      first: playlist.find((i) => i.element.hasAttribute("selected")) || playlist.find((i) => i.id === `video:${new URL(location.href).searchParams.get("v")}`) || playlist[0] };
    const items = candidates("recommendations");
    return { area: "recommendations", items, first: items[0] };
  }
  function expandPlaylist(attempted) {
    const panel = [...watchRoot().querySelectorAll("ytd-playlist-panel-renderer[collapsed]")].find(visible);
    const button = panel?.querySelector("#trailing-button button");
    if (!panel || !visible(button)) return false;
    if (!attempted.has(panel)) { attempted.add(panel); button.click(); }
    return panel.hasAttribute("collapsed");
  }
  function searchInput() {
    return [...document.querySelectorAll('input[name="search_query"],input#search,yt-searchbox input[type="text"]')].find(visible);
  }
  const editors = "input,textarea,select,[contenteditable]:not([contenteditable='false']),[role='textbox']";
  function editing(target) {
    return target instanceof Element && !!target.closest(`${editors},[role='combobox']`);
  }
  // Chrome makes scroll containers keyboard-focusable: clicking/dragging a scrollbar focuses the scroller.
  // That scroller is not a text editor, even when a wrapper carries an editor-like role (search suggestions,
  // comment panels). Keeping its focus must not disable the remote or let the browser eat arrow keys.
  function scrollFocus(target) {
    if (!(target instanceof Element) || target.matches(editors)) return false;
    if (target.closest("#youtube-remote-status,#youtube-remote-sequences,#youtube-remote-browser")) return false;
    if (target === document.scrollingElement) return target.scrollHeight > innerHeight;
    const style = getComputedStyle(target);
    const overflows = (axis, size, view) => /^(auto|scroll|overlay)$/.test(axis) && size > view + 1;
    return overflows(style.overflowY, target.scrollHeight, target.clientHeight) ||
      overflows(style.overflowX, target.scrollWidth, target.clientWidth);
  }
  function video() { return [...document.querySelectorAll("#movie_player video,video.html5-main-video,video")].find(visible); }
  function player() { return [...document.querySelectorAll("#movie_player")].find(visible) || video(); }
  function playerControl(action) {
    const selectors = { captions: ".ytp-subtitles-button", theater: ".ytp-size-button", playerSettings: ".ytp-settings-button" };
    const root = player();
    if (!root || !selectors[action]) return null;
    // Auto-hidden player chrome still accepts clicks. Ignore opacity, but exclude unavailable controls.
    return [...root.querySelectorAll(selectors[action])].find(button => {
      const box = button.getBoundingClientRect();
      return box.width > 0 && box.height > 0 && !button.disabled && button.getAttribute("aria-disabled") !== "true" &&
        getComputedStyle(button).visibility !== "hidden";
    }) || null;
  }
  function playerMenuItem() {
    const menu = [...(player()?.querySelectorAll(".ytp-settings-menu,[role='menu']") || [])].find(visible);
    return menu && [...menu.querySelectorAll("[role='menuitem'],[role='menuitemcheckbox'],[role='menuitemradio']")].find(visible);
  }
  function comments() {
    // Prefer the full comment section over the teaser/input box near the player.
    // The section shell renders early; its box stays empty until the page scrolls near it.
    const root = watchRoot();
    return [...root.querySelectorAll("ytd-comments#comments,ytd-comments,#comments")].find(visible) ||
      [...root.querySelectorAll("#comment-teaser,ytd-item-section-renderer#comment-item-section")].find(visible) || null;
  }
  function firstMatching(selectors, root = document, usableOnly = false) {
    for (const selector of selectors) {
      const found = [...root.querySelectorAll(selector)].find(element => visible(element) &&
        (!usableOnly || !element.disabled && element.getAttribute("aria-disabled") !== "true"));
      if (found) return found;
    }
    return null;
  }
  function shortsRoots() {
    const center = (element) => {
      const box = element.getBoundingClientRect();
      return Math.abs(box.top + box.height / 2 - innerHeight / 2);
    };
    return [...document.querySelectorAll("ytd-reel-video-renderer,ytd-shorts,ytd-shorts-page,#shorts-container,#shorts-player")]
      .filter(visible).sort((a, b) => center(a) - center(b));
  }
  function shortsCommentsButton() {
    const selectors = [
      'reel-action-bar-view-model button[aria-label*="comment" i]',
      'reel-action-bar-view-model button[aria-label*="评论"]',
      'yt-reel-action-bar-view-model button[aria-label*="comment" i]',
      'yt-reel-action-bar-view-model button[aria-label*="评论"]',
      'ytd-reel-player-overlay-renderer button[aria-label*="comment" i]',
      'ytd-reel-player-overlay-renderer button[aria-label*="评论"]',
      "comment-button-view-model button", "ytd-comments-button-renderer button",
      "#comments-button button", "#comment-button button",
      'button[aria-label*="comments" i]', 'button[aria-label*="评论"]',
      'button[aria-label*="comment" i]'
    ];
    for (const root of shortsRoots()) {
      const found = firstMatching(selectors, root, true);
      if (found) return found;
    }
    return firstMatching(selectors, document, true);
  }
  function shortsLikeButton() {
    const selectors = [
      'button[aria-label*="like this video" i]', 'button[aria-label*="喜欢此视频" i]',
      "like-button-view-model button", "ytd-toggle-button-renderer#like-button button",
      "#like-button button", "ytd-like-button-renderer button",
      'button[aria-label="Like"]', 'button[aria-label="喜欢"]', 'button[aria-label="点赞"]'
    ];
    // The comments panel also contains like buttons; search the action bar first and never
    // treat a comment's like button as the video's.
    const bars = [...document.querySelectorAll(
      "reel-action-bar-view-model,yt-reel-action-bar-view-model,ytd-reel-player-overlay-renderer")].filter(visible);
    for (const bar of bars) {
      const found = firstMatching(selectors, bar, true);
      if (found) return found;
    }
    for (const root of shortsRoots()) {
      const found = [...root.querySelectorAll(selectors.join(","))].find(element => visible(element) &&
        !element.closest("ytd-engagement-panel-section-list-renderer,ytd-comments") &&
        !element.disabled && element.getAttribute("aria-disabled") !== "true");
      if (found) return found;
    }
    return firstMatching(selectors, document, true);
  }
  function shortsLiked(button) {
    if (!button) return false;
    if (button.getAttribute("aria-pressed") === "true") return true;
    const root = button.closest("like-button-view-model,toggle-button-view-model,ytd-toggle-button-renderer,#like-button");
    return !!root && (root.getAttribute("aria-pressed") === "true" || root.hasAttribute("is-active") ||
      !!root.querySelector('[aria-pressed="true"],.yt-spec-button-shape-next--toggle-active'));
  }
  function shortsCommentsPanel() {
    const selectors = [
      'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-comments-section"]',
      'ytd-engagement-panel-section-list-renderer[target-id*="comment" i]',
      "ytd-comments#comments", "ytd-comments"
    ];
    return [...document.querySelectorAll(selectors.join(","))].find(element => visible(element) &&
      element.getAttribute("visibility") !== "ENGAGEMENT_PANEL_VISIBILITY_HIDDEN") || null;
  }
  function shortsCommentsCloseButton() {
    const panel = shortsCommentsPanel();
    if (!panel) return null;
    return firstMatching(["#visibility-button button", "#close-button button",
      'ytd-engagement-panel-title-header-renderer button[aria-label*="close" i]',
      'button[aria-label="Close"]', 'button[aria-label="关闭"]',
      'button[aria-label*="close" i]', 'button[aria-label*="关闭"]'], panel, true);
  }
  function shortsCommentsScroller() {
    const panel = shortsCommentsPanel();
    if (!panel) return null;
    const thread = [...panel.querySelectorAll("ytd-comment-thread-renderer,ytd-comment-view-model,#comment")].find(visible);
    const inner = scrollParent(thread);
    if (inner) return inner;
    const candidates = [panel, ...panel.querySelectorAll("#contents,#content,[role='list'],ytd-comments")]
      .filter(element => /(auto|scroll)/.test(getComputedStyle(element).overflowY) &&
        element.scrollHeight > element.clientHeight + 1);
    return candidates.sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight))[0] ||
      scrollParent(panel) || panel;
  }
  function focusShortsComments() {
    const scroller = shortsCommentsScroller();
    if (!scroller) return false;
    if (!scroller.hasAttribute("tabindex")) scroller.setAttribute("tabindex", "-1");
    scroller.focus({ preventScroll: true });
    return document.activeElement === scroller;
  }
  function shortsNavigationButton(direction) {
    if (direction !== "up" && direction !== "down") return null;
    return firstMatching([`#navigation-button-${direction} button`], document, true);
  }
  function pipButton() {
    const root = player();
    if (!root) return null;
    return [...root.querySelectorAll(".ytp-pip-button,[aria-label*='画中画'],[title*='画中画']")].find(visible) || null;
  }
  function overlay() {
    return [...document.querySelectorAll("dialog[open],[role='dialog'],[aria-modal='true'],tp-yt-paper-dialog,tp-yt-iron-dropdown,[role='menu']")]
      .find(element => !element.matches("yt-player-interstitial-renderer") &&
        !(element.matches("tp-yt-app-drawer") && element.querySelector("ytd-guide-renderer") || element.matches("ytd-guide-renderer")) && visible(element));
  }
  function scrollParent(element) {
    for (let parent = element?.parentElement; parent && parent !== document.body && parent !== document.documentElement; parent = parent.parentElement) {
      if (/^(auto|scroll|overlay)$/.test(getComputedStyle(parent).overflowY) && parent.scrollHeight > parent.clientHeight + 1) return parent;
    }
    return null;
  }
  function scrollForMore(element) {
    let parent = scrollParent(element);
    while (parent && parent.scrollTop >= parent.scrollHeight - parent.clientHeight - 1) parent = scrollParent(parent);
    const target = parent || window;
    target.scrollBy({ top: Math.min(240, Math.max(120, (parent?.clientHeight || innerHeight) / 3)), behavior: "instant" });
  }
  function submitSearch(input) {
    const form = input.closest("form");
    if (form) { form.requestSubmit(); return true; }
    const button = document.querySelector("button.ytSearchboxComponentSearchButton,#search-icon-legacy");
    if (button) { button.click(); return true; }
    return false;
  }
  globalThis.YouTubeRemoteDOM = { visible, isWatch, isShorts, routeKey, identity, candidates, firstVisible, guideItems, guideButton, guideExpanded, sidebar, expandPlaylist,
    searchInput, editing, scrollFocus, video, player, playerControl, playerMenuItem, pipButton, comments, overlay, scrollParent, scrollForMore, submitSearch,
    shortsCommentsButton, shortsLikeButton, shortsLiked, shortsCommentsPanel, shortsCommentsCloseButton, shortsCommentsScroller,
    focusShortsComments, shortsNavigationButton };
})();
