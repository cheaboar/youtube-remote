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
  function editing(target) {
    return target instanceof Element && !!target.closest("input,textarea,select,[contenteditable]:not([contenteditable='false']),[role='textbox'],[role='combobox']");
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
  globalThis.YouTubeRemoteDOM = { visible, isWatch, isShorts, routeKey, identity, candidates, firstVisible, guideItems, guideButton, sidebar, expandPlaylist,
    searchInput, editing, video, player, playerControl, playerMenuItem, overlay, scrollParent, scrollForMore, submitSearch };
})();
