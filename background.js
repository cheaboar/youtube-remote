"use strict";
// Serialize updates so rapid selection changes cannot overwrite another route.
let queue = Promise.resolve();
// Browser-mode commands are serialized separately from snapshot/diagnostic traffic.
let modeQueue = Promise.resolve();

const MODE_KEY = "remote:browser-mode";
const SCRIPT_ID = "youtube-remote-browser-global";
const SITE_ORIGINS = ["http://*/*", "https://*/*"];
const YOUTUBE = /^https:\/\/www\.youtube\.com\//;
const BROWSER_INPUTS = ["previousTab", "nextTab", "reload", "back", "forward", "openTitles",
  "selectionPrevious", "selectionNext", "activateSelected", "escape"];

function normalizeMode(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    active: source.active === true,
    sessionId: typeof source.sessionId === "string" ? source.sessionId.slice(0, 60) : "",
    revision: Number.isFinite(source.revision) ? source.revision : 0,
    windowId: Number.isFinite(source.windowId) ? source.windowId : null,
    phase: source.phase === "titles" ? "titles" : "direct",
    selectedTabId: Number.isFinite(source.selectedTabId) ? source.selectedTabId : null,
    notifyTabId: Number.isFinite(source.notifyTabId) ? source.notifyTabId : null,
    lastOperation: source.lastOperation && typeof source.lastOperation === "object"
      ? { key: String(source.lastOperation.key || "").slice(0, 30), time: Number(source.lastOperation.time) || 0 }
      : { key: "", time: 0 },
    recent: Array.isArray(source.recent) ? source.recent.filter(item => typeof item === "string").slice(-20) : []
  };
}
async function readMode() {
  try {
    const stored = await chrome.storage.session.get(MODE_KEY);
    return normalizeMode(stored[MODE_KEY]);
  } catch (_) {
    return normalizeMode(null);
  }
}
async function writeMode(mode) {
  try { await chrome.storage.session.set({ [MODE_KEY]: mode }); } catch (_) { /* Session store may be unavailable. */ }
  return mode;
}
function serialized(task) {
  modeQueue = modeQueue.catch(() => {}).then(task);
  return modeQueue;
}

async function windowTabs(windowId) {
  if (!Number.isFinite(windowId)) return [];
  try {
    const tabs = await chrome.tabs.query({ windowId });
    return tabs.sort((a, b) => a.index - b.index);
  } catch (_) {
    return [];
  }
}
// Keeps the current revision so a controller that missed the exit broadcast accepts the reset.
const inactiveView = revision => ({ active: false, revision: Number.isFinite(revision) ? revision : 0, sessionId: "", phase: "direct" });
// The extension stores refuse content scripts even over https.
const STORE = /^https:\/\/(?:chromewebstore\.google\.com|chrome\.google\.com\/webstore|microsoftedge\.microsoft\.com\/addons)\//i;
const controllableUrl = (url, granted) =>
  YOUTUBE.test(url || "") || (granted && /^https?:/i.test(url || "") && !STORE.test(url));
// Only tabs that can actually run the controller are listed and reachable: the YouTube tabs, plus
// ordinary web pages once the optional access is granted. Browser pages, the Web Store, extension
// pages and file URLs would swallow the switch and leave the remote with nothing to talk to.
async function controllableTabs(windowId) {
  const granted = await siteGranted();
  return (await windowTabs(windowId)).filter(tab => controllableUrl(tab.url, granted));
}
async function modeView(mode, { titles = true } = {}) {
  if (!mode.active) return inactiveView(mode.revision);
  const tabs = await controllableTabs(mode.windowId);
  const activeTab = tabs.find(tab => tab.active) || null;
  const position = activeTab ? tabs.indexOf(activeTab) + 1 : 0;
  const view = { active: true, revision: mode.revision, sessionId: mode.sessionId, phase: mode.phase,
    windowId: mode.windowId, activeTabId: activeTab?.id ?? null, position, total: tabs.length,
    selectedTabId: mode.selectedTabId };
  if (!titles) return view;
  // Titles leave the worker only for the top frame of the tab that owns the HUD.
  view.tabs = tabs.map(tab => ({ id: tab.id, index: tab.index, active: !!tab.active,
    title: typeof tab.title === "string" ? tab.title.slice(0, 160) : "" }));
  return view;
}
async function pushAfter(mode) {
  const target = mode.notifyTabId;
  if (!Number.isFinite(target)) return;
  try {
    const view = await modeView(mode, { titles: true });
    chrome.tabs.sendMessage(target, { type: "remote:browser-state-changed", state: view }).catch(() => {});
  } catch (_) { /* The target tab may be gone. */ }
}
let pushTimer;
function schedulePush() {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => { void pushActive(); }, 60);
}
async function pushActive() {
  const mode = await readMode();
  if (!mode.active) return;
  const tabs = await windowTabs(mode.windowId);
  const activeTab = tabs.find(tab => tab.active);
  if (activeTab && activeTab.id !== mode.notifyTabId) {
    mode.notifyTabId = activeTab.id;
    await writeMode(mode);
  }
  await pushAfter(mode);
}
// A background tab never hears about an exit performed in another tab. Tell it as soon as it is
// activated, otherwise its HUD stays up and its controller keeps swallowing keys.
async function notifyActivated(tabId, windowId) {
  const mode = await readMode();
  const view = mode.active && mode.windowId === windowId
    ? await modeView(mode, { titles: true })
    : inactiveView(mode.revision);
  try { chrome.tabs.sendMessage(tabId, { type: "remote:browser-state-changed", state: view }).catch(() => {}); }
  catch (_) { /* Restricted tabs have no controller. */ }
}

function controllerSender(sender) {
  return !!sender && !!sender.tab && typeof sender.tab.id === "number" && typeof sender.tab.windowId === "number" &&
    typeof sender.url === "string" && /^https?:/i.test(sender.url);
}
function extensionSender(sender) {
  return !!sender && typeof sender.url === "string" && sender.url.startsWith(chrome.runtime.getURL(""));
}
async function siteGranted() {
  try { return await chrome.permissions.contains({ origins: SITE_ORIGINS }); }
  catch (_) { return false; }
}
async function eligibleController(sender) {
  if (!controllerSender(sender)) return false;
  // The YouTube controller ships statically; any other origin needs the optional grant so that
  // a script left behind by a revoked permission cannot keep issuing commands.
  return YOUTUBE.test(sender.url) || await siteGranted();
}

async function enterMode(sender) {
  if (!controllerSender(sender)) return { ok: false, error: { code: "NOT_AUTHORIZED" } };
  const tabs = await windowTabs(sender.tab.windowId);
  const activeTab = tabs.find(tab => tab.active);
  if (!activeTab) return { ok: false, error: { code: "OPERATION_FAILED" }, state: await modeView(await readMode()) };
  // Entry is only valid from the tab the user is looking at.
  if (sender.tab.id !== activeTab.id) {
    return { ok: false, error: { code: "NOT_ACTIVE_TAB" }, state: await modeView(await readMode()) };
  }
  // Revisions stay monotonic across sessions; restarting at 1 would be dropped as stale by every
  // controller that already saw a higher revision from a previous session.
  const previous = await readMode();
  const mode = normalizeMode({ active: true, sessionId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    revision: previous.revision + 1, windowId: sender.tab.windowId, phase: "direct", selectedTabId: activeTab.id,
    notifyTabId: sender.tab.id });
  await writeMode(mode);
  await pushAfter(mode);
  return { ok: true, state: await modeView(mode, { titles: true }) };
}
async function deactivateMode() {
  const mode = await readMode();
  if (!mode.active) return await modeView(mode);
  mode.active = false;
  mode.phase = "direct";
  mode.selectedTabId = null;
  mode.revision += 1;
  await writeMode(mode);
  await pushAfter(mode);
  return await modeView(mode);
}
async function exitMode(sender) {
  const mode = await readMode();
  if (!mode.active) return { ok: true, state: await modeView(mode) };
  if (controllerSender(sender) && sender.tab.windowId !== mode.windowId) {
    return { ok: false, error: { code: "NOT_AUTHORIZED" }, state: await modeView(mode) };
  }
  return { ok: true, state: await deactivateMode() };
}
async function stateReply(sender) {
  const mode = await readMode();
  if (mode.active && controllerSender(sender) && sender.tab.windowId !== mode.windowId) {
    return { ok: true, state: inactiveView(mode.revision) };
  }
  return { ok: true, state: await modeView(mode, { titles: !controllerSender(sender) || sender.frameId === 0 }) };
}

async function handleInput(message, sender) {
  const mode = await readMode();
  if (!mode.active) return { ok: false, error: { code: "NOT_ACTIVE", message: "浏览器模式未开启" }, state: await modeView(mode) };
  if (!controllerSender(sender)) return { ok: false, error: { code: "NOT_AUTHORIZED" }, state: await modeView(mode) };
  if (message.sessionId !== mode.sessionId || sender.tab.windowId !== mode.windowId) {
    return { ok: false, error: { code: "STALE_SESSION" }, state: await modeView(mode) };
  }
  if (!BROWSER_INPUTS.includes(message.input)) return { ok: false, error: { code: "INVALID_INPUT" }, state: await modeView(mode) };
  const requestId = typeof message.requestId === "string" ? message.requestId.slice(0, 60) : "";
  if (requestId && mode.recent.includes(requestId)) return { ok: true, state: await modeView(mode, { titles: true }) };

  // Switching and the title list share the same list, so a restricted tab can never be reached.
  const tabs = await controllableTabs(mode.windowId);
  const activeTab = tabs.find(tab => tab.active);
  if (!activeTab) return { ok: false, error: { code: "OPERATION_FAILED" }, state: await modeView(mode) };
  if (sender.tab.id !== activeTab.id) return { ok: false, error: { code: "NOT_ACTIVE_TAB" }, state: await modeView(mode) };

  const index = tabs.indexOf(activeTab);
  let error = null;
  switch (message.input) {
    case "previousTab":
    case "nextTab": {
      if (tabs.length > 1) {
        const step = message.input === "nextTab" ? 1 : -1;
        const next = tabs[(index + step + tabs.length) % tabs.length];
        try { await chrome.tabs.update(next.id, { active: true }); }
        catch (_) { error = { code: "OPERATION_FAILED" }; }
      }
      break;
    }
    case "reload":
      try { await chrome.tabs.reload(activeTab.id); }
      catch (_) { error = { code: "OPERATION_FAILED" }; }
      break;
    case "back":
      try { await chrome.tabs.goBack(activeTab.id); }
      catch (_) { error = { code: "NO_HISTORY", message: "没有可返回的页面" }; }
      break;
    case "forward":
      try { await chrome.tabs.goForward(activeTab.id); }
      catch (_) { error = { code: "NO_HISTORY", message: "没有可前进的页面" }; }
      break;
    case "openTitles":
      mode.phase = "titles";
      mode.selectedTabId = activeTab.id;
      break;
    case "selectionPrevious":
    case "selectionNext": {
      if (mode.phase !== "titles" || !tabs.length) break;
      const current = tabs.findIndex(tab => tab.id === mode.selectedTabId);
      const step = message.input === "selectionNext" ? 1 : -1;
      mode.selectedTabId = tabs[Math.max(0, Math.min(tabs.length - 1, Math.max(0, current) + step))].id;
      break;
    }
    case "activateSelected": {
      if (mode.phase !== "titles") break;
      const target = tabs.find(tab => tab.id === mode.selectedTabId);
      if (!target) {
        mode.selectedTabId = activeTab.id;
        error = { code: "TAB_GONE" };
        break;
      }
      if (Number.isFinite(message.expectedTabId) && message.expectedTabId !== target.id) {
        error = { code: "STALE_SELECTION" };
        break;
      }
      try { await chrome.tabs.update(target.id, { active: true }); }
      catch (_) { error = { code: "OPERATION_FAILED" }; }
      mode.phase = "direct";
      mode.selectedTabId = target.id;
      break;
    }
    case "escape": {
      if (mode.phase === "titles") {
        mode.phase = "direct";
        mode.selectedTabId = activeTab.id;
        break;
      }
      return { ok: true, state: await deactivateMode() };
    }
  }

  if (requestId) {
    mode.recent.push(requestId);
    if (mode.recent.length > 20) mode.recent.shift();
  }
  mode.revision += 1;
  const latest = (await windowTabs(mode.windowId)).find(tab => tab.active);
  if (latest) mode.notifyTabId = latest.id;
  await writeMode(mode);
  await pushAfter(mode);
  return { ok: !error, error: error || undefined, state: await modeView(mode, { titles: true }) };
}

async function syncBrowserScripts({ inject = false } = {}) {
  const granted = await siteGranted();
  let registered = [];
  try { registered = await chrome.scripting.getRegisteredContentScripts({ ids: [SCRIPT_ID] }); }
  catch (_) { registered = []; }
  if (granted && !registered.length) {
    try {
      await chrome.scripting.registerContentScripts([{
        id: SCRIPT_ID,
        matches: SITE_ORIGINS,
        excludeMatches: ["https://www.youtube.com/*"],
        js: ["remote.js", "browser.js"],
        runAt: "document_start",
        allFrames: true,
        persistAcrossSessions: true
      }]);
    } catch (_) { /* Registration can fail while another tab is starting. */ }
  } else if (!granted && registered.length) {
    try { await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] }); }
    catch (_) { /* Already unregistered. */ }
  }
  if (granted && inject) await injectOpenTabs();
  return granted;
}
async function injectOpenTabs() {
  let tabs = [];
  try { tabs = await chrome.tabs.query({}); }
  catch (_) { return; }
  for (const tab of tabs) {
    if (typeof tab.id !== "number" || !/^https?:/i.test(tab.url || "") || YOUTUBE.test(tab.url)) continue;
    // Registering a script never injects into documents that are already open.
    try { await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ["remote.js", "browser.js"] }); }
    catch (_) { /* Restricted, discarded or closing tabs are expected to fail. */ }
  }
}

async function browserMessage(message, sender) {
  if (!extensionSender(sender) && !await eligibleController(sender)) {
    return { ok: false, error: { code: "NOT_AUTHORIZED" }, state: await modeView(normalizeMode(null)) };
  }
  switch (message.type) {
    case "remote:browser-state":
      return stateReply(sender);
    case "remote:browser-enter":
      return serialized(() => enterMode(sender));
    case "remote:browser-input":
      return serialized(() => handleInput(message, sender));
    case "remote:browser-exit":
      return serialized(() => exitMode(sender));
    case "remote:browser-permission-sync": {
      if (!extensionSender(sender)) return { ok: false };
      const granted = await syncBrowserScripts({ inject: true });
      return { ok: true, granted };
    }
    default:
      return { ok: false };
  }
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (!message || typeof message !== "object" || typeof message.type !== "string") return;
  if (message.type.startsWith("remote:browser-")) {
    browserMessage(message, sender).then(respond, () => respond({ ok: false }));
    return true;
  }
  if (!sender.tab || sender.frameId !== 0 || !YOUTUBE.test(sender.url || "")) return;
  if (message.type === "remote:tab-command") {
    if (!["closeTab", "reload"].includes(message.command)) { respond({ ok: false }); return; }
    const operation = message.command === "closeTab" ? chrome.tabs.remove(sender.tab.id) : chrome.tabs.reload(sender.tab.id);
    operation.then(() => respond({ ok: true }), () => respond({ ok: false }));
    return true;
  }
  const key = `remote:tab:${sender.tab.id}`;
  queue = queue.catch(() => {}).then(async () => {
    const stored = (await chrome.storage.session.get(key))[key] || { routes: {}, events: [] };
    if (message.type === "remote:restore") {
      respond(stored.routes[message.route] || null);
      return;
    }
    if (message.type === "remote:save" && typeof message.route === "string" && message.route.length < 4096) {
      const snapshot = message.snapshot;
      if (!snapshot || !["list", "sidebar", "guide", "player", "comments"].includes(snapshot.region)) return respond(null);
      delete stored.routes[message.route];
      stored.routes[message.route] = snapshot;
      while (Object.keys(stored.routes).length > 30) delete stored.routes[Object.keys(stored.routes)[0]];
    } else if (message.type === "remote:diagnostic") {
      const e = message.event;
      if (!e || typeof e.key !== "string") return respond(null);
      stored.events.push({ time: Date.now(), type: String(e.type).slice(0, 30), key: e.key.slice(0, 80),
        code: String(e.code || "").slice(0, 60), repeat: !!e.repeat, composing: !!e.composing,
        region: String(e.region).slice(0, 20), action: String(e.action || "").slice(0, 30) });
      stored.events = stored.events.slice(-60);
    } else return respond(null);
    await chrome.storage.session.set({ [key]: stored });
    respond(true);
  }).catch(() => respond(null));
  return true;
});

chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  void notifyActivated(tabId, windowId);
  schedulePush();
});
chrome.tabs.onCreated.addListener(() => schedulePush());
chrome.tabs.onMoved.addListener(() => schedulePush());
chrome.tabs.onAttached.addListener(() => schedulePush());
chrome.tabs.onDetached.addListener(() => schedulePush());
chrome.tabs.onReplaced.addListener(() => schedulePush());
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.title !== undefined || changeInfo.status === "complete") schedulePush();
});
chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  void serialized(async () => {
    const mode = await readMode();
    if (!mode.active || removeInfo?.windowId !== mode.windowId) return;
    const tabs = await windowTabs(mode.windowId);
    if (!tabs.length) { await deactivateMode(); return; }
    if (!tabs.some(tab => tab.id === mode.selectedTabId)) {
      mode.selectedTabId = (tabs.find(tab => tab.active) || tabs[0]).id;
      mode.revision += 1;
      await writeMode(mode);
    }
    schedulePush();
  });
});
chrome.windows.onRemoved.addListener((windowId) => {
  void serialized(async () => {
    const mode = await readMode();
    if (mode.active && mode.windowId === windowId) await deactivateMode();
  });
});
chrome.permissions.onAdded.addListener(() => { void syncBrowserScripts({ inject: true }); });
chrome.permissions.onRemoved.addListener(() => {
  void serialized(async () => {
    const mode = await readMode();
    if (mode.active) await deactivateMode();
    await syncBrowserScripts();
  });
});
chrome.runtime.onInstalled.addListener(() => { void syncBrowserScripts(); });
chrome.runtime.onStartup.addListener(() => { void syncBrowserScripts(); });
void syncBrowserScripts();

chrome.tabs.onRemoved.addListener((tabId) => {
  queue = queue.catch(() => {}).then(() => chrome.storage.session.remove(`remote:tab:${tabId}`));
});
