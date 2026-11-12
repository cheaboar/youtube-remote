(() => {
  "use strict";
  const R = globalThis.YouTubeRemote;
  const groups = document.querySelector("#groups"), list = document.querySelector("#items");
  const status = document.querySelector("#status");
  const params = new URL(location.href).searchParams;
  const sessionId = params.get("session") || "", token = params.get("token") || "";
  let state = null, settings = R.cloneDefaults(), tabId = null, request = 0, busy = false, notice = "", expired = false;
  const consumed = new Set();
  const send = message => chrome.runtime.sendMessage({ sessionId, token, tabId, ...message }).catch(() => null);
  const id = () => `recovery-${Date.now().toString(36)}-${(++request).toString(36)}`;
  function apply(next) {
    if (!next) return;
    // A pushed state from another session means this page is a leftover from an earlier mode;
    // mark it expired and stop taking keys instead of silently swallowing the remote forever.
    if (next.sessionId && next.sessionId !== sessionId) {
      expired = true;
      state = { active: false };
      render();
      return;
    }
    if (state && next.revision < state.revision) return;
    state = next;
    render();
  }
  function render() {
    document.body.dataset.active = String(!!state?.active);
    document.body.dataset.ready = String(!!state?.active && state.phase === "titles" && !busy);
    document.body.dataset.group = state?.menuGroup || "";
    document.body.dataset.selected = state?.selectedItemId || "";
    if (!state?.active) {
      list.replaceChildren(); groups.replaceChildren();
      status.textContent = notice || (expired ? "此恢复页已过期，请从普通网页重新进入浏览器模式。"
        : "遥控模式已退出。请从普通网页重新进入。");
      return;
    }
    groups.replaceChildren(...R.BROWSER_GROUPS.map(item => {
      const tag = document.createElement("span"); tag.textContent = item.title;
      if (item.id === state.menuGroup) tag.className = "selected";
      return tag;
    }));
    list.replaceChildren(...(state.menuItems || []).map(item => {
      const button = document.createElement("button"); button.type = "button";
      const selected = item.id === state.selectedItemId;
      button.className = selected ? "selected" : "";
      button.dataset.item = item.id;
      const text = document.createElement("span");
      text.textContent = `${item.title}${item.hint ? ` · ${item.hint}` : ""}`;
      if (typeof item.icon === "string" && item.icon) {
        button.style.cssText = "display:flex;align-items:center;gap:12px";
        button.append(R.buildIcon(document, item.icon, item.title, { optional: item.iconOptional === true }), text);
      } else button.append(text);
      button.setAttribute("aria-disabled", String(!!item.disabled));
      button.setAttribute("role", "option"); button.setAttribute("aria-selected", String(selected));
      button.addEventListener("click", () => {
        if (selected) void dispatch("activateSelected", { expectedItemId: item.id });
      });
      return button;
    }));
    list.querySelector(".selected")?.scrollIntoView({ block: "nearest" });
    status.textContent = notice || (state.closeArmed ? "再次确认移除收藏 · 方向键取消" : "选择网站或恢复上次关闭的网页。返回键退出模式。");
  }
  async function dispatch(input, extra = {}) {
    if (!state?.active || busy) return;
    busy = true; notice = "";
    try {
      const result = await send({ type: "remote:browser-input", input, requestId: id(), ...extra });
      if (!result) notice = "连接中断，请重试。";
      else if (!result.ok) notice = result.error?.message || "此操作当前不可用，请选择其他操作。";
      apply(result?.state);
    } finally { busy = false; render(); }
  }
  addEventListener("keydown", event => {
    if (event.isComposing || event.keyCode === 229) return;
    const key = R.chord(event);
    const logical = R.resolve(settings, key) || { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right", Enter: "confirm", Escape: "back" }[key];
    if (!["up", "down", "left", "right", "confirm", "back"].includes(logical)) return;
    // An inactive or expired page must not keep swallowing keys.
    if (!state?.active) return;
    event.preventDefault(); event.stopImmediatePropagation(); consumed.add(event.code || event.key);
    if (event.repeat || busy) return;
    if (logical === "confirm") { void dispatch("activateSelected", { expectedItemId: state.selectedItemId }); return; }
    if (logical === "back") {
      busy = true;
      void send({ type: "remote:browser-exit" }).then(result => {
        apply(result?.state); busy = false;
      });
      return;
    }
    void dispatch({ left: "groupPrevious", right: "groupNext", up: "selectionPrevious", down: "selectionNext" }[logical]);
  }, true);
  addEventListener("keyup", event => {
    if (consumed.delete(event.code || event.key)) { event.preventDefault(); event.stopImmediatePropagation(); }
  }, true);
  addEventListener("blur", () => { consumed.clear(); if (state?.closeArmed) void dispatch("cancelConfirm"); });
  chrome.runtime.onMessage.addListener(message => {
    if (message?.type === "remote:browser-state-changed") apply(message.state);
  });
  async function reconnect() {
    if (!tabId) return;
    const result = await send({ type: "remote:browser-state" });
    apply(result?.state);
    if (state?.active && state.phase !== "titles") await dispatch("openTitles");
  }
  addEventListener("focus", () => { void reconnect(); });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void reconnect();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.remoteSettings) return;
    settings = R.normalize(changes.remoteSettings.newValue);
    // Disabling the takeover or clearing the entry binding ends the mode on every page.
    if (state?.active && (!settings.enabled || !settings.bindings.browser)) {
      void send({ type: "remote:browser-exit" }).then(result => apply(result?.state));
    }
  });
  void (async () => {
    settings = R.normalize((await chrome.storage.local.get("remoteSettings")).remoteSettings);
    tabId = (await chrome.tabs.getCurrent())?.id;
    if (!tabId || !sessionId || !token) { notice = "恢复页地址无效。"; render(); return; }
    const ready = await send({ type: "remote:recovery-ready" });
    if (!ready?.ok) { notice = "恢复页连接失败，请从普通网页重新进入。"; render(); return; }
    // Ready is handled outside the operation queue. This state query waits for the operation
    // that created this page to finish before attempting to show its menu.
    const result = await send({ type: "remote:browser-state" });
    if (!result?.ok) { notice = "恢复页未被授权，请从普通网页重新进入浏览器模式。"; render(); return; }
    apply(result.state);
    if (state?.active) await dispatch("openTitles");
  })().catch(() => { notice = "恢复页连接失败。"; render(); });
})();
