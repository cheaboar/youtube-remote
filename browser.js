(function () {
  "use strict";
  const R = globalThis.YouTubeRemote;
  if (!R) return;
  const top = window === window.top;
  // YouTube spends a double tap of the confirm key on its command panel, so the browser entry
  // needs a third tap there; every other site enters on a double tap.
  const onYouTube = /^https:\/\/www\.youtube\.com\//.test(location.href);
  const ENTRY_TAPS = onYouTube ? 3 : 2;
  if (globalThis.__remoteBrowserController) { globalThis.__remoteBrowserController.reconnect(); return; }

  const settingsChanged = () => void chrome.storage.local.get("remoteSettings").then((stored) => {
    settings = R.normalize(stored.remoteSettings);
    loaded = true;
    entry.reset();
  }).catch(() => { loaded = true; });

  let settings = R.cloneDefaults();
  let loaded = false;
  let hostActive = false;
  let requestSeq = 0;
  const entry = R.createTapCounter();
  const consumed = new Set();
  const states = { active: false, revision: -1, sessionId: "", phase: "direct",
    position: 0, total: 0, activeTabId: null, selectedTabId: null, tabs: [] };
  let hud = null;
  let hudParts = null;

  const host = () => globalThis.__youtubeRemoteHost;
  function send(message) {
    try { return chrome.runtime.sendMessage(message).catch(() => null); }
    catch (_) { return Promise.resolve(null); }
  }
  function editable(target) {
    return target instanceof Element &&
      !!target.closest("input,textarea,select,[contenteditable]:not([contenteditable='false']),[role='textbox']");
  }
  // Enter activates links, buttons and form controls on ordinary pages. Keep that native meaning
  // instead of turning the first tap of the entry gesture into a click.
  function activatable(target) {
    return target instanceof Element && !!target.closest("button,a[href],summary,label," +
      "[role='button'],[role='link'],[role='menuitem'],[role='option'],[role='tab']");
  }
  function consume(event) {
    event.preventDefault();
    event.stopImmediatePropagation();
    consumed.add(event.code || event.key);
  }
  const nextRequestId = () => `${Date.now().toString(36)}-${(++requestSeq).toString(36)}`;

  function applyState(state) {
    if (!state || typeof state !== "object") return;
    // An idle controller accepts a freshly started session even if the worker's revision counter
    // restarted; an active one still rejects anything older than what it already applied.
    const newSession = state.active === true && !!state.sessionId && state.sessionId !== states.sessionId && !states.active;
    const stale = Number.isFinite(state.revision) && Number.isFinite(states.revision) && state.revision < states.revision;
    if (stale && !newSession) return;
    states.active = state.active === true;
    if (!states.active) clearPendingDirect();
    states.revision = Number.isFinite(state.revision) ? state.revision : states.revision;
    states.sessionId = typeof state.sessionId === "string" ? state.sessionId : "";
    states.phase = state.phase === "titles" ? "titles" : "direct";
    states.position = Number(state.position) || 0;
    states.total = Number(state.total) || 0;
    states.activeTabId = Number.isFinite(state.activeTabId) ? state.activeTabId : null;
    states.selectedTabId = Number.isFinite(state.selectedTabId) ? state.selectedTabId : null;
    states.tabs = states.active && Array.isArray(state.tabs) ? state.tabs.slice(0, 200) : [];
    syncHost();
    render();
  }
  // YouTube keeps its own keyboard controller. The bridge cancels delayed confirms on the first
  // entry press and suspends focus/selection recovery while the browser mode owns the keys.
  function syncHost() {
    const bridge = host();
    if (!bridge) return;
    if (states.active && !hostActive) { hostActive = true; bridge.activate?.(); }
    else if (!states.active && hostActive) { hostActive = false; bridge.deactivate?.(); }
  }

  function sendInput(input) {
    if (!states.active) return;
    const message = { type: "remote:browser-input", sessionId: states.sessionId, input, requestId: nextRequestId() };
    if (input === "activateSelected") message.expectedTabId = states.selectedTabId;
    send(message).then((result) => { if (result?.state) applyState(result.state); });
  }
  function enter() {
    entry.reset();
    send({ type: "remote:browser-enter", requestId: nextRequestId() }).then((result) => {
      if (result?.state) applyState(result.state);
    });
  }

  const literal = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right", Enter: "confirm", Escape: "back" };
  let pendingDirect = null;
  function clearPendingDirect() { if (pendingDirect) { clearTimeout(pendingDirect); pendingDirect = null; } }
  function directInput(chord) {
    const logical = literal[chord] || R.resolve(settings, chord);
    if (logical === "up") return "previousTab";
    if (logical === "down") return "nextTab";
    if (logical === "left") return "back";
    if (logical === "right") return "forward";
    if (logical === "confirm") return "reload";
    if (logical === "back") return "escape";
    return null;
  }
  function onKeyDown(event) {
    if (event.isComposing || event.keyCode === 229 || event.key === "Process") { entry.reset(); return; }
    const chord = R.chord(event);
    if (states.active) { modeKey(event, chord); return; }
    if (!loaded || !settings.enabled) { entry.reset(); return; }
    const bridge = host();
    if (!chord || chord !== settings.bindings.browser) { entry.reset(); return; }
    if (editable(event.target)) { entry.reset(); return; }
    if (!onYouTube && activatable(event.target)) { entry.reset(); return; }
    // The command panel keeps its own key grammar. Only the tap that completes the entry gesture
    // reaches it: on YouTube the second tap opens the panel and the third one enters the mode.
    const panelOpen = !!bridge?.entryAllowed && !bridge.entryAllowed();
    if (panelOpen && entry.count < ENTRY_TAPS - 1) { entry.reset(); return; }
    const taps = entry.press(event, settings.doubleInterval);
    if (taps < ENTRY_TAPS) {
      // A non-confirm entry key still cancels a delayed single confirm on its first tap.
      if (taps === 1 && chord !== settings.bindings.confirm) bridge?.entryPressed?.();
      return;
    }
    // Sharing the confirm key means the second tap opens the panel and the third one closes it;
    // if no panel is open, this press belongs to the page instead of a stale earlier double tap.
    if (ENTRY_TAPS === 3 && !panelOpen && chord === settings.bindings.confirm) { entry.reset(); return; }
    entry.reset();
    consume(event);
    bridge?.entryPressed?.();
    enter();
  }
  function modeKey(event, chord) {
    // The entry key opens the title list on a double tap. When it is also a direct action (Enter
    // reloads by default) the single press waits one interval so the double tap can win.
    if (states.phase === "direct" && chord && chord === settings.bindings.browser) {
      consume(event);
      const taps = entry.press(event, settings.doubleInterval);
      if (taps >= 2) {
        clearPendingDirect();
        entry.reset();
        sendInput("openTitles");
        return;
      }
      const input = directInput(chord);
      if (input) {
        clearPendingDirect();
        pendingDirect = setTimeout(() => {
          pendingDirect = null;
          if (states.active) sendInput(input);
        }, settings.doubleInterval);
      }
      return;
    }
    // Any other key wins over a waiting entry press.
    clearPendingDirect();
    entry.reset();
    // Browser and OS shortcuts still belong to the browser while the mode is active.
    if (event.ctrlKey || event.altKey || event.metaKey) return;
    const logical = literal[chord] || R.resolve(settings, chord);
    const direct = states.phase === "direct";
    let input = null;
    let control = true;
    if (direct) { input = directInput(chord); control = input !== null; }
    else if (logical === "up") input = "selectionPrevious";
    else if (logical === "down") input = "selectionNext";
    else if (logical === "confirm") input = "activateSelected";
    else if (logical === "back") input = "escape";
    else control = logical === "left" || logical === "right";
    if (!control) return;
    consume(event);
    if (!input) return;
    if (event.repeat && input !== "selectionPrevious" && input !== "selectionNext") return;
    sendInput(input);
  }
  function onKeyUp(event) {
    if (!consumed.delete(event.code || event.key)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }
  function onKeyPress(event) {
    if (!consumed.has(event.code || event.key)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  function refresh() {
    send({ type: "remote:browser-state" }).then((result) => { if (result?.state) applyState(result.state); });
  }

  const STYLE = `
    :host{position:fixed;right:24px;top:50%;transform:translateY(-50%);z-index:2147483647;pointer-events:none;color-scheme:light;
      font:400 16px/1.5 -apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue","PingFang SC",sans-serif;
      color:#34363b;-webkit-font-smoothing:antialiased}
    *{box-sizing:border-box}
    .panel{position:relative;display:flex;flex-direction:column;width:min(400px,calc(100vw - 48px));max-height:calc(100vh - 40px);overflow:hidden;padding:22px;
      background:linear-gradient(145deg,rgba(255,255,255,.32),rgba(255,255,255,.06) 65%),rgba(246,247,249,.84);
      -webkit-backdrop-filter:blur(32px) saturate(145%);backdrop-filter:blur(32px) saturate(145%);
      border:1px solid rgba(255,255,255,.78);border-radius:26px;
      box-shadow:0 18px 58px rgba(24,28,36,.14),0 3px 12px rgba(24,28,36,.05),inset 0 1px 0 rgba(255,255,255,.98),inset 0 -1px 0 rgba(32,36,44,.045)}
    h2{flex-shrink:0;font-size:20px;font-weight:600;letter-spacing:-.4px;margin:0 0 4px}
    .meta{flex-shrink:0;margin:0;color:#575b63;font-size:13px;font-variant-numeric:tabular-nums}
    .current{flex-shrink:0;margin:10px 0 0;padding:9px 12px;border:1px solid rgba(255,255,255,.5);border-radius:14px;
      background:rgba(255,255,255,.34);font-size:14px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .rows{position:relative;min-height:0;overflow:auto;overscroll-behavior:contain;padding:6px 10px 0;margin:12px -10px 0;isolation:isolate;
      scrollbar-width:thin;scrollbar-color:rgba(88,101,120,.23) transparent}
    .row{position:relative;z-index:1;display:flex;justify-content:space-between;align-items:center;gap:12px;min-height:38px;padding:4px 0;
      border-bottom:1px solid rgba(55,59,66,.075);font-size:14px;transition:color .18s ease}
    .row:last-child{border:0}
    .row>span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .row .ordinal{flex-shrink:0;color:#60646c;font-size:12px;font-variant-numeric:tabular-nums}
    .row.selected{color:#0059bd;font-weight:600}
    .row.selected .ordinal{color:#0059bd}
    .footer{margin-top:14px;font-size:12px;line-height:1.7;color:#575b63}
    .error{color:#92554d}
    @supports not (backdrop-filter:blur(1px)){.panel{background:rgba(247,248,250,.97)}}
    @media(prefers-reduced-transparency:reduce){.panel{background:#f6f7f9}.panel{-webkit-backdrop-filter:none;backdrop-filter:none}}
    @media(prefers-contrast:more){.panel{background:#f6f7f9;border-color:#858991}.row{border-color:#b6b9c0}.meta,.footer,.row .ordinal{color:#42464d}}
    @media(max-height:580px){.panel{padding:16px}.row{min-height:32px}h2{font-size:18px}.footer{margin-top:10px}}
  `;
  function ensureHud() {
    if (!top) return null;
    if (hud) return hud;
    hud = document.createElement("div");
    hud.id = "youtube-remote-browser";
    hud.setAttribute("role", "status");
    hud.hidden = true;
    const shadow = hud.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = STYLE;
    const panel = document.createElement("section");
    panel.className = "panel";
    panel.setAttribute("aria-label", "浏览器模式");
    const title = document.createElement("h2");
    title.textContent = "浏览器模式";
    const meta = document.createElement("p");
    meta.className = "meta";
    const current = document.createElement("p");
    current.className = "current";
    const rows = document.createElement("div");
    rows.className = "rows";
    rows.setAttribute("role", "listbox");
    rows.setAttribute("aria-label", "标签页");
    const footer = document.createElement("p");
    footer.className = "footer";
    panel.append(title, meta, current, rows, footer);
    shadow.append(style, panel);
    hudParts = { meta, current, rows, footer };
    return hud;
  }
  function render() {
    if (!top) return;
    if (!states.active) {
      if (hud) { hud.hidden = true; hud.dataset.active = "false"; }
      return;
    }
    ensureHud();
    const parent = document.fullscreenElement || document.documentElement;
    if (hud.parentElement !== parent) parent.append(hud);
    hud.hidden = false;
    hud.dataset.active = "true";
    hud.dataset.phase = states.phase;
    hud.dataset.position = String(states.position);
    hud.dataset.total = String(states.total);
    hud.dataset.activeTab = states.activeTabId == null ? "" : String(states.activeTabId);
    hud.dataset.selected = states.selectedTabId == null ? "" : String(states.selectedTabId);
    hud.dataset.tabs = String(states.tabs.length);
    const active = states.tabs.find(tab => tab.active);
    hudParts.meta.textContent = `标签页 ${states.position} / ${states.total}`;
    hudParts.meta.className = "meta";
    hudParts.current.textContent = active?.title || "当前页面无法显示标题";
    if (states.phase !== "titles") {
      hudParts.rows.hidden = true;
      hudParts.rows.replaceChildren();
      hudParts.footer.textContent = "↑↓ 切换标签 · Enter 刷新 · ←→ 后退/前进\n双击入口键按标题选择 · Esc 退出";
      hudParts.footer.className = "footer";
      return;
    }
    hudParts.rows.hidden = false;
    hudParts.rows.replaceChildren();
    let selectedRow = null;
    for (const tab of states.tabs) {
      const row = document.createElement("div");
      row.className = tab.id === states.selectedTabId ? "row selected" : "row";
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", String(tab.id === states.selectedTabId));
      row.dataset.tabId = String(tab.id);
      const label = document.createElement("span");
      label.textContent = tab.title || "无标题标签页";
      const ordinal = document.createElement("span");
      ordinal.className = "ordinal";
      ordinal.textContent = tab.active ? `${tab.index + 1} · 当前` : String(tab.index + 1);
      row.append(label, ordinal);
      if (tab.id === states.selectedTabId) selectedRow = row;
      hudParts.rows.append(row);
    }
    hudParts.footer.textContent = "↑↓ 选择 · Enter 跳转 · Esc 返回直控";
    hudParts.footer.className = "footer";
    if (selectedRow) {
      const rowBox = selectedRow.getBoundingClientRect();
      const listBox = hudParts.rows.getBoundingClientRect();
      if (rowBox.bottom > listBox.bottom - 4) hudParts.rows.scrollTop += rowBox.bottom - listBox.bottom + 4;
      else if (rowBox.top < listBox.top + 4) hudParts.rows.scrollTop -= listBox.top + 4 - rowBox.top;
    }
  }

  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("keyup", onKeyUp, true);
  window.addEventListener("keypress", onKeyPress, true);
  window.addEventListener("blur", () => { entry.reset(); clearPendingDirect(); consumed.clear(); });
  window.addEventListener("focus", refresh);
  window.addEventListener("pageshow", refresh);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") refresh(); });
  document.addEventListener("fullscreenchange", () => { if (states.active) render(); });
  chrome.runtime.onMessage.addListener((message) => {
    if (message && message.type === "remote:browser-state-changed") applyState(message.state);
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.remoteSettings) return;
    settings = R.normalize(changes.remoteSettings.newValue);
    loaded = true;
    entry.reset();
    // Disabling the takeover or removing the binding ends the global mode everywhere.
    if (states.active && (!settings.enabled || !settings.bindings.browser)) send({ type: "remote:browser-exit" });
  });
  // A late injection after the permission grant may find the controller already active.
  globalThis.__remoteBrowserController = { reconnect() { refresh(); render(); } };

  settingsChanged();
  if (top) refresh();
})();
