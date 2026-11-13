(function () {
  "use strict";
  const R = globalThis.YouTubeRemote;
  const { nextItem } = globalThis.YouTubeKeyboardNavigation || {};
  const SITE = detectSite();
  if (!R || !SITE || !nextItem) return;
  const D = globalThis[SITE.adapter];

  const panel = globalThis.RemoteCommandPanel?.create({
    id: `${SITE.id}-panel`, title: `${SITE.short}播放页指令`, ariaLabel: `${SITE.name}播放页指令面板`, label: R.label
  });
  const matcher = R.createMatcher();
  const DIRECTIONS = new Set(["up", "down", "left", "right"]);
  const SUPPORTED = new Set([...DIRECTIONS, "confirm", "back", "togglePlayback", "fullscreen", "historyBack", "home", "search", "sidebar"]);
  const arrows = { up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight" };

  let settings = R.cloneDefaults();
  let route = D.routeKey();
  let region = pageRegion();
  let selected = null;
  let railSelected = null;
  let transient = "";
  let messageTimer;
  let confirmTimer = null;
  let downTapTimer = null;
  let panelOpen = false;
  let browserActive = false;
  let composing = false;
  let diagnosticsUntil = 0;
  let mutationTimer;
  let ui;
  const consumedKeys = new Set();

  function detectSite() {
    if (globalThis.BilibiliRemoteDOM) return {
      adapter: "BilibiliRemoteDOM", id: "bilibili-remote", name: "哔哩哔哩", short: "B站",
      names: { list: "哔哩哔哩", player: "B站播放器", rail: "右侧视频" },
      home: "https://www.bilibili.com/", homeName: "哔哩哔哩首页",
      sequences: "bilibiliSequences", highlight: "bilibili-keyboard-selected",
      selectionKey: "bilibiliRemoteSelection", infinte: true,
      interact: { like: "点赞", coin: "投币", fav: "收藏", share: "分享" }
    };
    if (globalThis.YoukuRemoteDOM) return {
      adapter: "YoukuRemoteDOM", id: "youku-remote", name: "优酷", short: "优酷",
      names: { list: "优酷", player: "优酷播放器", rail: "右侧视频" },
      home: "https://www.youku.com/ku/webhome", homeName: "优酷首页",
      sequences: "youkuSequences", highlight: "youku-keyboard-selected",
      selectionKey: "youkuRemoteSelection", infinte: false,
      interact: {}
    };
    return null;
  }

  function send(message) {
    try { return chrome.runtime.sendMessage(message).catch(() => null); }
    catch (_) { return Promise.resolve(null); }
  }
  function logEvent(event, action = "") {
    if (Date.now() > diagnosticsUntil) return;
    const redact = D.editing(event.target) && (event.isComposing || event.key?.length === 1) || event.type !== "keydown";
    void send({ type: "remote:diagnostic", event: { type: event.type, key: redact ? "<文字输入>" : event.key || "",
      code: redact ? "<不记录文字>" : event.code, repeat: event.repeat, composing: composing || event.isComposing,
      region, action } });
  }
  function notice(message) {
    transient = message;
    clearTimeout(messageTimer);
    messageTimer = setTimeout(() => { transient = ""; render(); }, 2800);
    render();
  }
  function cancelConfirm() {
    if (confirmTimer) clearTimeout(confirmTimer);
    confirmTimer = null;
  }
  function cancelDownTap() {
    if (downTapTimer) clearTimeout(downTapTimer);
    downTapTimer = null;
  }
  function clearHighlight() {
    selected?.element.classList.remove(SITE.highlight);
    document.querySelectorAll(`.${SITE.highlight}`).forEach(element => element.classList.remove(SITE.highlight));
  }
  function clearSelection() { clearHighlight(); selected = null; }
  function clearRail() {
    railSelected?.element.classList.remove(SITE.highlight);
    railSelected = null;
    render();
  }
  function selectRail(item, { scroll = true } = {}) {
    if (!item) return;
    railSelected?.element.classList.remove(SITE.highlight);
    railSelected = item;
    item.element.classList.add(SITE.highlight);
    if (scroll) item.element.scrollIntoView({ behavior: "instant", block: "nearest", inline: "nearest" });
    render();
  }
  function activatable(target) {
    return target instanceof Element && !!target.closest("button,a[href],summary,label," +
      "[role='button'],[role='link'],[role='menuitem'],[role='option'],[role='tab']");
  }
  function pageRegion() { return D.isVideo() ? "player" : "list"; }
  function items() { return D.cards(); }
  function railItems() { return D.railCards(); }
  function validSelected() {
    if (!selected) return null;
    return items().find(item => item.id === selected.id) || null;
  }
  function validRail() {
    if (!railSelected) return null;
    return railItems().find(item => item.id === railSelected.id) || null;
  }
  function saveState() {
    if (!D.isGrid() || !selected) return;
    const index = items().findIndex(item => item.id === selected.id);
    try { sessionStorage.setItem(SITE.selectionKey, JSON.stringify({ id: selected.id, index: Math.max(0, index) })); }
    catch (_) { /* Private mode may reject sessionStorage. */ }
  }
  function savedState() {
    try { return JSON.parse(sessionStorage.getItem(SITE.selectionKey)) || null; }
    catch (_) { return null; }
  }
  function select(item, { scroll = true } = {}) {
    if (!item) return;
    clearHighlight();
    selected = item;
    item.element.classList.add(SITE.highlight);
    // Cards outside the viewport scroll the page vertically. The horizontal `nearest` keeps a
    // Youku carousel's shared clipped container from moving sideways.
    if (scroll) item.element.scrollIntoView({ behavior: "instant", block: "nearest", inline: "nearest" });
    saveState();
    render();
  }
  function waitUntil(attempt, timeout = 3000) {
    return new Promise(resolve => {
      const deadline = Date.now() + timeout;
      const tick = () => {
        if (attempt()) return resolve(true);
        if (Date.now() >= deadline) return resolve(false);
        setTimeout(tick, 120);
      };
      tick();
    });
  }
  async function restoreSelection() {
    if (selected) return;
    const saved = savedState();
    if (!saved?.id) return;
    const found = await waitUntil(() => {
      if (selected) return true;
      const item = items().find(candidate => candidate.id === saved.id);
      if (!item) return false;
      select(item);
      return true;
    }, 5000);
    if (found || selected) return;
    // Feeds reshuffle between visits, so fall back to the remembered position.
    const list = items();
    if (!list.length) { render(); return; }
    select(list[Math.min(Number(saved.index) || 0, list.length - 1)]);
    notice("原视频已不在列表中，已定位到附近位置");
  }

  function syncRoute() {
    const nextRoute = D.routeKey();
    if (nextRoute === route) return;
    saveState();
    route = nextRoute;
    cancelConfirm();
    cancelDownTap();
    closePanel();
    matcher.reset();
    clearSelection();
    clearRail();
    region = pageRegion();
    if (region === "list") void restoreSelection();
    render();
  }
  function refresh() {
    if (!settings.enabled) return;
    syncRoute();
    const nextRegion = pageRegion();
    if (nextRegion !== region) {
      region = nextRegion;
      matcher.reset();
      clearSelection();
      render();
    }
    if (selected) {
      const current = validSelected();
      if (current) {
        if (current.element !== selected.element) {
          selected.element.classList.remove(SITE.highlight);
          selected = current;
          current.element.classList.add(SITE.highlight);
        }
      } else clearSelection();
    }
    if (railSelected) {
      if (region !== "player") clearRail();
      else {
        const current = validRail();
        if (!current) clearRail();
        else if (current.element !== railSelected.element) {
          railSelected.element.classList.remove(SITE.highlight);
          railSelected = current;
          current.element.classList.add(SITE.highlight);
        }
      }
    }
    render();
  }

  function move(action) {
    if (region === "player") return railSelected ? railMove(action) : playerMove(action);
    const list = items();
    if (!list.length) {
      if (!D.isGrid()) return notice("当前页面没有可选择的视频");
      notice("正在等待视频加载…");
      void waitUntil(() => {
        const loaded = items();
        if (!loaded.length) return false;
        select(D.firstVisible(loaded));
        return true;
      }, 4000);
      return;
    }
    const current = validSelected();
    if (!current) return select(D.firstVisible(list));
    const next = nextItem(list, current.element, arrows[action]);
    if (!next) return;
    if (next.element === current.element) {
      if (SITE.infinte && (action === "down" || action === "right")) loadMore(current);
      return;
    }
    select(next);
  }
  function loadMore(current) {
    const before = items().length;
    D.scrollForMore(current.element);
    void waitUntil(() => {
      const list = items();
      if (list.length <= before) return false;
      const still = list.find(item => item.id === current.id);
      if (!still) return false;
      const next = nextItem(list, still.element, arrows.down);
      if (next.element === still.element) return false;
      select(next);
      return true;
    }, 2500);
  }

  // Double ↓ enters the recommendation rail, matching the Douyin player. A single ↓ changes the
  // volume after the double interval instead of paging the page.
  function enterRail() {
    if (region !== "player") return;
    cancelDownTap();
    const enter = (list) => {
      clearSelection();
      selectRail(D.firstVisible(list) || list[0]);
      notice("已定位到右侧视频，方向键选择");
    };
    const list = railItems();
    if (list.length) return enter(list);
    notice("正在等待右侧视频加载…");
    void waitUntil(() => {
      const loaded = railItems();
      if (!loaded.length) return false;
      enter(loaded);
      return true;
    }, 4000);
  }
  function railMove(action) {
    const list = railItems();
    if (!list.length) { clearRail(); return notice("右侧没有可选视频"); }
    const current = validRail();
    if (!current) return selectRail(D.firstVisible(list) || list[0]);
    const next = nextItem(list, current.element, arrows[action]);
    if (next && next.element !== current.element) selectRail(next);
  }

  function pageScroll(direction) {
    const scroller = D.pageScroller() || document.scrollingElement;
    if (!scroller) return;
    const step = Math.max(220, Math.min(720, (scroller.clientHeight || innerHeight) * 0.85));
    scroller.scrollBy({ top: direction === "up" ? -step : step, behavior: "instant" });
  }
  function pageTop() {
    const scroller = D.pageScroller() || document.scrollingElement;
    if (!scroller) return;
    scroller.scrollTo({ top: 0, behavior: "instant" });
  }

  function seek(amount) {
    if (region !== "player") return notice("当前页面没有播放器");
    const video = D.video();
    if (!video) return notice("播放器尚未就绪");
    const start = video.seekable.length ? video.seekable.start(0) : 0;
    const end = video.seekable.length ? video.seekable.end(video.seekable.length - 1) : video.duration;
    if (!Number.isFinite(end)) return notice("当前视频暂时不能调整进度");
    video.currentTime = Math.max(start, Math.min(end, video.currentTime + amount));
  }
  function playerMove(action) {
    if (action !== "left" && action !== "right") return;
    seek(action === "left" ? -5 : 5);
  }
  function adjustVolume(delta) {
    if (region !== "player") return notice("当前页面没有播放器");
    const video = D.video();
    if (!video) return notice("播放器尚未就绪");
    if (video.muted && delta > 0) video.muted = false;
    video.volume = Math.max(0, Math.min(1, Math.round((video.volume + delta) * 100) / 100));
    if (video.volume === 0) video.muted = true;
    notice(video.muted ? "已静音" : `音量 ${Math.round(video.volume * 100)}%`);
  }
  function togglePlayback() {
    if (region !== "player") return notice("当前页面没有播放器");
    const video = D.video();
    if (!video) return notice("播放器尚未就绪");
    if (video.paused) video.play().catch(() => notice("播放被浏览器阻止，请在播放器上确认播放"));
    else video.pause();
  }
  function fullscreen() {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => null);
      return;
    }
    if (region !== "player") return notice("当前页面没有播放器");
    const player = D.player();
    if (!player) return notice("播放器尚未就绪");
    player.requestFullscreen().catch(() => notice("无法进入全屏，请使用播放器全屏按钮"));
  }
  function focusSearch() {
    const input = D.searchInput();
    if (!input) return notice("未找到搜索框");
    input.focus({ preventScroll: false });
    input.select?.();
    notice("已定位搜索框");
  }

  function bindingHint(action) {
    const value = settings.bindings[action];
    return value ? R.label(value) : "";
  }
  function controlOption(name, label) {
    return D.control(name) ? { action: name, label } : null;
  }
  function sequenceKeys(action) {
    const keys = settings[SITE.sequences]?.[action];
    return Array.isArray(keys) && keys.length ? keys.slice() : [];
  }
  function panelGroups() {
    const playback = [
      { action: "togglePlayback", label: "播放 / 暂停", hint: bindingHint("togglePlayback") },
      { action: "seekBackward", label: "后退 5 秒" },
      { action: "seekForward", label: "前进 5 秒" },
      { action: "mute", label: "静音 / 取消静音" },
      { action: "fullscreen", label: "全屏", hint: bindingHint("fullscreen") },
      controlOption("pageFullscreen", "网页全屏"),
      controlOption("danmaku", "弹幕开关")
    ];
    const interact = Object.entries(SITE.interact)
      .map(([name, label]) => controlOption(name, label))
      .concat(D.commentList() ? [{ action: "comments", label: "评论区" }] : []);
    const pick = [
      { action: "rail", label: "右侧推荐视频",
        hint: settings.bindings.down ? `双击 ${R.label(settings.bindings.down)}` : "" },
      controlOption("nextEpisode", "下一集"),
      { action: "pageDown", label: "向下翻页" },
      { action: "pageUp", label: "向上翻页" }
    ];
    const nav = [
      { action: "search", label: "搜索", hint: bindingHint("search") },
      { action: "home", label: SITE.homeName, hint: bindingHint("home") },
      { action: "historyBack", label: "返回上一页", hint: bindingHint("historyBack") },
      { action: "scrollTop", label: "回到顶部" }
    ];
    return [
      { id: "playback", title: "播放", actions: playback },
      { id: "interact", title: "互动", actions: interact },
      { id: "pick", title: "选片", actions: pick },
      { id: "nav", title: "导航", actions: nav }
    ].map(group => ({ ...group, actions: group.actions.filter(Boolean) }))
      .filter(group => group.actions.length);
  }
  function openPanel() {
    if (!panel || panelOpen || region !== "player" || railSelected) return;
    if (D.overlay()) return notice("请先关闭网页弹窗");
    cancelConfirm();
    cancelDownTap();
    matcher.reset();
    const confirmLabel = settings.bindings.confirm && settings.bindings.confirm !== "Enter"
      ? `${R.label(settings.bindings.confirm)} / Enter` : "Enter";
    const backLabel = settings.bindings.back && settings.bindings.back !== "Escape"
      ? `${R.label(settings.bindings.back)} / Esc` : "Esc";
    const downHint = settings.bindings.down ? `双击 ${R.label(settings.bindings.down)} 右侧视频` : "";
    const startHint = `${R.label(settings.bindings.left || "ArrowLeft")} / ${R.label(settings.bindings.right || "ArrowRight")} 输入组合`;
    const groups = panelGroups().map(group => ({
      ...group,
      actions: group.actions.map(item => ({ ...item, keys: sequenceKeys(item.action) }))
    }));
    const opened = panel.open(groups, {
      selected: "togglePlayback",
      subtitle: `↑↓ 选择 · ${confirmLabel} 执行 · ${backLabel} 关闭`,
      footer: [downHint, "三击确认键进入浏览器模式"].filter(Boolean).join(" · "),
      startHint
    });
    if (!opened) return notice("当前页面没有可用指令");
    panelOpen = true;
    render();
  }
  function closePanel() {
    if (!panelOpen) return;
    panelOpen = false;
    panel?.close();
    matcher.reset();
    render();
  }
  function runPanelAction(action) {
    switch (action) {
      case "togglePlayback": return togglePlayback();
      case "seekBackward": return seek(-5);
      case "seekForward": return seek(5);
      case "mute": return toggleMute();
      case "fullscreen": return fullscreen();
      case "pageFullscreen": return clickControl("pageFullscreen", "未找到网页全屏按钮");
      case "danmaku": return clickControl("danmaku", "未找到弹幕开关");
      case "nextEpisode": return clickControl("nextEpisode", "没有下一集");
      case "like": return clickControl("like", "未找到点赞按钮");
      case "coin": return clickControl("coin", "未找到投币按钮");
      case "fav": return clickControl("fav", "未找到收藏按钮");
      case "share": return clickControl("share", "未找到分享按钮");
      case "comments": return openComments();
      case "rail": return enterRail();
      case "pageDown": return pageScroll("down");
      case "pageUp": return pageScroll("up");
      case "scrollTop": return pageTop();
      case "search": return focusSearch();
      case "home": return location.assign(SITE.home);
      case "historyBack": return history.back();
    }
  }
  function runPanel() {
    const action = panel?.selected();
    if (!action) return closePanel();
    closePanel();
    runPanelAction(action);
  }
  function startsSequence(value) {
    return value === "ArrowLeft" || value === "ArrowRight" ||
      value === settings.bindings.left || value === settings.bindings.right;
  }
  function typeSequence(value) {
    const result = panel.type(value);
    if (!result?.action) return;
    closePanel();
    runPanelAction(result.action);
  }
  function panelKey(event) {
    logEvent(event, "panel");
    const value = R.chord(event);
    if (!value) return;
    consume(event);
    if (event.isComposing || composing || event.keyCode === 229) { closePanel(); return; }
    if (event.key === "Escape" || value === settings.bindings.back) { closePanel(); return; }
    if (event.key === "Backspace") { panel.undo(); return; }
    if (event.repeat) return;
    const confirming = value === "Enter" || value === settings.bindings.confirm;
    if (panel.hasPrefix()) {
      if (confirming) runPanel();
      else typeSequence(value);
      return;
    }
    const base = R.resolve(settings, value);
    if (base === "up" || value === "ArrowUp") { panel.move(-1); return; }
    if (base === "down" || value === "ArrowDown") { panel.move(1); return; }
    if (startsSequence(value)) { typeSequence(value); return; }
    if (confirming) runPanel();
  }
  function toggleMute() {
    if (region !== "player") return notice("当前页面没有播放器");
    const video = D.video();
    if (!video) return notice("播放器尚未就绪");
    video.muted = !video.muted;
    if (!video.muted && video.volume === 0) video.volume = 1;
    notice(video.muted ? "已静音" : "已取消静音");
  }
  function clickControl(name, failText) {
    const element = D.control(name);
    if (!element) return notice(failText);
    element.click();
  }
  function openComments() {
    const list = D.commentList();
    if (list) {
      list.scrollIntoView({ behavior: "instant", block: "start" });
      return notice("已定位评论区");
    }
    return notice("未找到评论区");
  }

  function scheduleConfirm() {
    if (confirmTimer) {
      cancelConfirm();
      if (region === "player" && !railSelected) openPanel();
      return;
    }
    confirmTimer = setTimeout(() => {
      confirmTimer = null;
      openSelected();
    }, settings.doubleInterval);
  }
  function openSelected() {
    if (railSelected) {
      const item = validRail();
      if (!item) return notice("视频尚未加载，请稍后重试");
      selectRail(item);
      location.assign(item.href);
      return;
    }
    if (region === "player") return togglePlayback();
    const list = items();
    const item = validSelected() || D.firstVisible(list);
    if (!item) return notice("视频尚未加载，请稍后重试");
    select(item);
    saveState();
    location.assign(item.href);
  }
  function goBack() {
    cancelDownTap();
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => null);
      return;
    }
    if (railSelected) { clearRail(); notice("已返回播放器"); return; }
    if (history.length > 1) history.back();
    else location.assign(SITE.home);
  }
  function run(action) {
    if (DIRECTIONS.has(action)) return move(action);
    if (action === "confirm") return scheduleConfirm();
    if (action === "back") return goBack();
    if (action === "togglePlayback") return togglePlayback();
    if (action === "fullscreen") return fullscreen();
    if (action === "historyBack") return history.back();
    if (action === "home") return location.assign(SITE.home);
    if (action === "search") return focusSearch();
    if (action === "sidebar") return enterRail();
  }

  function consume(event) {
    event.preventDefault();
    event.stopImmediatePropagation();
    consumedKeys.add(event.code || event.key);
  }

  function onKeyDown(event) {
    if (browserActive) return;
    if (D.routeKey() !== route) syncRoute();
    if (panelOpen) { panelKey(event); return; }
    if (event.isComposing || composing || event.keyCode === 229 || event.key === "Process") {
      logEvent(event); cancelConfirm(); matcher.reset(); return;
    }
    if (D.editing(event.target)) { logEvent(event); cancelConfirm(); matcher.reset(); return; }
    const value = R.chord(event);
    if (value !== settings.bindings.down) cancelDownTap();
    const resolved = R.resolve(settings, value);
    // The player owns ↑↓: ↑ raises the volume, a single ↓ lowers it after the double interval,
    // and a quick second ↓ opens the recommendation rail.
    if (settings.enabled && region === "player" && !railSelected &&
        (resolved === "up" || resolved === "down")) {
      logEvent(event, resolved);
      if (D.overlay()) { cancelDownTap(); return; }
      if (event.defaultPrevented) return;
      consume(event);
      if (resolved === "up") { cancelDownTap(); adjustVolume(0.1); return; }
      if (event.repeat) { cancelDownTap(); adjustVolume(-0.1); return; }
      if (downTapTimer) { cancelDownTap(); enterRail(); return; }
      downTapTimer = setTimeout(() => {
        downTapTimer = null;
        adjustVolume(-0.1);
      }, settings.doubleInterval);
      return;
    }
    let action = matcher.match(event, settings, region, "watch");
    if (event.repeat && R.resolve(settings, value) === "confirm") action = "confirm";
    logEvent(event, action);
    if (!settings.enabled || !action) return;
    if (!SUPPORTED.has(action)) {
      const base = R.resolve(settings, value);
      if (!base || !SUPPORTED.has(base)) return;
      action = base;
    }
    if (railSelected) {
      const base = R.resolve(settings, value);
      if (base && DIRECTIONS.has(base)) action = base;
    }
    if (action === "confirm" && activatable(event.target)) { cancelConfirm(); return; }
    if (D.overlay()) { matcher.reset(); cancelConfirm(); return; }
    if (event.defaultPrevented) return;
    consume(event);
    if (action === "confirm") {
      if (!event.repeat) scheduleConfirm();
      return;
    }
    if (event.repeat && !DIRECTIONS.has(action)) return;
    cancelConfirm();
    run(action);
  }

  function render() {
    if (!document.documentElement) return;
    if (!ui) {
      const host = document.createElement("div");
      host.id = `${SITE.id}-status`;
      const shadow = host.attachShadow({ mode: "open" });
      const style = document.createElement("style");
      style.textContent = `
        :host{position:fixed;bottom:20px;right:20px;z-index:2147483647;pointer-events:none;color-scheme:light}
        div{max-width:min(460px,calc(100vw - 40px));padding:11px 17px;border:1px solid rgba(255,255,255,.76);border-radius:18px;
          background:linear-gradient(145deg,rgba(255,255,255,.28),rgba(255,255,255,.06)),rgba(246,247,249,.82);
          -webkit-backdrop-filter:blur(24px) saturate(145%);backdrop-filter:blur(24px) saturate(145%);
          color:#34363b;box-shadow:0 6px 24px rgba(32,36,44,.09),inset 0 1px 0 rgba(255,255,255,.94),inset 0 -1px 0 rgba(32,36,44,.035);
          font:400 13px/1.6 -apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue","PingFang SC",sans-serif;-webkit-font-smoothing:antialiased}
        strong{font-weight:600}span{color:#575b63;margin-left:10px}
        @supports not (backdrop-filter:blur(1px)){div{background:rgba(247,248,250,.97)}}
        @media(prefers-reduced-transparency:reduce){div{background:#f6f7f9;-webkit-backdrop-filter:none;backdrop-filter:none}}
        @media(prefers-contrast:more){div{background:#f6f7f9;border-color:#858991;color:#26282d}span{color:#42464d}}
      `;
      const box = document.createElement("div");
      box.setAttribute("role", "status");
      const title = document.createElement("strong");
      const detail = document.createElement("span");
      box.append(title, detail);
      shadow.append(style, box);
      ui = { host, title, detail };
    }
    const parent = document.fullscreenElement || document.documentElement;
    if (ui.host.parentElement !== parent) parent.append(ui.host);
    const title = railSelected ? SITE.names.rail
      : region === "player" ? SITE.names.player : SITE.names.list;
    const confirmLabel = settings.bindings.confirm && settings.bindings.confirm !== "Enter"
      ? R.label(settings.bindings.confirm) : "Enter";
    const detail = transient || (railSelected
      ? "方向键选视频 · 确认播放 · Esc 返回播放器"
      : region === "player"
        ? `←→ 快进 · ↑↓ 音量 · 确认暂停 · 双击 ${confirmLabel} 指令 · 双击↓ 右侧视频 · Esc 返回`
        : D.isGrid() ? "方向键选片 · 确认播放" : "方向键浏览 · 确认打开");
    if (ui.title.textContent !== title) ui.title.textContent = title;
    if (ui.detail.textContent !== detail) ui.detail.textContent = detail;
    ui.host.dataset.region = region;
    ui.host.dataset.rail = railSelected ? "1" : "0";
    ui.host.dataset.panel = panelOpen ? "1" : "0";
    const hidden = !settings.enabled || browserActive || panelOpen || (!!document.fullscreenElement && !transient) ||
      (!settings.showStatus && !transient);
    if (ui.host.hidden !== hidden) ui.host.hidden = hidden;
  }

  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("keyup", (event) => {
    if (!consumedKeys.delete(event.code || event.key)) return;
    event.preventDefault(); event.stopImmediatePropagation();
  }, true);
  window.addEventListener("keypress", (event) => {
    if (!consumedKeys.has(event.code || event.key)) return;
    event.preventDefault(); event.stopImmediatePropagation();
  }, true);
  window.addEventListener("compositionstart", (event) => {
    composing = true; logEvent(event); cancelConfirm(); closePanel(); matcher.reset();
  }, true);
  window.addEventListener("compositionend", (event) => { composing = false; logEvent(event); }, true);
  window.addEventListener("blur", () => {
    composing = false; cancelConfirm(); cancelDownTap(); closePanel(); matcher.reset(); consumedKeys.clear();
  });
  window.addEventListener("pagehide", () => { cancelDownTap(); closePanel(); saveState(); });
  window.addEventListener("popstate", () => { route = ""; syncRoute(); });
  document.addEventListener("fullscreenchange", render);
  new MutationObserver(() => {
    if (mutationTimer) return;
    mutationTimer = setTimeout(() => { mutationTimer = null; refresh(); }, 120);
  }).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ["href", "style", "hidden"] });
  setInterval(refresh, 500);

  globalThis.__youtubeRemoteHost = {
    entryAllowed() { return settings.enabled && !composing && !panelOpen; },
    entryPressed() { cancelConfirm(); cancelDownTap(); closePanel(); matcher.reset(); },
    activate() { browserActive = true; cancelConfirm(); cancelDownTap(); closePanel(); matcher.reset(); render(); },
    deactivate() { browserActive = false; render(); }
  };
  void chrome.storage.local.get(["remoteSettings", "diagnosticsUntil"]).then((stored) => {
    settings = R.normalize(stored.remoteSettings);
    diagnosticsUntil = Number(stored.diagnosticsUntil) || 0;
    render();
    if (D.isGrid()) void restoreSelection();
  });
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    if (changes.diagnosticsUntil) diagnosticsUntil = Number(changes.diagnosticsUntil.newValue) || 0;
    if (!changes.remoteSettings) return;
    settings = R.normalize(changes.remoteSettings.newValue);
    cancelConfirm(); cancelDownTap(); closePanel(); matcher.reset();
    if (!settings.enabled) clearHighlight();
    render();
  });
  render();
})();
