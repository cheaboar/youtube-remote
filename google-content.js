(function () {
  "use strict";
  const R = globalThis.YouTubeRemote;
  const G = globalThis.GoogleRemoteDOM;
  if (!R || !G || window !== window.top) return;

  const highlight = "google-keyboard-selected";
  const DIRECTIONS = new Set(["up", "down", "left", "right"]);
  const FILTER_KEY = "googleRemoteFilter";

  let settings = R.cloneDefaults();
  let route = G.routeKey();
  // Filtering is opt-in: without it the arrows keep Google's native scrolling. A double tap of →
  // starts it, and from then on ↑↓ move through the results while ←→ turn the result pages.
  let selected = null;
  let transient = "";
  let messageTimer;
  let confirmTimer = null;
  let browserActive = false;
  let composing = false;
  let diagnosticsUntil = 0;
  let mutationTimer;
  let ui;
  const rightTaps = R.createTapCounter();
  const consumedKeys = new Set();

  function send(message) {
    try { return chrome.runtime.sendMessage(message).catch(() => null); }
    catch (_) { return Promise.resolve(null); }
  }
  function logEvent(event, action = "") {
    if (Date.now() > diagnosticsUntil) return;
    const redact = G.editing(event.target) && (event.isComposing || event.key?.length === 1) || event.type !== "keydown";
    void send({ type: "remote:diagnostic", event: { type: event.type, key: redact ? "<文字输入>" : event.key || "",
      code: redact ? "<不记录文字>" : event.code, repeat: event.repeat, composing: composing || event.isComposing,
      region: "results", action } });
  }
  function notice(message) {
    transient = message;
    clearTimeout(messageTimer);
    messageTimer = setTimeout(() => { transient = ""; render(); }, 2400);
    render();
  }
  function cancelConfirm() {
    if (confirmTimer) clearTimeout(confirmTimer);
    confirmTimer = null;
  }
  function items() { return G.cards(); }
  function validSelected() {
    if (!selected) return null;
    return items().find(item => item.id === selected.id) || null;
  }
  function remember(on) {
    try {
      if (on) sessionStorage.setItem(FILTER_KEY, "1");
      else sessionStorage.removeItem(FILTER_KEY);
    } catch (_) { /* A blocked session store only costs the page-turn memory. */ }
  }
  function remembering() {
    try { return sessionStorage.getItem(FILTER_KEY) === "1"; }
    catch (_) { return false; }
  }
  function clearSelection({ forget = true } = {}) {
    selected?.element.classList.remove(highlight);
    selected = null;
    if (forget) remember(false);
    render();
  }
  function select(item, { scroll = true } = {}) {
    if (!item) return;
    selected?.element.classList.remove(highlight);
    selected = item;
    item.element.classList.add(highlight);
    if (scroll) item.element.scrollIntoView({ behavior: "instant", block: "nearest", inline: "nearest" });
    render();
  }
  function enterSelection() {
    const list = items();
    if (!list.length) return notice("当前页面没有可选择的搜索结果");
    if (validSelected()) return notice("已在搜索结果中，↑↓ 选择");
    remember(true);
    select(G.firstVisible(list) || list[0]);
  }
  function move(action) {
    const list = items();
    if (!list.length) { clearSelection(); return notice("当前页面没有可选择的搜索结果"); }
    const current = validSelected();
    if (!current) return select(G.firstVisible(list) || list[0]);
    const step = action === "up" ? -1 : 1;
    const index = list.findIndex(item => item.id === current.id);
    select(list[Math.max(0, Math.min(list.length - 1, index + step))]);
  }
  function turnPage(action) {
    const link = G.pageLink(action === "right" ? "next" : "previous");
    if (!link) return notice(action === "right" ? "已经是最后一页" : "已经是第一页");
    // The filter stays armed across the turn: the next page opens with its first result selected.
    remember(true);
    location.assign(link.href);
  }
  function openSelected() {
    const item = validSelected();
    if (!item) return notice("请先选择一条搜索结果");
    location.assign(item.href);
  }
  function focusSearch() {
    const input = G.searchInput();
    if (!input) return notice("未找到搜索框");
    input.focus({ preventScroll: false });
    input.select?.();
    notice("已定位搜索框");
  }
  function leaveSelection() {
    clearSelection();
    notice("已退出搜索结果筛选");
  }
  // The first confirm press waits for the double interval so the browser-mode entry gesture
  // (a double tap of the same key) can claim it; browser.js cancels this timer when it does.
  function scheduleConfirm() {
    if (confirmTimer) { cancelConfirm(); openSelected(); return; }
    confirmTimer = setTimeout(() => {
      confirmTimer = null;
      openSelected();
    }, settings.doubleInterval);
  }

  function consume(event) {
    event.preventDefault();
    event.stopImmediatePropagation();
    consumedKeys.add(event.code || event.key);
  }
  function activatable(target) {
    return target instanceof Element && !!target.closest("button,a[href],summary,label," +
      "[role='button'],[role='link'],[role='menuitem'],[role='option'],[role='tab']");
  }

  function onKeyDown(event) {
    if (browserActive) return;
    if (G.routeKey() !== route) syncRoute();
    if (event.isComposing || composing || event.keyCode === 229 || event.key === "Process") {
      logEvent(event); cancelConfirm(); rightTaps.reset(); return;
    }
    // Google's own search box keeps native typing and caret movement.
    if (G.editing(event.target)) { logEvent(event); cancelConfirm(); rightTaps.reset(); return; }
    const value = R.chord(event);
    const action = R.resolve(settings, value);
    logEvent(event, action);
    if (!settings.enabled || !action) { rightTaps.reset(); return; }
    // The entry gesture: a double tap of →. The single tap does nothing on Google, so it is
    // swallowed here instead of scrolling the page or moving a caret.
    if (!selected && action === "right") {
      if (event.defaultPrevented) return;
      consume(event);
      if (rightTaps.press(event, settings.doubleInterval) >= 2) {
        rightTaps.reset();
        cancelConfirm();
        enterSelection();
      }
      return;
    }
    if (action !== "right") rightTaps.reset();
    // The shortcut keys work anywhere on the page; the selection keys only after filtering began,
    // so Google's native scrolling and link activation stay untouched until then.
    if (action === "search") {
      if (event.repeat || event.defaultPrevented) return;
      consume(event);
      cancelConfirm();
      return focusSearch();
    }
    if (action === "historyBack") {
      if (event.repeat || event.defaultPrevented) return;
      consume(event);
      cancelConfirm();
      return history.back();
    }
    if (!selected) return;
    if (action === "confirm" && activatable(event.target)) { cancelConfirm(); return; }
    if (!DIRECTIONS.has(action) && action !== "confirm" && action !== "back") return;
    if (event.defaultPrevented) return;
    consume(event);
    if (action === "confirm") {
      if (!event.repeat) scheduleConfirm();
      return;
    }
    if (event.repeat && !DIRECTIONS.has(action)) return;
    cancelConfirm();
    if (action === "back") return leaveSelection();
    // ←→ turn the result pages; ↑↓ move between the results on the current page.
    if (action === "left" || action === "right") return turnPage(action);
    move(action);
  }

  function syncRoute() {
    const next = G.routeKey();
    if (next === route) return;
    route = next;
    cancelConfirm();
    rightTaps.reset();
    // A page turn keeps the filter armed and starts on the new page's first result; any other
    // navigation ends it, so an unrelated Google page does not inherit a stale highlight.
    const keep = remembering() && !!items().length;
    selected?.element.classList.remove(highlight);
    selected = null;
    render();
    if (keep) {
      const list = items();
      if (list.length) select(G.firstVisible(list) || list[0]);
      else remember(false);
    } else remember(false);
  }
  function refresh() {
    if (selected) {
      const current = validSelected();
      if (!current) clearSelection();
      else if (current.element !== selected.element) {
        selected.element.classList.remove(highlight);
        selected = current;
        current.element.classList.add(highlight);
      }
    }
    render();
  }

  function render() {
    if (!document.documentElement) return;
    if (!ui) {
      const host = document.createElement("div");
      host.id = "google-remote-status";
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
    const list = items();
    const index = selected ? list.findIndex(item => item.id === selected.id) : -1;
    const title = index >= 0 ? `搜索结果 ${index + 1} / ${list.length}` : "谷歌搜索";
    const confirmLabel = settings.bindings.confirm && settings.bindings.confirm !== "Enter"
      ? R.label(settings.bindings.confirm) : "Enter";
    const rightKey = settings.bindings.right ? R.label(settings.bindings.right) : "→";
    const detail = transient || (index >= 0
      ? `↑↓ 选择 · ←→ 翻页 · ${confirmLabel} 打开 · Esc 取消筛选`
      : `双击 ${rightKey} 筛选搜索结果 · ↑↓ 滚动页面`);
    if (ui.title.textContent !== title) ui.title.textContent = title;
    if (ui.detail.textContent !== detail) ui.detail.textContent = detail;
    ui.host.dataset.results = String(list.length);
    ui.host.dataset.selected = index >= 0 ? String(index + 1) : "";
    ui.host.dataset.page = G.pageLink("previous") ? "middle" : "first";
    const hidden = !settings.enabled || browserActive || (!settings.showStatus && !transient) || !!document.fullscreenElement;
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
    composing = true; logEvent(event); cancelConfirm(); rightTaps.reset();
  }, true);
  window.addEventListener("compositionend", (event) => { composing = false; logEvent(event); }, true);
  window.addEventListener("blur", () => { composing = false; cancelConfirm(); rightTaps.reset(); consumedKeys.clear(); });
  window.addEventListener("popstate", () => { route = ""; syncRoute(); });
  new MutationObserver(() => {
    if (mutationTimer) return;
    mutationTimer = setTimeout(() => { mutationTimer = null; refresh(); }, 150);
  }).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ["href", "style", "hidden"] });

  // browser.js drives the browser-wide mode and calls back here so the pending single confirm
  // is cancelled and result filtering pauses while the HUD owns input.
  globalThis.__youtubeRemoteHost = {
    entryAllowed() { return settings.enabled && !composing; },
    entryPressed() { cancelConfirm(); },
    activate() { browserActive = true; cancelConfirm(); rightTaps.reset(); clearSelection(); render(); },
    deactivate() { browserActive = false; render(); }
  };
  void chrome.storage.local.get(["remoteSettings", "diagnosticsUntil"]).then((stored) => {
    settings = R.normalize(stored.remoteSettings);
    diagnosticsUntil = Number(stored.diagnosticsUntil) || 0;
    // A reload during a page turn re-arms the filter on the fresh result list.
    if (remembering() && items().length) select(G.firstVisible(items()) || items()[0]);
    else remember(false);
    render();
  });
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    if (changes.diagnosticsUntil) diagnosticsUntil = Number(changes.diagnosticsUntil.newValue) || 0;
    if (!changes.remoteSettings) return;
    settings = R.normalize(changes.remoteSettings.newValue);
    cancelConfirm();
    rightTaps.reset();
    if (!settings.enabled) clearSelection();
    render();
  });
  render();
})();
