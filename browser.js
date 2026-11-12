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
    position: 0, total: 0, activeTabId: null, selectedTabId: null, selectedAction: "", selectedItemId: "", menuGroup: "common", menuItems: [], closeArmed: false, tabs: [] };
  const PAGE_ACTIONS = { focus: "网页焦点模式", input: "定位输入框", reload: "刷新当前页面", close: "关闭当前标签页" };
  let hud = null;
  let hudParts = null;
  // Page interaction is local to this tab's top frame: focus traversal, text entry and the
  // two-step close never need to leave the page.
  let pageMode = null; // null | { kind: "focus", index, total } | { kind: "input", element }
  let closePending = null;
  let markedElement = null;
  let markedStyle = null;
  let pageNotice = "";
  let noticeTimer = null;
  let entrySuppressedUntil = 0;
  let lastScroll = 0;
  const handledPageActions = new Set();
  const FOCUSABLE = "a[href],area[href],button,input:not([type='hidden']),select,textarea,summary," +
    "[contenteditable]:not([contenteditable='false']),[tabindex]:not([tabindex='-1'])," +
    "[role='button'],[role='link'],[role='textbox'],[role='menuitem'],[role='option'],[role='tab']";
  const TEXT_INPUT_TYPES = new Set(["text", "search", "email", "url", "tel", "password", "number",
    "date", "datetime-local", "month", "week", "time"]);

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

  function isVisible(el) {
    if (!(el instanceof Element) || el.closest("[inert]") || el.closest("#youtube-remote-browser")) return false;
    if (el.disabled || el.getAttribute("aria-disabled") === "true") return false;
    if (!el.getClientRects().length) return false;
    const style = getComputedStyle(el);
    return style.display !== "none" && style.visibility !== "hidden" && style.visibility !== "collapse";
  }
  function focusables() {
    // Editing hosts (contenteditable) can take focus without joining the default tab order.
    return [...document.querySelectorAll(FOCUSABLE)].filter(el =>
      (el.tabIndex >= 0 || el.isContentEditable) && isVisible(el));
  }
  function isTextTarget(el) {
    if (!(el instanceof Element) || el.disabled || !isVisible(el)) return false;
    if (el instanceof HTMLInputElement) return TEXT_INPUT_TYPES.has(el.type) && !el.readOnly;
    if (el instanceof HTMLTextAreaElement) return !el.readOnly;
    return el.isContentEditable || el.getAttribute("role") === "textbox";
  }
  function inViewport(el) {
    const rect = el.getBoundingClientRect();
    return rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
  }
  function textTargets() {
    return [...document.querySelectorAll("input,textarea,[contenteditable]:not([contenteditable='false']),[role='textbox']")]
      .filter(isTextTarget);
  }
  function firstTextTarget() {
    const targets = textTargets();
    return targets.find(inViewport) || targets[0] || null;
  }
  function labelOf(el) {
    if (!(el instanceof Element)) return "";
    const text = el.getAttribute("aria-label") || el.getAttribute("placeholder") ||
      (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && el.textContent) ||
      el.getAttribute("title") || el.tagName.toLowerCase();
    return String(text).replace(/\s+/g, " ").trim().slice(0, 60) || el.tagName.toLowerCase();
  }
  function unmark() {
    if (!markedElement) return;
    if (markedStyle) {
      for (const [name, value, priority] of markedStyle) {
        if (value) markedElement.style.setProperty(name, value, priority);
        else markedElement.style.removeProperty(name);
      }
    }
    markedElement.removeAttribute("data-youtube-remote-focus");
    markedElement = null;
    markedStyle = null;
  }
  function mark(el) {
    if (markedElement === el) return;
    unmark();
    markedElement = el;
    markedStyle = ["outline", "outline-offset"].map(name =>
      [name, el.style.getPropertyValue(name), el.style.getPropertyPriority(name)]);
    // Inline styles survive pages whose CSP blocks injected stylesheets.
    el.setAttribute("data-youtube-remote-focus", "");
    el.style.setProperty("outline", "2px solid #0059bd", "important");
    el.style.setProperty("outline-offset", "2px", "important");
  }
  function reveal(el) {
    if (!(el instanceof Element)) return;
    el.scrollIntoView({ block: "center", inline: "nearest" });
    try { el.focus({ preventScroll: true }); } catch (_) { /* Element cannot take focus. */ }
  }
  function selectContent(el) {
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      try { el.select(); } catch (_) { /* Number and date inputs may reject select(). */ }
      return;
    }
    if (el.isContentEditable) {
      try {
        const range = document.createRange();
        range.selectNodeContents(el);
        const selection = getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      } catch (_) { /* A detached editor can throw. */ }
    }
  }
  function notifyPage(text) {
    const errors = { OPERATION_FAILED: "操作失败，请重试", NOT_AUTHORIZED: "请先授权访问该网站", STALE_SELECTION: "列表已更新，请重新选择", NO_HISTORY: "没有可跳转的历史页面", CONFIRM_REQUIRED: "请在页面菜单中确认关闭" };
    pageNotice = typeof text === "string" ? text : text?.message || errors[text?.code] || "操作未完成，请重试";
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => {
      noticeTimer = null;
      pageNotice = "";
      if (states.active) render();
    }, 1600);
    render();
  }
  function cancelClose() {
    if (!closePending) return;
    clearTimeout(closePending);
    closePending = null;
  }
  function closeHint() {
    const key = R.label(settings.bindings.browserClose);
    return `再按一次 ${key || "关闭键"} 关闭当前标签页 · 其他键取消`;
  }
  function resetPageState(renderNow = true) {
    pageMode = null;
    unmark();
    cancelClose();
    clearTimeout(noticeTimer);
    noticeTimer = null;
    pageNotice = "";
    clearPendingDirect();
    // Do not reset the entry tap counter here: an ordinary state reply can arrive between the
    // two taps of the entry gesture (for example right after bringToFront) and would eat it.
    if (renderNow && states.active) render();
  }
  function enterFocusMode() {
    const items = focusables();
    if (!items.length) { notifyPage("页面上没有可聚焦的元素"); return; }
    const active = document.activeElement;
    const start = items.includes(active) ? active : items.find(inViewport) || items[0];
    pageMode = { kind: "focus", index: items.indexOf(start), total: items.length };
    mark(start);
    reveal(start);
    render();
  }
  function moveFocus(step) {
    if (pageMode?.kind !== "focus") return;
    const items = focusables();
    if (!items.length) { resetPageState(false); notifyPage("页面上没有可聚焦的元素"); return; }
    const current = items.indexOf(document.activeElement);
    const base = current >= 0 ? current : Math.min(pageMode.index, items.length - 1);
    const index = (base + step + items.length) % items.length;
    pageMode = { kind: "focus", index, total: items.length };
    mark(items[index]);
    reveal(items[index]);
    render();
  }
  function enterInputMode(el) {
    if (!(el instanceof Element)) return;
    pageMode = { kind: "input", element: el };
    mark(el);
    reveal(el);
    selectContent(el);
    render();
  }
  function focusInputShortcut() {
    const target = firstTextTarget();
    if (!target) { notifyPage("页面上没有找到可输入的文本框"); return; }
    enterInputMode(target);
  }
  function enterInputPick(preferred) {
    const items = textTargets();
    if (!items.length) { notifyPage("页面上没有找到可输入的文本框"); return; }
    const target = items.includes(preferred) ? preferred : items.includes(document.activeElement) ? document.activeElement : items.find(inViewport) || items[0];
    pageMode = { kind: "inputPick", index: items.indexOf(target), total: items.length, element: target };
    mark(target);
    reveal(target);
    render();
  }
  function moveInputPick(step) {
    const items = textTargets();
    if (!items.length) { leavePageMode(); notifyPage("页面上没有找到可输入的文本框"); return; }
    const current = items.indexOf(pageMode.element);
    const index = (Math.max(0, current) + step + items.length) % items.length;
    pageMode = { kind: "inputPick", index, total: items.length, element: items[index] };
    mark(items[index]);
    reveal(items[index]);
    render();
  }
  function scrollPage(logical) {
    if (Date.now() - lastScroll < 90) return;
    lastScroll = Date.now();
    const vertical = logical === "up" || logical === "down";
    let target = document.activeElement;
    while (target && target !== document.body && target !== document.documentElement) {
      const style = getComputedStyle(target);
      const overflow = vertical ? style.overflowY : style.overflowX;
      const size = vertical ? target.scrollHeight - target.clientHeight : target.scrollWidth - target.clientWidth;
      if (size > 0 && /auto|scroll|overlay/.test(overflow)) break;
      target = target.parentElement;
    }
    if (!target || target === document.body || target === document.documentElement) target = document.scrollingElement;
    if (!target) return;
    const amount = (vertical ? target.clientHeight : target.clientWidth) * (vertical ? .2 : .8);
    const delta = (logical === "up" || logical === "left" ? -1 : 1) * amount;
    const before = vertical ? target.scrollTop : target.scrollLeft;
    target.scrollBy({ top: vertical ? delta : 0, left: vertical ? 0 : delta, behavior: "instant" });
    if ((vertical ? target.scrollTop : target.scrollLeft) === before) notifyPage("已经到达滚动边界");
  }
  function runPageAction(action) {
    if (!top || !states.active || !action || action.sessionId !== states.sessionId || !action.requestId ||
        handledPageActions.has(action.requestId)) return;
    handledPageActions.add(action.requestId);
    if (handledPageActions.size > 200) handledPageActions.delete(handledPageActions.values().next().value);
    if (action.action === "focus") enterFocusMode();
    else if (action.action === "input") enterInputPick();
    else if (action.action === "scroll") { pageMode = { kind: "scroll" }; render(); }
    else if (action.action === "scrollTop" || action.action === "scrollBottom") {
      const target = document.scrollingElement;
      if (target) target.scrollTo({ top: action.action === "scrollTop" ? 0 : target.scrollHeight, behavior: "instant" });
    }
  }
  function activateFocused() {
    if (pageMode?.kind !== "focus") return;
    const el = document.activeElement;
    if (!(el instanceof Element)) return;
    if (isTextTarget(el)) { enterInputMode(el); return; }
    try { el.click(); } catch (_) { /* The page may reject the activation. */ }
    if (el.isConnected) {
      const items = focusables();
      const index = items.indexOf(el);
      if (index >= 0) pageMode = { kind: "focus", index, total: items.length };
    }
    render();
  }
  function armClose() {
    cancelClose();
    closePending = setTimeout(() => {
      closePending = null;
      if (states.active) render();
    }, settings.doubleInterval);
    render();
  }

  function applyState(state) {
    if (!state || typeof state !== "object") return;
    // An idle controller accepts a freshly started session even if the worker's revision counter
    // restarted; an active one still rejects anything older than what it already applied.
    const newSession = state.active === true && !!state.sessionId && state.sessionId !== states.sessionId && !states.active;
    const stale = Number.isFinite(state.revision) && Number.isFinite(states.revision) && state.revision < states.revision;
    if (stale && !newSession) return;
    const previousSessionId = states.sessionId;
    const previousTabId = states.activeTabId;
    states.active = state.active === true;
    if (!states.active) clearPendingDirect();
    states.revision = Number.isFinite(state.revision) ? state.revision : states.revision;
    states.sessionId = typeof state.sessionId === "string" ? state.sessionId : "";
    states.phase = state.phase === "titles" ? "titles" : "direct";
    states.position = Number(state.position) || 0;
    states.total = Number(state.total) || 0;
    states.activeTabId = Number.isFinite(state.activeTabId) ? state.activeTabId : null;
    states.selectedTabId = Number.isFinite(state.selectedTabId) ? state.selectedTabId : null;
    states.selectedAction = states.active && typeof state.selectedAction === "string" &&
      Object.hasOwn(PAGE_ACTIONS, state.selectedAction) ? state.selectedAction : "";
    states.menuGroup = state.menuGroup || "common";
    states.selectedItemId = state.selectedItemId || "";
    states.menuItems = Array.isArray(state.menuItems) ? state.menuItems : [];
    states.closeArmed = states.active && state.closeArmed === true;
    states.tabs = states.active && Array.isArray(state.tabs) ? state.tabs.slice(0, 200) : [];
    // Page focus/entry belongs to one tab and one session. Ordinary title pushes keep it, so a
    // pending close confirmation is not silently cancelled by background updates.
    if (!states.active || states.phase === "titles" || states.sessionId !== previousSessionId ||
      states.activeTabId !== previousTabId) resetPageState(false);
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
    if (input === "activateSelected") message.expectedItemId = states.selectedItemId;
    return send(message).then((result) => {
      if (result?.state) applyState(result.state);
      if (result?.pageAction) runPageAction(result.pageAction);
      if (result && result.ok === false) notifyPage(result.error || result.message || "操作失败");
    });
  }
  function enter() {
    entry.reset();
    send({ type: "remote:browser-enter", requestId: nextRequestId() }).then((result) => {
      if (result?.state) applyState(result.state);
    });
  }

  const literal = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right", Enter: "confirm", Escape: "back" };
  function logicalKey(chord) {
    const recorded = R.resolve(settings, chord);
    return ["up", "down", "left", "right", "confirm", "back"].includes(recorded) ? recorded : literal[chord] || null;
  }
  let pendingDirect = null;
  function clearPendingDirect() { if (pendingDirect) { clearTimeout(pendingDirect); pendingDirect = null; } }
  function directInput(chord) {
    const logical = logicalKey(chord);
    if (logical === "up") return "previousTab";
    if (logical === "down") return "nextTab";
    if (logical === "left") return "back";
    if (logical === "right") return "forward";
    if (logical === "confirm") return "openTitles";
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
  function handleFocusModeKey(event, chord) {
    // Modifier-only keys have no chord; browser shortcuts still belong to the browser.
    if (!chord || event.ctrlKey || event.altKey || event.metaKey) return;
    const logical = logicalKey(chord);
    if (logical === "back") {
      consume(event);
      if (!event.repeat) leavePageMode();
      return;
    }
    if (logical === "confirm") {
      consume(event);
      if (!event.repeat) activateFocused();
      return;
    }
    if (chord === "Tab" || logical === "down" || logical === "right") {
      consume(event);
      moveFocus(1);
      return;
    }
    if (chord === "Shift+Tab" || logical === "up" || logical === "left") {
      consume(event);
      moveFocus(-1);
      return;
    }
    consume(event);
  }
  function leavePageMode() {
    // The direct handler ignores repeated Esc, so a held back key cannot leave the browser mode
    // right after leaving focus or text entry.
    resetPageState();
  }
  function modeKey(event, chord) {
    if (!chord) return;
    // Text entry hands every key back to the page except the back key. Backspace must keep
    // editing instead of arming the close confirmation.
    if (pageMode?.kind === "input") {
      if (isTextTarget(document.activeElement)) {
        if (logicalKey(chord) === "back" && !["Backspace", "Enter", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) {
          consume(event);
          if (!event.repeat) enterInputPick(pageMode.element);
        }
        return;
      }
      leavePageMode();
    }
    if (pageMode?.kind === "inputPick" || pageMode?.kind === "scroll") {
      if (event.ctrlKey || event.altKey || event.metaKey) return;
      const logical = logicalKey(chord);
      if (!["up", "down", "left", "right", "confirm", "back"].includes(logical)) return;
      consume(event);
      if (logical === "back") { if (!event.repeat) { const pick = pageMode.kind === "inputPick"; leavePageMode(); if (pick) sendInput("openTitles"); } }
      else if (pageMode.kind === "inputPick") {
        if (logical === "confirm") { if (!event.repeat) enterInputMode(pageMode.element); }
        else moveInputPick(logical === "up" || logical === "left" ? -1 : 1);
      } else if (logical === "confirm") { if (!event.repeat) { leavePageMode(); sendInput("openTitles"); } }
      else scrollPage(logical);
      return;
    }
    // The second close press must land inside the confirmation window; held keys never close.
    if (closePending) {
      if (chord === settings.bindings.browserClose) {
        consume(event);
        if (event.repeat) return;
        cancelClose();
        sendInput("closeTab");
        return;
      }
      cancelClose();
      if (states.active) render();
    }
    // Page controls are checked before the modifier guard so remapped Alt+Shift chords work.
    if (top && states.phase === "direct" && chord === settings.bindings.focusInput) {
      clearPendingDirect();
      entry.reset();
      consume(event);
      if (!event.repeat) focusInputShortcut();
      return;
    }
    if (top && states.phase === "direct" && chord === settings.bindings.browserClose) {
      clearPendingDirect();
      entry.reset();
      if (event.repeat) { consume(event); return; }
      // A text field focused with the mouse keeps Backspace native even outside input mode.
      if (isTextTarget(document.activeElement)) return;
      consume(event);
      armClose();
      return;
    }
    // Focus traversal owns the keyboard, including the entry key and Tab.
    if (pageMode?.kind === "focus") {
      clearPendingDirect();
      entry.reset();
      handleFocusModeKey(event, chord);
      return;
    }
    // A single confirm opens the menu. Ignore the rest of that key burst so the
    // second tap of the familiar entry gesture cannot activate its first item.
    if ((chord === settings.bindings.browser || logicalKey(chord) === "confirm") && Date.now() < entrySuppressedUntil) {
      consume(event);
      return;
    }
    if (states.phase === "direct" && chord === settings.bindings.browser) {
      consume(event);
      if (event.repeat) return;
      if ((logicalKey(chord)) === "confirm") {
        entrySuppressedUntil = Date.now() + settings.doubleInterval;
        sendInput("openTitles");
      } else if (entry.press(event, settings.doubleInterval) >= 2) {
        entry.reset();
        entrySuppressedUntil = Date.now() + settings.doubleInterval;
        sendInput("openTitles");
      }
      return;
    }
    // Any other key wins over a waiting entry press.
    clearPendingDirect();
    entry.reset();
    if (top && chord === settings.bindings.focusMode) {
      consume(event);
      // While the title list is open the key is a no-op so the page focus does not move under it.
      if (states.phase === "direct" && !event.repeat) enterFocusMode();
      return;
    }
    // Browser and OS shortcuts still belong to the browser while the mode is active.
    if (event.ctrlKey || event.altKey || event.metaKey) return;
    const logical = logicalKey(chord);
    const direct = states.phase === "direct";
    let input = null;
    let control = true;
    if (direct) { input = directInput(chord); control = input !== null; }
    else if (logical === "up") input = "selectionPrevious";
    else if (logical === "down") input = "selectionNext";
    else if (logical === "confirm") input = "activateSelected";
    else if (logical === "back") input = "escape";
    else if (logical === "left") input = "groupPrevious";
    else if (logical === "right") input = "groupNext";
    else control = false;
    if (!control) {
      if (states.closeArmed) sendInput("cancelConfirm");
      return;
    }
    consume(event);
    if (!input) return;
    if (event.repeat && input !== "selectionPrevious" && input !== "selectionNext") return;
    if (input === "openTitles") entrySuppressedUntil = Date.now() + settings.doubleInterval;
    if (states.closeArmed && input !== "activateSelected") sendInput("cancelConfirm").then(() => sendInput(input));
    else sendInput(input);
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
    rows.setAttribute("aria-label", "页面操作与标签页");
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
    hud.dataset.page = pageMode ? pageMode.kind : "";
    hud.dataset.close = closePending ? "pending" : "";
    hud.dataset.focusIndex = pageMode?.kind === "focus" ? String(pageMode.index + 1) : "";
    hud.dataset.focusTotal = pageMode?.kind === "focus" ? String(pageMode.total) : "";
    hud.dataset.position = String(states.position);
    hud.dataset.total = String(states.total);
    hud.dataset.activeTab = states.activeTabId == null ? "" : String(states.activeTabId);
    hud.dataset.selected = states.selectedTabId == null ? "" : String(states.selectedTabId);
    hud.dataset.tabs = String(states.tabs.length);
    hud.dataset.group = states.menuGroup;
    hud.dataset.item = states.selectedItemId;
    hud.dataset.action = states.phase === "titles" ? states.selectedItemId : "";
    hud.dataset.closeArmed = states.phase === "titles" && states.closeArmed ? "true" : "";
    hud.dataset.icons = states.phase === "titles" ? String(states.menuItems.filter(item => typeof item.icon === "string" && item.icon).length) : "";
    const active = states.tabs.find(tab => tab.active);
    if (pageMode) {
      hudParts.rows.hidden = true;
      hudParts.rows.replaceChildren();
      const focus = pageMode.kind === "focus";
      const pick = pageMode.kind === "inputPick";
      const scroll = pageMode.kind === "scroll";
      hudParts.meta.textContent = focus ? `焦点 ${pageMode.index + 1} / ${pageMode.total}` :
        pick ? `输入框 ${pageMode.index + 1} / ${pageMode.total}` : scroll ? "滚动网页" : "文字输入";
      hudParts.meta.className = "meta";
      hudParts.current.textContent = scroll ? "方向键滚动当前网页" : labelOf(focus ? document.activeElement : pageMode.element) || "页面元素";
      hudParts.footer.textContent = pageNotice || (focus ? "方向键移动焦点 · Enter 激活 · Esc 返回直控" :
        pick ? "方向键选择输入框 · Enter 输入 · Esc 返回菜单" : scroll ? "↑↓ 小步滚动 · ←→ 翻屏 · 确认返回菜单 · Esc 返回直控" : "直接输入或语音 · Esc 返回输入框选择");
      hudParts.footer.className = pageNotice ? "footer error" : "footer";
      return;
    }
    hudParts.meta.textContent = `标签页 ${states.position} / ${states.total}`;
    hudParts.meta.className = "meta";
    hudParts.current.textContent = active?.title || "当前页面无法显示标题";
    if (states.phase !== "titles") {
      hudParts.rows.hidden = true;
      hudParts.rows.replaceChildren();
      const extras = [["focusMode", "焦点模式"], ["focusInput", "定位输入框"], ["browserClose", "关闭标签页"]]
        .filter(([action]) => settings.bindings[action])
        .map(([action, name]) => `${R.label(settings.bindings[action])} ${name}`);
      hudParts.footer.textContent = closePending ? closeHint() : pageNotice ||
        `↑↓ 切换标签 · 确认打开菜单 · ←→ 后退/前进\n再次双击入口键也可打开菜单${extras.length ? ` · ${extras.join(" · ")}` : ""} · Esc 退出`;
      hudParts.footer.className = pageNotice ? "footer error" : "footer";
      return;
    }
    hudParts.rows.hidden = false;
    hudParts.rows.replaceChildren();
    let selectedRow = null;
    const rowFor = (selected, labelText, hint, data, icon, optional = false) => {
      const row = document.createElement("div");
      row.className = selected ? "row selected" : "row";
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", String(selected));
      Object.assign(row.dataset, data);
      const label = document.createElement("span");
      label.textContent = labelText;
      if (icon) {
        const lead = document.createElement("span");
        lead.style.cssText = "display:flex;align-items:center;gap:10px;min-width:0;overflow:hidden";
        label.style.cssText = "min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
        lead.append(R.buildIcon(document, icon, labelText, { optional }), label);
        row.append(lead);
      } else row.append(label);
      const ordinal = document.createElement("span");
      ordinal.className = "ordinal";
      ordinal.textContent = hint;
      row.append(ordinal);
      if (selected) selectedRow = row;
      hudParts.rows.append(row);
    };
    const group = R.BROWSER_GROUPS?.find(item => item.id === states.menuGroup);
    hudParts.meta.textContent = group?.title || states.menuGroup;
    for (const item of states.menuItems) {
      const selected = item.id === states.selectedItemId;
      rowFor(selected, item.id === "close" && states.closeArmed ? "再按确认关闭" : item.title || "无标题",
        item.hint || "", { itemId: String(item.id) }, typeof item.icon === "string" ? item.icon : "", item.iconOptional === true);
    }
    hudParts.footer.textContent = states.closeArmed
      ? "再按确认关闭当前标签页 · 其他键取消"
      : "←→ 切换分组 · ↑↓ 选择 · Enter 执行 · Esc 返回直控";
    if (pageNotice) hudParts.footer.textContent = pageNotice;
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
  window.addEventListener("blur", () => { consumed.clear(); entry.reset(); resetPageState(); });
  window.addEventListener("focus", refresh);
  window.addEventListener("pageshow", () => { resetPageState(false); refresh(); });
  window.addEventListener("popstate", () => resetPageState());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refresh();
    else resetPageState();
  });
  document.addEventListener("fullscreenchange", () => { if (states.active) render(); });
  chrome.runtime.onMessage.addListener((message) => {
    if (!message) return;
    if (message.type === "remote:browser-state-changed") applyState(message.state);
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.remoteSettings) return;
    settings = R.normalize(changes.remoteSettings.newValue);
    loaded = true;
    entry.reset();
    resetPageState();
    // Disabling the takeover or removing the binding ends the global mode everywhere.
    if (states.active && (!settings.enabled || !settings.bindings.browser)) send({ type: "remote:browser-exit" });
  });
  // A late injection after the permission grant may find the controller already active.
  globalThis.__remoteBrowserController = { reconnect() { refresh(); render(); } };

  settingsChanged();
  if (top) refresh();
})();
