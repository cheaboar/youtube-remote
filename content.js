(function () {
  "use strict";
  const R = globalThis.YouTubeRemote;
  const D = globalThis.YouTubeRemoteDOM;
  const { nextItem } = globalThis.YouTubeKeyboardNavigation;
  const matcher = R.createMatcher();
  const highlight = "youtube-keyboard-selected";
  const names = { list: "节目列表", player: "播放器", sidebar: "右侧列表", guide: "左侧导航", search: "搜索", comments: "评论区" };
  const selectionRegions = ["list", "sidebar", "guide"];
  let settings = R.cloneDefaults();
  let diagnosticsUntil = 0;
  let route = D.routeKey();
  let region = D.isWatch() || D.isShorts() ? "player" : "list";
  let area = "recommendations";
  let selected = null;
  let selectedIndex = 0;
  let searchReturn = null;
  let guideReturn = null;
  let guideOpened = false;
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
  let lastActivation = { action: "", time: -Infinity, context: "" };
  let ui;
  let sequenceUi;
  let sequenceMode = null;
  let confirmation = null;
  let tabFocus = false;
  let browserActive = false;
  const synthetic = new WeakSet();
  const consumedKeys = new Set();
  const localSnapshots = new Map();

  function send(message) {
    try { return chrome.runtime.sendMessage(message).catch(() => null); }
    catch (_) { return Promise.resolve(null); }
  }
  function items() { return D.candidates(region === "guide" ? "guide" : region === "sidebar" ? area : "list"); }
  function sequenceGroups() {
    if (D.isWatch() || D.isShorts()) {
      const common = R.SEQUENCE_GROUPS.find(group => group.id === "common");
      const player = R.SEQUENCE_GROUPS.find(group => group.id === "player");
      return [
        { ...player, actions: { togglePlayback: common.actions.togglePlayback, ...player.actions } },
        { ...common, actions: Object.fromEntries(Object.entries(common.actions).filter(([action]) => action !== "togglePlayback")) },
        ...R.SEQUENCE_GROUPS.filter(group => group.id === "page")
      ];
    }
    const playback = new Set(["togglePlayback", "sidebar", ...Object.keys(R.SEQUENCE_GROUPS.find(group => group.id === "player").actions)]);
    const actions = Object.fromEntries(Object.entries(R.SEQUENCE_ACTIONS).filter(([action]) => playback.has(action)));
    return [
      ...R.SEQUENCE_GROUPS.filter(group => group.id !== "player").map(group => ({
        ...group, actions: Object.fromEntries(Object.entries(group.actions).filter(([action]) => !playback.has(action)))
      })),
      { id: "player", title: "播放页可用", actions, secondary: true }
    ];
  }
  function sequenceChoices() {
    const matches = sequenceMode?.prefix.length ? R.sequenceCandidates(settings.sequences, sequenceMode.prefix).candidates :
      Object.keys(R.SEQUENCE_ACTIONS).map(action => ({ action, keys: settings.sequences[action] || [] }));
    return sequenceGroups().flatMap(group => matches.filter(item => Object.hasOwn(group.actions, item.action)));
  }
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
    const uiParent = document.fullscreenElement || document.documentElement;
    if (ui.host.parentElement !== uiParent) uiParent.append(ui.host);
    const title = names[region];
    const detail = transient || (region === "search" ? "语音输入后按确认，返回清空并退出" : region === "player"
      ? settings.bindings.confirm ? `双击 ${R.label(settings.bindings.confirm)} 调出复合面板` : "请在设置中绑定确认键"
      : region === "comments" ? "↑↓ 滚动评论 · ←→ 翻页 · 恢复键回到正常播放"
      : region === "guide" ? "↑↓选择导航 · 确认打开 · → 返回节目" : "方向键选片 · 确认播放");
    if (ui.title.textContent !== title) ui.title.textContent = title;
    if (ui.detail.textContent !== detail) ui.detail.textContent = detail;
    ui.host.dataset.region = region;
    ui.host.dataset.confirm = settings.bindings.confirm;
    const hidden = !settings.enabled || !!document.fullscreenElement || !!sequenceMode || browserActive ||
      (!settings.showStatus && !transient);
    if (ui.host.hidden !== hidden) ui.host.hidden = hidden;
    renderSequences();
  }
  function renderSequences() {
    if (!sequenceMode || !settings.enabled) {
      if (sequenceUi && !sequenceUi.host.hidden) sequenceUi.host.hidden = true;
      return;
    }
    if (!sequenceUi) {
      const host = document.createElement("div");
      host.id = "youtube-remote-sequences";
      const shadow = host.attachShadow({ mode: "open" });
      const style = document.createElement("style");
      style.textContent = `
        :host{position:fixed;right:24px;top:50%;transform:translateY(-50%);z-index:2147483647;pointer-events:none;color-scheme:light;
          font:400 17px/1.5 -apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue","PingFang SC",sans-serif;
          color:#34363b;-webkit-font-smoothing:antialiased}
        *{box-sizing:border-box}
        .panel{position:relative;display:flex;flex-direction:column;width:min(480px,calc(100vw - 48px));max-height:calc(100vh - 40px);overflow:hidden;padding:26px;
          background:linear-gradient(145deg,rgba(255,255,255,.32),rgba(255,255,255,.06) 65%),rgba(246,247,249,.82);
          -webkit-backdrop-filter:blur(32px) saturate(145%);backdrop-filter:blur(32px) saturate(145%);
          border:1px solid rgba(255,255,255,.78);border-radius:28px;
          box-shadow:0 18px 58px rgba(24,28,36,.14),0 3px 12px rgba(24,28,36,.05),inset 0 1px 0 rgba(255,255,255,.98),inset 0 -1px 0 rgba(32,36,44,.045)}
        h2{flex-shrink:0;font-size:23px;font-weight:600;letter-spacing:-.45px;margin:0 0 6px}
        p{flex-shrink:0;margin:0;color:#575b63;font-size:14px;line-height:1.6}
        .progress{flex-shrink:0;display:flex;flex-wrap:wrap;gap:8px;align-items:center;min-height:44px;margin:18px 0 10px;padding:8px 12px;
          border:1px solid rgba(255,255,255,.5);border-radius:16px;background:rgba(255,255,255,.32);color:#555960;font-size:13px}
        .rows{position:relative;min-height:0;overflow:auto;overscroll-behavior:contain;padding:0 10px;margin:0 -10px;isolation:isolate;outline:none;
          scrollbar-width:thin;scrollbar-color:rgba(88,101,120,.23) transparent}
        .group-title{position:relative;z-index:1;margin:0;padding:16px 0 6px;color:#60646c;font-size:12px;font-weight:500}
        .selection-glass + .group .group-title{padding-top:6px}
        .selection-glass{position:absolute;top:0;left:0;right:0;z-index:0;pointer-events:none;border-radius:16px;
          border:1px solid rgba(255,255,255,.9);background:linear-gradient(155deg,rgba(255,255,255,.6),rgba(255,255,255,.08) 55%),rgba(10,132,255,.14);
          -webkit-backdrop-filter:blur(12px) saturate(165%);backdrop-filter:blur(12px) saturate(165%);
          box-shadow:0 4px 16px rgba(0,100,210,.1),inset 0 1px 0 rgba(255,255,255,.98),inset 0 -1px 0 rgba(10,132,255,.12);
          transition:transform .36s cubic-bezier(.22,1,.36,1),height .28s ease}
        .selection-glass:after{content:"";position:absolute;inset:1px;border-radius:14px;border-top:1px solid rgba(255,255,255,.85)}
        .row{position:relative;z-index:1;display:flex;justify-content:space-between;align-items:center;gap:16px;min-height:48px;padding:6px 0;border-bottom:1px solid rgba(55,59,66,.075);
          transition:color .18s ease}
        .row:last-child{border:0}.row>span{font-weight:450;min-width:0}
        .keys{display:flex;flex-wrap:wrap;justify-content:flex-end;align-items:center;gap:7px;max-width:65%}
        kbd{display:inline-flex;align-items:center;justify-content:center;min-width:32px;min-height:32px;padding:3px 8px;
          border:1px solid rgba(255,255,255,.8);border-radius:10px;background:rgba(255,255,255,.4);color:#555960;
          box-shadow:0 1px 3px rgba(32,36,44,.035),inset 0 1px 0 rgba(255,255,255,.8);font-family:inherit;font-size:18px;font-weight:500;line-height:1.2;overflow-wrap:anywhere}
        .used{opacity:.42}.next{background:rgba(255,255,255,.92);border-color:rgba(109,115,125,.4);color:#303238;
          box-shadow:0 2px 6px rgba(32,36,44,.07),inset 0 1px 0 #fff}
        .danger{color:#55585f}.error{color:#92554d}
        .row.selected,.row.selected .danger{color:#0059bd}.row.selected>span{font-weight:600}
        .row.selected kbd{color:#0059bd;border-color:rgba(10,132,255,.22);background:rgba(255,255,255,.65)}
        .row.selected .next{border-color:rgba(10,132,255,.5);background:rgba(255,255,255,.94);box-shadow:0 2px 6px rgba(0,100,210,.1),inset 0 1px 0 #fff}
        .group.secondary .group-title{color:#777c84}
        .group.secondary .row{min-height:38px;font-size:14px;color:#737780}
        .group.secondary kbd{min-width:27px;min-height:27px;font-size:15px;color:#737780;background:rgba(255,255,255,.3)}
        .group.secondary .row.selected,.group.secondary .row.selected kbd{color:#0059bd}
        .footer{margin-top:18px;font-size:13px;color:#575b63}.empty{color:#646871;font-size:13px}
        @supports not (backdrop-filter:blur(1px)){.panel{background:rgba(247,248,250,.97)}}
        @media(prefers-reduced-motion:reduce){.selection-glass,.row{transition:none}}
        @media(prefers-reduced-transparency:reduce){.panel{background:#f6f7f9}.selection-glass{background:#deebfc}.panel,.selection-glass{-webkit-backdrop-filter:none;backdrop-filter:none}}
        @media(prefers-contrast:more){.panel{background:#f6f7f9;border-color:#858991}.row{border-color:#b6b9c0}p,.footer,.empty,.group.secondary .group-title,.group.secondary .row,.group.secondary kbd{color:#42464d}.group.secondary .row.selected,.group.secondary .row.selected kbd{color:#0059bd}.used{opacity:.7}.selection-glass{background:#deebfc;border-color:#0059bd}}
        @media(max-height:580px){.panel{padding:18px}.row{min-height:38px}h2{font-size:21px}.progress{margin:12px 0 6px}.footer{margin-top:12px}}
      `;
      const panel = document.createElement("section");
      panel.className = "panel";
      panel.setAttribute("aria-label", "复合键模式");
      const title = document.createElement("h2"); title.textContent = "复合键模式";
      const subtitle = document.createElement("p"); subtitle.setAttribute("role", "status");
      const progress = document.createElement("div"); progress.className = "progress";
      const rows = document.createElement("div"); rows.className = "rows";
      rows.setAttribute("role", "listbox"); rows.setAttribute("aria-label", "复合键指令"); rows.tabIndex = -1;
      const glass = document.createElement("div"); glass.className = "selection-glass"; glass.setAttribute("aria-hidden", "true");
      const footer = document.createElement("p"); footer.className = "footer";
      panel.append(title, subtitle, progress, rows, footer);
      shadow.append(style, panel);
      sequenceUi = { host, panel, subtitle, progress, rows, glass, footer, signature: "" };
    }
    const parent = document.fullscreenElement || document.documentElement;
    if (sequenceUi.host.parentElement !== parent) parent.append(sequenceUi.host);
    const opening = sequenceUi.host.hidden || sequenceUi.signature === "";
    if (sequenceUi.host.hidden) sequenceUi.host.hidden = false;
    const candidates = sequenceChoices();
    if (!candidates.some(item => item.action === sequenceMode.selected)) sequenceMode.selected = candidates[0]?.action || null;
    sequenceUi.host.dataset.prefix = sequenceMode.prefix.join(",");
    sequenceUi.host.dataset.candidates = candidates.length;
    sequenceUi.host.dataset.selected = sequenceMode.selected || "";
    const signature = JSON.stringify([sequenceMode.prefix, sequenceMode.error, settings.sequences, settings.bindings.back, settings.bindings.confirm, D.isWatch(), D.isShorts()]);
    if (sequenceUi.signature === signature) { updateSequenceSelection(); return; }
    sequenceUi.signature = signature;
    const make = (tag, text, className = "") => {
      const element = document.createElement(tag); element.textContent = text; element.className = className; return element;
    };
    const confirmLabel = settings.bindings.confirm && settings.bindings.confirm !== "Enter" ? `Enter / ${R.label(settings.bindings.confirm)}` : "Enter";
    sequenceUi.subtitle.textContent = sequenceMode.error || (sequenceMode.prefix.length
      ? `继续输入组合 · ${confirmLabel} 确认选中项` : `↑↓ 选择指令 · ${confirmLabel} 确认`);
    sequenceUi.subtitle.className = sequenceMode.error ? "error" : "";
    sequenceUi.progress.replaceChildren(make("span", sequenceMode.prefix.length ? "已输入" : "快捷输入"));
    if (!sequenceMode.prefix.length) sequenceUi.progress.append(make("span", "← / → 开始输入组合", "empty"));
    else {
      for (const value of sequenceMode.prefix) sequenceUi.progress.append(make("kbd", R.label(value)));
      sequenceUi.progress.append(make("span", `剩余 ${candidates.length} 项`, "empty"));
    }
    const groups = [];
    for (const group of sequenceGroups()) {
      const matches = candidates.filter(item => Object.hasOwn(group.actions, item.action));
      if (!matches.length) continue;
      const section = make("div", "", group.secondary ? "group secondary" : "group"); section.dataset.group = group.id;
      section.setAttribute("role", "group"); section.setAttribute("aria-label", group.title);
      const heading = make("div", group.title, "group-title"); heading.setAttribute("aria-hidden", "true");
      section.append(heading);
      for (const { action, keys } of matches) {
        const row = make("div", "", "row"); row.dataset.action = action;
        row.id = `sequence-option-${action}`; row.setAttribute("role", "option");
        const keyList = make("div", "", "keys");
        keys.forEach((value, index) => keyList.append(make("kbd", R.label(value), index < sequenceMode.prefix.length ? "used" : index === sequenceMode.prefix.length ? "next" : "")));
        if (!keys.length) keyList.append(make("span", "菜单选择", "empty"));
        row.append(make("span", R.SEQUENCE_ACTIONS[action], action === "closeTab" ? "danger" : ""), keyList);
        section.append(row);
      }
      groups.push(section);
    }
    sequenceUi.rows.replaceChildren(sequenceUi.glass, ...groups);
    const backLabel = settings.bindings.back && settings.bindings.back !== "Escape" ? `Esc / ${R.label(settings.bindings.back)}` : "Esc";
    sequenceUi.footer.textContent = `${backLabel} 退出 · Backspace 撤销一步`;
    if (opening) sequenceUi.glass.style.transition = "none";
    updateSequenceSelection();
    if (opening) {
      sequenceUi.glass.getBoundingClientRect();
      sequenceUi.glass.style.removeProperty("transition");
    }
  }
  function updateSequenceSelection() {
    if (!sequenceMode || !sequenceUi || sequenceUi.host.hidden) return;
    let active;
    for (const row of sequenceUi.rows.querySelectorAll(".row")) {
      const chosen = row.dataset.action === sequenceMode.selected;
      row.classList.toggle("selected", chosen);
      row.setAttribute("aria-selected", String(chosen));
      if (chosen) active = row;
    }
    sequenceUi.glass.hidden = !active;
    if (!active) { sequenceUi.rows.removeAttribute("aria-activedescendant"); return; }
    sequenceUi.rows.setAttribute("aria-activedescendant", active.id);
    sequenceUi.glass.style.height = `${active.offsetHeight}px`;
    sequenceUi.glass.style.transform = `translateY(${active.offsetTop}px)`;
    const rowBox = active.getBoundingClientRect();
    const listBox = sequenceUi.rows.getBoundingClientRect();
    if (rowBox.bottom > listBox.bottom - 4) sequenceUi.rows.scrollTop += rowBox.bottom - listBox.bottom + 4;
    else if (rowBox.top < listBox.top + 4) sequenceUi.rows.scrollTop -= listBox.top + 4 - rowBox.top;
  }
  function cancelConfirmation() {
    if (confirmation) clearTimeout(confirmation.timer);
    confirmation = null;
  }
  function enterSequences() {
    const saved = confirmation?.saved || snapshot();
    cancelConfirmation();
    cancelPending();
    matcher.reset();
    const input = region === "search" ? D.searchInput() : null;
    sequenceMode = { prefix: [], selected: null, error: "", saved,
      input, start: input?.selectionStart, end: input?.selectionEnd };
    if (sequenceUi) sequenceUi.signature = "";
    render();
    sequenceUi.rows.focus({ preventScroll: true });
  }
  function leaveSequences(resume = false) {
    if (!sequenceMode) return;
    const previous = sequenceMode;
    sequenceMode = null;
    matcher.reset();
    if (sequenceUi?.host.shadowRoot.activeElement) sequenceUi.host.shadowRoot.activeElement.blur();
    render();
    if (!resume) return;
    if (region === "search" && D.visible(previous.input)) {
      previous.input.focus({ preventScroll: true });
      previous.input.setSelectionRange(previous.start, previous.end);
    } else if (selectionRegions.includes(region) && !validSelected()) restore(previous.saved, intent);
  }
  function consume(event) {
    event.preventDefault();
    event.stopImmediatePropagation();
    consumedKeys.add(event.code || event.key);
  }
  function runAction(action) {
    void execute(action).catch(() => notice("操作暂时未完成，请稍后重试"));
  }
  function sequenceKey(event) {
    consume(event);
    const value = R.chord(event);
    if (event.key === "Escape" || value && value === settings.bindings.back) { leaveSequences(true); return; }
    const direction = ["ArrowUp", "ArrowDown"].includes(value) ? (value === "ArrowUp" ? "up" : "down") : R.resolve(settings, value);
    if (!sequenceMode.prefix.length && ["up", "down"].includes(direction)) {
      const candidates = sequenceChoices();
      const index = candidates.findIndex(item => item.action === sequenceMode.selected);
      sequenceMode.selected = candidates[Math.max(0, Math.min(candidates.length - 1, index + (direction === "down" ? 1 : -1)))]?.action || null;
      sequenceMode.error = ""; render(); return;
    }
    if (event.repeat) return;
    if (event.key === "Backspace") {
      sequenceMode.prefix.pop(); sequenceMode.error = ""; render(); return;
    }
    if (!value) return;
    if (value === "Enter" || value === settings.bindings.confirm) {
      const candidates = sequenceChoices();
      const action = candidates.find(item => item.action === sequenceMode.selected)?.action;
      if (action) { leaveSequences(true); runAction(action); }
      return;
    }
    sequenceMode.prefix.push(value);
    const result = R.sequenceCandidates(settings.sequences, sequenceMode.prefix);
    if (!result.candidates.length) {
      sequenceMode.prefix = []; sequenceMode.error = "没有匹配，已重置，请重试";
    } else sequenceMode.error = "";
    if (result.action) {
      leaveSequences(true);
      runAction(result.action);
    } else render();
  }
  function confirmKey() {
    if (confirmation && performance.now() <= confirmation.deadline) { enterSequences(); return; }
    cancelConfirmation();
    const waiting = { deadline: performance.now() + settings.doubleInterval, route, region, token: intent,
      saved: snapshot(), selectedId: selectionRegions.includes(region) ? selected?.id : null };
    waiting.timer = setTimeout(() => {
      if (confirmation !== waiting) return;
      confirmation = null;
      // Replaced renderers may still represent the same video. Only confirm that saved video.
      if (waiting.selectedId && validSelected()?.id !== waiting.selectedId) return;
      if (settings.enabled && waiting.route === D.routeKey() && waiting.region === region && waiting.token === intent &&
        !composing && (region === "search" || !D.overlay())) runAction("confirm");
    }, settings.doubleInterval);
    confirmation = waiting;
  }
  function playerMenuKey(event) {
    if (!D.playerMenuItem() || !D.player()?.contains(document.activeElement)) return false;
    const value = R.chord(event);
    const action = value === "Enter" ? "confirm" : R.resolve(settings, value);
    const keys = { up: ["ArrowUp", 38], down: ["ArrowDown", 40], left: ["ArrowLeft", 37], right: ["ArrowRight", 39], back: ["Escape", 27] };
    if (action !== "confirm" && !keys[action]) return false;
    cancelConfirmation(); cancelPending(); matcher.reset(); logEvent(event, action);
    if (event.defaultPrevented) return true;
    if (action === "confirm") {
      consume(event);
      const item = document.activeElement?.closest("[role='menuitem'],[role='menuitemcheckbox'],[role='menuitemradio']");
      if (!event.repeat) item?.click();
      return true;
    }
    const [key, keyCode] = keys[action];
    if (event.key !== key) {
      consume(event);
      const forwarded = new KeyboardEvent("keydown", { key, code: key, keyCode, which: keyCode, bubbles: true, cancelable: true });
      synthetic.add(forwarded);
      document.activeElement.dispatchEvent(forwarded);
    }
    return true;
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
    if (!selectionRegions.includes(region)) clearHighlight();
    render();
  }
  function ownFocus() {
    // The browser-mode HUD owns the keyboard; do not pull focus back to the page.
    if (browserActive) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body) active.blur();
  }
  function snapshot() {
    if (region === "search" && searchReturn) return searchReturn;
    return { region, area, id: selected?.id || null, index: selectedIndex,
      x: scrollX, y: scrollY, innerScroll: D.scrollParent(selected?.element)?.scrollTop || 0,
      ...(region === "guide" && guideReturn ? { returnTo: guideReturn } : {}) };
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
    // Route bookkeeping continues, but selection/scroll recovery would fight the browser HUD.
    if (browserActive) { cancelPending(); return; }
    if (saved?.region === "guide") { void enterGuide(token, saved); return; }
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
    cancelConfirmation();
    leaveSequences();
    if (lastSnapshot && nextRoute !== route) send({ type: "remote:save", route, snapshot: lastSnapshot });
    clearTimeout(saveTimer);
    cancelPending();
    const token = intent;
    route = nextRoute;
    clearSelection();
    searchReturn = null;
    guideReturn = null;
    guideOpened = false;
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
  async function enterGuide(token, saved = null) {
    if (!saved && region === "guide") saved = snapshot();
    if (region !== "guide") {
      guideReturn = saved?.returnTo || (region === "search" && searchReturn?.region === "guide" ? searchReturn.returnTo : snapshot());
    } else if (saved?.returnTo) guideReturn = saved.returnTo;
    if (!await exitFullscreen() || token !== intent) return;
    ownFocus();
    searchReturn = null;
    clearSelection();
    setRegion("guide");
    notice("正在定位左侧导航…");
    let attempted = false;
    waitFor(() => {
      const list = D.guideItems();
      if (!list.length) {
        const button = D.guideButton();
        if (!attempted && button) { attempted = true; button.click(); guideOpened = true; }
        return false;
      }
      const chosen = saved?.id && list.find(item => item.id === saved.id) ||
        list.find(item => item.id === D.identity(location.href, "guide")) ||
        list.find(item => new URL(item.link.href).pathname === location.pathname) || list[Math.min(saved?.index || 0, list.length - 1)];
      const parent = D.scrollParent(chosen.element);
      if (parent && saved?.innerScroll) parent.scrollTop = saved.innerScroll;
      select(chosen);
      transient = ""; render();
      return true;
    }, () => { backFromGuide(); notice("未找到左侧导航，可稍后重试"); }, token);
  }
  function backFromGuide() {
    const saved = guideReturn;
    guideReturn = null;
    if (guideOpened && D.guideItems().length) D.guideButton()?.click();
    guideOpened = false;
    transient = "";
    clearSelection();
    restore(saved, intent);
  }
  async function toggleGuide(token) {
    if (!await exitFullscreen() || token !== intent) return;
    const expanding = !D.guideExpanded();
    const button = D.guideButton();
    if (!button) { notice("未找到左侧导航按钮，可稍后重试"); return; }
    const fromGuide = region === "guide";
    // Closing the drawer while selecting navigation also returns to the previous area.
    // Clear the flag first so the return path does not click the hamburger a second time.
    if (fromGuide && !expanding) { guideOpened = false; backFromGuide(); }
    button.click();
    if (fromGuide) guideOpened = expanding;
    else if (!expanding) guideOpened = false;
    notice(expanding ? "已展开左侧导航" : "已收起左侧导航");
    let attempts = 0;
    const verify = () => {
      if (token !== intent || !settings.enabled) return;
      if (D.guideExpanded() === expanding) return;
      if (++attempts < 16) { setTimeout(verify, 100); return; }
      notice("左侧导航暂未响应，可稍后重试");
    };
    setTimeout(verify, 100);
  }
  function enterPlayer() {
    if (!D.isWatch() && !D.isShorts()) { notice("当前页面没有播放器"); return; }
    clearSelection();
    setRegion("player");
    ownFocus();
    remember();
  }
  function scrollToTop() {
    window.scrollTo({ left: 0, top: 0, behavior: "instant" });
    notice("已滚动到页面顶部");
    remember();
  }
  async function pictureInPictureComments(token) {
    if (!D.isWatch()) return notice("画中画看评论仅在视频播放页提供");
    const video = D.video();
    if (!video) return notice("播放器尚未就绪");
    if (!await exitFullscreen() || token !== intent) return;
    if (!document.pictureInPictureElement) {
      try { await video.requestPictureInPicture(); }
      catch (_) {
        const button = D.pipButton();
        if (!button) return notice("无法开启画中画，请使用播放器画中画按钮");
        button.click();
      }
    }
    if (token !== intent) return;
    clearSelection();
    setRegion("comments");
    ownFocus();
    notice("正在定位评论区…");
    let lastProbe = 0;
    waitFor(() => {
      const target = D.comments();
      if (!target) {
        // Scrolling near the bottom makes YouTube mount the lazy-loaded comments section.
        if (Date.now() - lastProbe > 400) {
          lastProbe = Date.now();
          window.scrollTo({ left: 0, top: document.documentElement.scrollHeight, behavior: "instant" });
        }
        return false;
      }
      window.scrollTo({ left: 0, top: Math.max(0, scrollY + target.getBoundingClientRect().top - 72), behavior: "instant" });
      transient = "";
      render();
      remember();
      return true;
    }, () => notice("评论区暂未加载，可稍后重试"), token);
  }
  async function restorePlayback(token) {
    if (!D.isWatch() && !D.isShorts()) return notice("当前页面没有播放器");
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
    } catch (_) { /* The PiP window may already be closed. */ }
    if (token !== intent) return;
    clearSelection();
    setRegion("player");
    ownFocus();
    window.scrollTo({ left: 0, top: 0, behavior: "instant" });
    notice("已恢复正常播放");
    remember();
  }
  async function togglePlayback() {
    const video = D.video();
    if (!video) return notice("播放器尚未就绪");
    try { if (video.paused) await video.play(); else video.pause(); }
    catch (_) { notice("播放被浏览器阻止，请在播放器上确认播放"); }
  }
  async function playerFeature(action, token) {
    const video = D.video();
    if (!D.isWatch() && !D.isShorts() || !video) return notice("请先打开视频播放页");
    if (action === "mute") {
      video.muted = !video.muted;
      notice(video.muted ? "已静音" : "已取消静音");
      return;
    }
    if (action === "theater" && !await exitFullscreen() || token !== intent) return;
    const control = D.playerControl(action);
    if (!control) return notice(action === "captions" ? "当前视频没有可用字幕" : action === "theater" ? "当前播放器不支持影院模式" : "播放器设置暂不可用");
    if (action === "playerSettings") enterPlayer();
    control.click();
    if (action === "playerSettings") {
      waitFor(() => {
        const item = D.playerMenuItem();
        if (!item) return false;
        if (item.tabIndex < 0) item.tabIndex = 0;
        item.focus({ preventScroll: true });
        return document.activeElement === item;
      }, () => notice("请在播放器中选择设置项"), token);
    } else notice(action === "captions" ? "已切换字幕" : "已切换影院模式");
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
    if (region === "comments") {
      const page = action === "left" || action === "right";
      const step = Math.max(160, Math.round(innerHeight * (page ? 0.85 : 0.4)));
      window.scrollBy({ top: (action === "down" || action === "right" ? 1 : -1) * step, behavior: "instant" });
      return;
    }
    const list = items();
    if (region === "guide") {
      if (action === "right") return backFromGuide();
      if (action === "left") return ownFocus();
      if (list.length) {
        const current = validSelected();
        const index = list.findIndex(item => item.element === current?.element);
        return select(list[Math.max(0, Math.min(list.length - 1, index + (action === "down" ? 1 : -1)))]);
      }
    }
    if (!list.length && region === "list" && location.pathname === "/" && action === "left") return enterGuide(intent);
    if (!list.length) {
      notice("正在等待节目加载…");
      waitFor(() => { const available = items(); if (!available.length) return false; select(D.firstVisible(available)); return true; },
        () => notice("没有找到节目，可使用搜索键重新查找"));
      return;
    }
    const current = validSelected();
    const next = current ? nextItem(list, current.element, `Arrow${action[0].toUpperCase()}${action.slice(1)}`) : D.firstVisible(list);
    if (region === "list" && location.pathname === "/" && action === "left" && current?.element === next.element) return enterGuide(intent);
    if (next.element !== selected?.element || !next.element.classList.contains(highlight)) select(next);
    else ownFocus();
    if (action === "down" && nextItem(list, next.element, "ArrowDown").element === next.element) D.scrollForMore(next.element);
  }
  async function confirm() {
    if (region === "comments") return;
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
    if (action === "closeTab" || action === "reload") {
      await remember(true);
      if (token !== intent) return;
      const result = await send({ type: "remote:tab-command", command: action });
      if (result?.ok === false) notice(action === "closeTab" ? "无法关闭当前标签页，请重试" : "无法刷新页面，请重试");
      return;
    }
    if (["up", "down", "left", "right"].includes(action)) return region === "player" ? playerMove(action) : move(action);
    if (action === "search") return enterSearch(token);
    if (action === "home") return goHome(token);
    if (action === "sidebar") return enterSidebar(token);
    if (action === "guide") return enterGuide(token);
    if (action === "toggleGuide") return toggleGuide(token);
    if (action === "player") return enterPlayer();
    if (action === "confirm") return confirm();
    if (action === "togglePlayback") return togglePlayback();
    if (["mute", "captions", "theater", "playerSettings"].includes(action)) return playerFeature(action, token);
    if (action === "fullscreen") return fullscreen();
    if (action === "pipComments") return pictureInPictureComments(token);
    if (action === "restorePlayback") return restorePlayback(token);
    if (action === "scrollTop") return scrollToTop();
    if (action === "historyBack") return historyBack();
    if (action === "back") {
      if (region === "search") return backFromSearch();
      if (document.fullscreenElement) return exitFullscreen();
      if (region === "guide") return backFromGuide();
      if (region === "comments") return restorePlayback(token);
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
    // browser.js owns every key while the global mode is active.
    if (browserActive) return;
    if (D.routeKey() !== route) void enterRoute();
    if (event.isComposing || composing || event.keyCode === 229 || event.key === "Process") {
      cancelConfirmation(); leaveSequences(); matcher.reset(); logEvent(event); return;
    }
    if (sequenceMode && region !== "search" && D.overlay()) leaveSequences();
    if (settings.enabled && sequenceMode) { logEvent(event, "sequence"); sequenceKey(event); return; }
    if (settings.enabled && playerMenuKey(event)) return;
    if (event.key === "Tab") { tabFocus = true; cancelPending(); }
    const input = D.searchInput();
    const atSearch = input && (event.target === input || document.activeElement === input);
    if (atSearch && region !== "search" && event.key?.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey) {
      searchReturn = snapshot(); cancelPending(); setRegion("search");
    }
    const inSearch = atSearch && region === "search";
    let action = matcher.match(event, settings, region);
    if (event.repeat && R.resolve(settings, R.chord(event)) === "confirm") action = "confirm";
    logEvent(event, action);
    if (action !== "confirm" || event.defaultPrevented) cancelConfirmation();
    if (!settings.enabled || !action) return;
    // The global browser mode is entered by browser.js; this is only a fallback if it is absent.
    if (action === "browser") return;
    if (event.defaultPrevented) return;
    // A focused scrollbar/scroller is Chrome's focusable scroller, not a text editor.
    const editing = D.editing(event.target) && !D.scrollFocus(event.target);
    if (editing && event.key?.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey) {
      matcher.reset(); return;
    }
    if (editing && !atSearch && action !== "search") { matcher.reset(); cancelPending(); return; }
    if (inSearch && ["up", "down", "left", "right"].includes(action)) return;
    if (inSearch && action === "confirm" && performance.now() - compositionEnded < 80) {
      cancelConfirmation(); consume(event); return;
    }
    const dialog = D.overlay();
    if (dialog && !inSearch) {
      if (action === "back" && event.key !== "Escape") {
        event.preventDefault(); event.stopImmediatePropagation();
        const escape = new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true });
        synthetic.add(escape);
        (document.activeElement || dialog).dispatchEvent(escape);
      }
      if (["search", "sidebar", "guide", "toggleGuide", "player"].includes(action)) notice("请先用返回键关闭页面弹窗");
      matcher.reset();
      cancelConfirmation();
      return;
    }
    if (D.isShorts() && region === "player" && ["up", "down", "left", "right"].includes(action)) return;
    consume(event);
    const directional = ["up", "down", "left", "right"].includes(action);
    if (navigationBusy) return;
    if (action === "confirm") {
      if (!event.repeat) confirmKey();
      return;
    }
    const activationContext = `${route}:${region}:${!!document.fullscreenElement}`;
    if (!directional && (event.repeat || lastActivation.action === action && lastActivation.context === activationContext && event.timeStamp - lastActivation.time < 250)) return;
    if (!directional) lastActivation = { action, time: event.timeStamp, context: activationContext };
    runAction(action);
  }, true);
  window.addEventListener("keyup", (event) => {
    if (!consumedKeys.delete(event.code || event.key)) return;
    event.preventDefault(); event.stopImmediatePropagation();
  }, true);
  window.addEventListener("keypress", (event) => {
    if (!consumedKeys.has(event.code || event.key)) return;
    event.preventDefault(); event.stopImmediatePropagation();
  }, true);
  window.addEventListener("compositionstart", (e) => {
    composing = true; cancelConfirmation(); leaveSequences(); matcher.reset(); logEvent(e);
  }, true);
  window.addEventListener("compositionend", (e) => { composing = false; compositionEnded = performance.now(); logEvent(e); }, true);
  window.addEventListener("beforeinput", (e) => {
    if (settings.enabled && sequenceMode) { e.preventDefault(); logEvent(e); return; }
    cancelConfirmation();
    if (settings.enabled && e.target === D.searchInput() && region !== "search") {
      searchReturn = snapshot(); cancelPending(); setRegion("search");
    }
    logEvent(e);
  }, true);
  window.addEventListener("pointerdown", (event) => {
    cancelConfirmation(); leaveSequences();
    if (!settings.enabled || !D.editing(event.target) || D.scrollFocus(event.target)) return;
    cancelPending(); matcher.reset();
    if (event.target === D.searchInput() && region !== "search") { searchReturn = snapshot(); setRegion("search"); }
  }, true);
  window.addEventListener("focusin", (event) => {
    if (browserActive) { tabFocus = false; return; }
    const scroller = settings.enabled && D.scrollFocus(event.target);
    // Give the focus back before the browser starts treating arrow keys as native scrolling.
    if (scroller && !tabFocus) ownFocus();
    if (settings.enabled && tabFocus && event.target === D.searchInput() && region !== "search") {
      searchReturn = snapshot(); cancelPending(); setRegion("search");
    } else if (settings.enabled && !scroller && D.editing(event.target) && event.target !== D.searchInput()) {
      cancelConfirmation(); cancelPending(); matcher.reset();
    }
    tabFocus = false;
  }, true);
  document.addEventListener("fullscreenchange", render);
  window.addEventListener("popstate", () => void enterRoute(true));
  window.addEventListener("pageshow", (event) => { if (event.persisted) void enterRoute(true, true); });
  window.addEventListener("blur", () => { cancelConfirmation(); leaveSequences(); matcher.reset(); consumedKeys.clear(); });
  window.addEventListener("pagehide", () => { cancelConfirmation(); leaveSequences(); void remember(true); cancelPending(); });
  document.addEventListener("yt-navigate-start", () => { cancelConfirmation(); leaveSequences(); void remember(true); });
  document.addEventListener("yt-navigate-finish", () => void enterRoute());
  window.addEventListener("scroll", () => {
    if (settings.enabled && D.scrollFocus(document.activeElement)) ownFocus();
    if (!pending && D.routeKey() === route) remember();
  }, true);
  window.addEventListener("resize", () => { if (pending) tickPending(); updateSequenceSelection(); });
  new MutationObserver(() => {
    if (mutationTimer) return;
    mutationTimer = setTimeout(() => {
      mutationTimer = null;
      if (D.routeKey() !== route) void enterRoute();
      if (selected && (!D.visible(selected.element) || D.identity(selected.link.href, selected.id.startsWith("guide:") ? "guide" : "list") !== selected.id)) {
        const saved = { ...(lastSnapshot || snapshot()), id: selected.id, index: selectedIndex };
        clearSelection();
        if (!pending && !sequenceMode && settings.enabled && selectionRegions.includes(region) &&
          (!D.editing(document.activeElement) || D.scrollFocus(document.activeElement) || document.activeElement === D.searchInput())) restore(saved, intent);
      }
      if (pending) tickPending();
      render();
    }, 50);
  }).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden", "style", "href"] });
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    if (changes.diagnosticsUntil) diagnosticsUntil = Number(changes.diagnosticsUntil.newValue) || 0;
    if (changes.remoteSettings) {
      cancelConfirmation(); leaveSequences();
      settings = R.normalize(changes.remoteSettings.newValue);
      cancelPending(); matcher.reset();
      if (!settings.enabled) clearHighlight();
      else if (selected && selectionRegions.includes(region)) selected.element.classList.add(highlight);
      render();
    }
  });
  // browser.js (which loads first) drives global mode entry. It calls back here so an entry press
  // also cancels a delayed single confirm, closes the command panel it just opened, and so page
  // recovery pauses while the browser HUD owns input.
  globalThis.__youtubeRemoteHost = {
    entryAllowed() { return settings.enabled && !sequenceMode && !composing; },
    entryPressed() { cancelConfirmation(); cancelPending(); matcher.reset(); leaveSequences(); },
    activate() {
      browserActive = true;
      cancelConfirmation();
      cancelPending();
      matcher.reset();
      leaveSequences();
      render();
    },
    deactivate() { browserActive = false; render(); }
  };
  void chrome.storage.local.get(["remoteSettings", "diagnosticsUntil"]).then((stored) => {
    settings = R.normalize(stored.remoteSettings);
    diagnosticsUntil = Number(stored.diagnosticsUntil) || 0;
    const back = performance.getEntriesByType("navigation")[0]?.type === "back_forward";
    void enterRoute(back, true);
    render();
  });
})();
