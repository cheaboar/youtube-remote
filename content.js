(function () {
  "use strict";
  const R = globalThis.YouTubeRemote;
  const D = globalThis.YouTubeRemoteDOM;
  const { nextItem } = globalThis.YouTubeKeyboardNavigation;
  const matcher = R.createMatcher();
  const highlight = "youtube-keyboard-selected";
  const names = { list: "节目列表", player: "播放器", sidebar: "右侧列表", search: "搜索" };
  let settings = R.cloneDefaults();
  let diagnosticsUntil = 0;
  let route = D.routeKey();
  let region = D.isWatch() || D.isShorts() ? "player" : "list";
  let area = "recommendations";
  let selected = null;
  let selectedIndex = 0;
  let searchReturn = null;
  let lastSnapshot = null;
  let intent = 0;
  let pending = null;
  let pendingTimer;
  let saveTimer;
  let mutationTimer;
  let messageTimer;
  let transient = "";
  let composing = false;
  let compositionEnded = -Infinity;
  let navigationBusy = false;
  let lastActivation = { action: "", time: -Infinity };
  let ui;
  let tabFocus = false;
  const synthetic = new WeakSet();
  const localSnapshots = new Map();

  function send(message) {
    try { return chrome.runtime.sendMessage(message).catch(() => null); }
    catch (_) { return Promise.resolve(null); }
  }
  function items() { return D.candidates(region === "sidebar" ? area : "list"); }
  function clearHighlight() {
    selected?.element.classList.remove(highlight);
    document.querySelectorAll(`.${highlight}`).forEach((element) => element.classList.remove(highlight));
  }
  function clearSelection() { clearHighlight(); selected = null; }
  function render() {
    if (!document.documentElement) return;
    if (!ui) {
      const host = document.createElement("div");
      host.id = "youtube-remote-status";
      const shadow = host.attachShadow({ mode: "open" });
      const style = document.createElement("style");
      style.textContent = ":host{position:fixed;bottom:20px;right:20px;z-index:2147483647;pointer-events:none}div{max-width:min(440px,calc(100vw - 40px));padding:9px 13px;border:1px solid #466476;border-radius:7px;background:#183343;color:#fff;box-shadow:0 3px 14px #0003;font:500 13px/1.5 system-ui,sans-serif}span{color:#b9dcea;margin-left:8px}";
      const box = document.createElement("div");
      box.setAttribute("role", "status");
      const title = document.createElement("strong");
      const detail = document.createElement("span");
      box.append(title, detail);
      shadow.append(style, box);
      ui = { host, title, detail };
    }
    const uiParent = document.fullscreenElement || document.documentElement;
    if (ui.host.parentElement !== uiParent) uiParent.append(ui.host);
    const title = names[region];
    const detail = transient || (region === "search" ? "语音输入后按确认，返回清空并退出" : region === "player"
      ? `确认播放 / 暂停 · ${R.label(settings.bindings.sidebar)} 选片` : "方向键选片 · 确认播放");
    if (ui.title.textContent !== title) ui.title.textContent = title;
    if (ui.detail.textContent !== detail) ui.detail.textContent = detail;
    ui.host.dataset.region = region;
    ui.host.hidden = !settings.enabled || (!settings.showStatus && !transient);
  }
  function notice(message) {
    transient = message;
    clearTimeout(messageTimer);
    messageTimer = setTimeout(() => { transient = ""; render(); }, 2800);
    render();
  }
  function setRegion(value) {
    region = value;
    matcher.reset();
    if (!["list", "sidebar"].includes(region)) clearHighlight();
    render();
  }
  function ownFocus() {
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body) active.blur();
  }
  function snapshot() {
    if (region === "search" && searchReturn) return searchReturn;
    return { region, area, id: selected?.id || null, index: selectedIndex,
      x: scrollX, y: scrollY, innerScroll: D.scrollParent(selected?.element)?.scrollTop || 0 };
  }
  function remember(immediate = false) {
    if (!settings.enabled) return Promise.resolve();
    lastSnapshot = snapshot();
    localSnapshots.set(route, lastSnapshot);
    while (localSnapshots.size > 30) localSnapshots.delete(localSnapshots.keys().next().value);
    const savedRoute = route;
    const saved = lastSnapshot;
    clearTimeout(saveTimer);
    const write = () => send({ type: "remote:save", route: savedRoute, snapshot: saved });
    if (immediate) return write();
    saveTimer = setTimeout(write, 100);
    return Promise.resolve();
  }
  function select(item, { scroll = true, focus = true } = {}) {
    if (!item) return;
    clearHighlight();
    selected = item;
    selectedIndex = Math.max(0, items().findIndex((candidate) => candidate.element === item.element));
    item.element.classList.add(highlight);
    if (focus) ownFocus();
    if (scroll) item.element.scrollIntoView({ behavior: "instant", block: "nearest", inline: "nearest" });
    remember();
    render();
  }
  function cancelPending() {
    intent++;
    pending = null;
    clearTimeout(pendingTimer);
  }
  function waitFor(attempt, timeout, token = intent) {
    pending = { attempt, timeout, token, deadline: Date.now() + 8000 };
    tickPending();
  }
  function tickPending() {
    clearTimeout(pendingTimer);
    const task = pending;
    if (!task || task.token !== intent || !settings.enabled) return;
    if (task.attempt()) { if (pending === task) pending = null; return; }
    if (Date.now() >= task.deadline) {
      // An empty page may still be loading. Stop polling, but allow DOM changes to resume recovery.
      if (!task.expired) {
        task.expired = true;
        if (task.timeout() !== false && pending === task) pending = null;
      }
      return;
    }
    pendingTimer = setTimeout(tickPending, 100);
  }
  function validSelected() {
    if (!selected) return null;
    const available = items();
    return available.find((item) => item.element === selected.element && item.id === selected.id) ||
      available.find((item) => item.id === selected.id) || null;
  }
  function restore(saved, token) {
    area = saved?.area === "playlist" ? "playlist" : "recommendations";
    setRegion(saved?.region === "sidebar" && D.isWatch() ? "sidebar" : D.isWatch() || D.isShorts() ? "player" : "list");
    if (region === "player") { ownFocus(); remember(); return; }
    if (saved && Number.isFinite(saved.y)) window.scrollTo({ left: Number(saved.x) || 0, top: saved.y, behavior: "instant" });
    let lastLoadScroll = 0;
    const expanded = new WeakSet();
    waitFor(() => {
      if (region === "sidebar" && area === "playlist" && D.expandPlaylist(expanded)) return false;
      const list = items();
      if (!list.length) return false;
      const match = saved?.id && list.find((item) => item.id === saved.id);
      if (saved?.id && !match) {
        if (Date.now() - lastLoadScroll > 400) {
          lastLoadScroll = Date.now();
          if (Number.isFinite(saved.y)) window.scrollTo({ top: saved.y, behavior: "instant" });
          D.scrollForMore(list[list.length - 1].element);
        }
        return false;
      }
      const chosen = match || D.firstVisible(list);
      const parent = D.scrollParent(chosen.element);
      if (parent && saved?.innerScroll) parent.scrollTop = saved.innerScroll;
      select(chosen);
      return true;
    }, () => {
      const list = items();
      if (list.length) {
        select(list[Math.min(Math.max(0, saved?.index || 0), list.length - 1)]);
        if (saved?.id) notice("原节目暂未出现，已定位到附近节目");
      } else {
        notice("节目尚未加载，稍后按方向键重试");
        return false;
      }
    }, token);
  }
  async function enterRoute(back = false, force = false) {
    const nextRoute = D.routeKey();
    if (!force && nextRoute === route) return;
    if (lastSnapshot && nextRoute !== route) send({ type: "remote:save", route, snapshot: lastSnapshot });
    clearTimeout(saveTimer);
    cancelPending();
    const token = intent;
    route = nextRoute;
    clearSelection();
    searchReturn = null;
    lastSnapshot = null;
    navigationBusy = false;
    setRegion(D.isWatch() || D.isShorts() ? "player" : "list");
    if (!settings.enabled) return;
    const saved = localSnapshots.get(route) || await send({ type: "remote:restore", route });
    if (intent !== token || nextRoute !== D.routeKey()) return;
    restore((!D.isWatch() && !D.isShorts()) || back ? saved : null, token);
  }
  async function exitFullscreen() {
    if (document.fullscreenElement) {
      try { await document.exitFullscreen(); }
      catch (_) { notice("请先退出视频全屏"); return false; }
    }
    return true;
  }
  async function enterSearch(token) {
    if (region !== "search") searchReturn = snapshot();
    if (!await exitFullscreen() || token !== intent) return;
    setRegion("search");
    notice("正在定位搜索框…");
    waitFor(() => {
      const input = D.searchInput();
      if (!input) return false;
      input.focus({ preventScroll: false });
      input.select();
      transient = "";
      render();
      return document.activeElement === input;
    }, () => { notice("未找到搜索框，可稍后重试搜索键"); }, token);
  }
  async function enterSidebar(token) {
    if (!D.isWatch()) { notice("右侧列表仅在视频播放页提供"); return; }
    if (!await exitFullscreen() || token !== intent) return;
    ownFocus();
    searchReturn = null;
    clearSelection();
    setRegion("sidebar");
    notice("正在加载右侧节目…");
    const expanded = new WeakSet();
    waitFor(() => {
      if (D.expandPlaylist(expanded)) return false;
      const found = D.sidebar();
      if (!found.first) return false;
      area = found.area;
      select(found.first);
      transient = "";
      render();
      return true;
    }, () => { setRegion("player"); notice("右侧暂时没有可选节目，请稍后重试"); }, token);
  }
  function enterPlayer() {
    if (!D.isWatch() && !D.isShorts()) { notice("当前页面没有播放器"); return; }
    clearSelection();
    setRegion("player");
    ownFocus();
    remember();
  }
  async function togglePlayback() {
    const video = D.video();
    if (!video) return notice("播放器尚未就绪");
    try { if (video.paused) await video.play(); else video.pause(); }
    catch (_) { notice("播放被浏览器阻止，请在播放器上确认播放"); }
  }
  async function fullscreen() {
    if (document.fullscreenElement) return exitFullscreen();
    const player = D.player();
    if (!player) return notice("播放器尚未就绪");
    enterPlayer();
    try { await player.requestFullscreen(); }
    catch (_) { notice("无法进入全屏，请使用播放器全屏按钮"); }
  }
  function playerMove(action) {
    const video = D.video();
    if (!video) return notice("播放器尚未就绪");
    if (action === "up" || action === "down") {
      video.volume = Math.max(0, Math.min(1, video.volume + (action === "up" ? 0.05 : -0.05)));
      if (action === "up") video.muted = false;
      return;
    }
    const amount = action === "left" ? -5 : 5;
    const start = video.seekable.length ? video.seekable.start(0) : 0;
    const end = video.seekable.length ? video.seekable.end(video.seekable.length - 1) : video.duration;
    if (!Number.isFinite(end)) return notice("当前视频暂时不能调整进度");
    video.currentTime = Math.max(start, Math.min(end, video.currentTime + amount));
  }
  function move(action) {
    const list = items();
    if (!list.length) {
      notice("正在等待节目加载…");
      waitFor(() => { const available = items(); if (!available.length) return false; select(D.firstVisible(available)); return true; },
        () => notice("没有找到节目，可使用搜索键重新查找"));
      return;
    }
    const current = validSelected();
    const next = current ? nextItem(list, current.element, `Arrow${action[0].toUpperCase()}${action.slice(1)}`) : D.firstVisible(list);
    if (next.element !== selected?.element || !next.element.classList.contains(highlight)) select(next);
    else ownFocus();
    if (action === "down" && nextItem(list, next.element, "ArrowDown").element === next.element) D.scrollForMore(next.element);
  }
  async function confirm() {
    if (region === "player") return togglePlayback();
    if (region === "search") {
      const input = D.searchInput();
      if (!input?.value.trim()) return notice("请先输入搜索内容");
      await remember(true);
      if (!D.submitSearch(input)) notice("未找到搜索按钮，请稍后重试");
      return;
    }
    const item = validSelected() || D.firstVisible(items());
    if (!item) return notice("节目尚未加载");
    select(item);
    const token = intent;
    navigationBusy = true;
    await remember(true);
    if (token === intent && item.element.isConnected) item.link.click();
    setTimeout(() => { navigationBusy = false; }, 1200);
  }
  function backFromSearch() {
    const input = D.searchInput();
    if (input) {
      input.value = "";
      input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      const escape = new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true });
      synthetic.add(escape);
      input.dispatchEvent(escape);
      input.blur();
    }
    const saved = searchReturn;
    searchReturn = null;
    restore(saved, intent);
  }
  async function historyBack() {
    navigationBusy = true;
    await remember(true);
    history.back();
    setTimeout(() => { navigationBusy = false; }, 700);
  }
  async function goHome(token) {
    if (!await exitFullscreen() || token !== intent) return;
    navigationBusy = true;
    await remember(true);
    if (token === intent) location.assign("https://www.youtube.com/");
    else navigationBusy = false;
  }
  async function execute(action) {
    cancelPending();
    const token = intent;
    if (["up", "down", "left", "right"].includes(action)) return region === "player" ? playerMove(action) : move(action);
    if (action === "search") return enterSearch(token);
    if (action === "home") return goHome(token);
    if (action === "sidebar") return enterSidebar(token);
    if (action === "player") return enterPlayer();
    if (action === "confirm") return confirm();
    if (action === "togglePlayback") return togglePlayback();
    if (action === "fullscreen") return fullscreen();
    if (action === "historyBack") return historyBack();
    if (action === "back") {
      if (region === "search") return backFromSearch();
      if (document.fullscreenElement) return exitFullscreen();
      if (region === "sidebar") return enterPlayer();
      return historyBack();
    }
  }
  function logEvent(event, action = "") {
    if (Date.now() > diagnosticsUntil) return;
    const redact = D.editing(event.target) && (event.isComposing || event.key?.length === 1) || event.type !== "keydown";
    send({ type: "remote:diagnostic", event: { type: event.type, key: redact ? "<文字输入>" : event.key || "",
      code: redact ? "<不记录文字>" : event.code, repeat: event.repeat, composing: composing || event.isComposing, region, action } });
  }
  window.addEventListener("keydown", (event) => {
    if (synthetic.has(event)) return;
    if (D.routeKey() !== route) void enterRoute();
    if (event.isComposing || composing || event.keyCode === 229 || event.key === "Process") {
      matcher.reset(); logEvent(event); return;
    }
    if (event.key === "Tab") { tabFocus = true; cancelPending(); }
    const input = D.searchInput();
    const atSearch = input && (event.target === input || document.activeElement === input);
    if (atSearch && region !== "search" && event.key?.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey) {
      searchReturn = snapshot(); cancelPending(); setRegion("search");
    }
    const inSearch = atSearch && region === "search";
    const action = matcher.match(event, settings, region);
    logEvent(event, action);
    if (!settings.enabled || !action) return;
    if (event.defaultPrevented) return;
    if (D.editing(event.target) && event.key?.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey) {
      matcher.reset(); return;
    }
    if (D.editing(event.target) && !atSearch && action !== "search") { matcher.reset(); cancelPending(); return; }
    if (inSearch && ["up", "down", "left", "right"].includes(action)) return;
    if (inSearch && action === "confirm" && performance.now() - compositionEnded < 80) {
      event.preventDefault(); event.stopImmediatePropagation(); return;
    }
    const dialog = D.overlay();
    if (dialog && !inSearch) {
      if (action === "back" && event.key !== "Escape") {
        event.preventDefault(); event.stopImmediatePropagation();
        const escape = new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true });
        synthetic.add(escape);
        (document.activeElement || dialog).dispatchEvent(escape);
      }
      if (["search", "sidebar", "player"].includes(action)) notice("请先用返回键关闭页面弹窗");
      matcher.reset();
      return;
    }
    if (D.isShorts() && ["up", "down", "left", "right"].includes(action)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const directional = ["up", "down", "left", "right"].includes(action);
    if (navigationBusy) return;
    if (!directional && (event.repeat || lastActivation.action === action && event.timeStamp - lastActivation.time < 250)) return;
    if (!directional) lastActivation = { action, time: event.timeStamp };
    void execute(action).catch(() => notice("操作暂时未完成，请稍后重试"));
  }, true);
  window.addEventListener("compositionstart", (e) => { composing = true; matcher.reset(); logEvent(e); }, true);
  window.addEventListener("compositionend", (e) => { composing = false; compositionEnded = performance.now(); logEvent(e); }, true);
  window.addEventListener("beforeinput", (e) => {
    if (settings.enabled && e.target === D.searchInput() && region !== "search") {
      searchReturn = snapshot(); cancelPending(); setRegion("search");
    }
    logEvent(e);
  }, true);
  window.addEventListener("pointerdown", (event) => {
    if (!settings.enabled || !D.editing(event.target)) return;
    cancelPending(); matcher.reset();
    if (event.target === D.searchInput() && region !== "search") { searchReturn = snapshot(); setRegion("search"); }
  }, true);
  window.addEventListener("focusin", (event) => {
    if (settings.enabled && tabFocus && event.target === D.searchInput() && region !== "search") {
      searchReturn = snapshot(); cancelPending(); setRegion("search");
    } else if (settings.enabled && D.editing(event.target) && event.target !== D.searchInput()) {
      cancelPending(); matcher.reset();
    }
    tabFocus = false;
  }, true);
  document.addEventListener("fullscreenchange", render);
  window.addEventListener("popstate", () => void enterRoute(true));
  window.addEventListener("pageshow", (event) => { if (event.persisted) void enterRoute(true, true); });
  window.addEventListener("pagehide", () => { void remember(true); cancelPending(); });
  document.addEventListener("yt-navigate-start", () => void remember(true));
  document.addEventListener("yt-navigate-finish", () => void enterRoute());
  window.addEventListener("scroll", () => { if (!pending && D.routeKey() === route) remember(); }, true);
  window.addEventListener("resize", () => { if (pending) tickPending(); });
  new MutationObserver(() => {
    if (mutationTimer) return;
    mutationTimer = setTimeout(() => {
      mutationTimer = null;
      if (D.routeKey() !== route) void enterRoute();
      if (selected && (!D.visible(selected.element) || D.identity(selected.link.href) !== selected.id)) {
        const saved = { ...(lastSnapshot || snapshot()), id: selected.id, index: selectedIndex };
        clearSelection();
        if (!pending && settings.enabled && ["list", "sidebar"].includes(region) &&
          (!D.editing(document.activeElement) || document.activeElement === D.searchInput())) restore(saved, intent);
      }
      if (pending) tickPending();
      render();
    }, 50);
  }).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden", "style", "href"] });
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    if (changes.diagnosticsUntil) diagnosticsUntil = Number(changes.diagnosticsUntil.newValue) || 0;
    if (changes.remoteSettings) {
      settings = R.normalize(changes.remoteSettings.newValue);
      cancelPending(); matcher.reset();
      if (!settings.enabled) clearHighlight();
      else if (selected && ["list", "sidebar"].includes(region)) selected.element.classList.add(highlight);
      render();
    }
  });
  void chrome.storage.local.get(["remoteSettings", "diagnosticsUntil"]).then((stored) => {
    settings = R.normalize(stored.remoteSettings);
    diagnosticsUntil = Number(stored.diagnosticsUntil) || 0;
    const back = performance.getEntriesByType("navigation")[0]?.type === "back_forward";
    void enterRoute(back, true);
    render();
  });
})();
