"use strict";
importScripts("remote.js");
const R = globalThis.YouTubeRemote;
// Serialize updates so rapid selection changes cannot overwrite another route.
let queue = Promise.resolve();
// Browser-mode commands are serialized separately from snapshot/diagnostic traffic.
let modeQueue = Promise.resolve();

const MODE_KEY = "remote:browser-mode";
const SCRIPT_ID = "youtube-remote-browser-global";
const SITE_ORIGINS = ["http://*/*", "https://*/*"];
const YOUTUBE = /^https:\/\/www\.youtube\.com\//;
const BROWSER_INPUTS = ["previousTab", "nextTab", "reload", "back", "forward", "closeTab", "openTitles",
  "selectionPrevious", "selectionNext", "activateSelected", "escape", "groupPrevious", "groupNext", "cancelConfirm"];
// The action list opens on the same double tap as the title list, so every page command works with
// the remote's arrow, confirm and back keys. Actions come first; tabs follow.
const PAGE_ACTIONS = ["focus", "input", "googleSearch", "reload", "close"];

function normalizeMode(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    active: source.active === true,
    sessionId: typeof source.sessionId === "string" ? source.sessionId.slice(0, 60) : "",
    revision: Number.isFinite(source.revision) ? source.revision : 0,
    windowId: Number.isFinite(source.windowId) ? source.windowId : null,
    phase: source.phase === "titles" ? "titles" : "direct",
    selectedAction: PAGE_ACTIONS.includes(source.selectedAction) ? source.selectedAction : "",
    closeArmed: source.closeArmed === true,
    closeTarget: source.closeTarget && typeof source.closeTarget === "object" ? source.closeTarget : null,
    menuGroup: R.BROWSER_GROUPS.some(g => g.id === source.menuGroup) ? source.menuGroup : "common",
    selectedItemId: typeof source.selectedItemId === "string" ? source.selectedItemId : "previousRecent",
    recoveryTabId: Number.isFinite(source.recoveryTabId) ? source.recoveryTabId : null,
    recoveryToken: typeof source.recoveryToken === "string" ? source.recoveryToken : "",
    failedRecoveryHost: Number.isFinite(source.failedRecoveryHost) ? source.failedRecoveryHost : null,
    selectedTabId: Number.isFinite(source.selectedTabId) ? source.selectedTabId : null,
    // The tab that actually hosts the controller. History can carry it to about:blank or a
    // browser page, where no content script runs; the mode uses this to find out that it was
    // its own host that left and not a tab the user opened on purpose.
    hostTabId: Number.isFinite(source.hostTabId) ? source.hostTabId : null,
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
  const activeTab = tabs.find(tab => tab.active) || (await windowTabs(mode.windowId)).find(tab => tab.active && tab.id === mode.recoveryTabId && recoveryUrl(tab.url)) || null;
  const position = activeTab ? tabs.indexOf(activeTab) + 1 : 0;
  const view = { active: true, revision: mode.revision, sessionId: mode.sessionId, phase: mode.phase,
    windowId: mode.windowId, activeTabId: activeTab?.id ?? null, position, total: tabs.length,
    selectedTabId: mode.selectedTabId, selectedAction: mode.selectedAction, closeArmed: mode.closeArmed };
  if (!titles) return view;
  // Titles leave the worker only for the top frame of the tab that owns the HUD.
  view.tabs = tabs.map(tab => ({ id: tab.id, index: tab.index, active: !!tab.active,
    title: typeof tab.title === "string" ? tab.title.slice(0, 160) : "" }));
  view.menuGroup = mode.menuGroup;
  view.selectedItemId = mode.selectedItemId;
  view.menuItems = await menuItems(mode, tabs);
  return view;
}
// The action list and the tab list share one selection so the remote never needs another key.
function selectionIndex(mode, tabs) {
  if (mode.selectedAction) return PAGE_ACTIONS.indexOf(mode.selectedAction);
  const index = tabs.findIndex(tab => tab.id === mode.selectedTabId);
  return PAGE_ACTIONS.length + Math.max(0, index);
}
function selectIndex(mode, tabs, index) {
  const next = Math.max(0, Math.min(PAGE_ACTIONS.length + tabs.length - 1, index));
  mode.closeArmed = false;
  if (next < PAGE_ACTIONS.length) {
    mode.selectedAction = PAGE_ACTIONS[next];
  } else {
    mode.selectedAction = "";
    mode.selectedTabId = tabs[next - PAGE_ACTIONS.length].id;
  }
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
  pushTimer = setTimeout(() => { void serialized(pushActive); }, 60);
}
async function pushActive() {
  const mode = await readMode();
  if (!mode.active) return;
  const tabs = await windowTabs(mode.windowId);
  const activeTab = tabs.find(tab => tab.active);
  if (activeTab) {
    let changed = false;
    if (activeTab.id !== mode.notifyTabId) {
      mode.notifyTabId = activeTab.id;
      changed = true;
    }
    // Remember the last page that can actually receive remote keys. A blank or browser page
    // must not become the host, or the mode would have nothing to talk to.
    if (controllableUrl(activeTab.url, await siteGranted()) && activeTab.id !== mode.hostTabId) {
      mode.hostTabId = activeTab.id;
      changed = true;
    }
    if (changed) await writeMode(mode);
  }
  await pushAfter(mode);
}
// Returning through history can land on about:blank, the new-tab page or a browser page. No
// controller can run there, so the remote would go dead. When the host itself navigated away,
// move the mode to the nearest controllable tab and keep the remote in charge.
async function rehomeStranded(mode, { requireHost = true } = {}) {
  if (!mode.active) return false;
  if (requireHost && !Number.isFinite(mode.hostTabId)) return false;
  const tabs = await windowTabs(mode.windowId);
  const activeTab = tabs.find(tab => tab.active);
  if (!activeTab || (requireHost && activeTab.id !== mode.hostTabId)) return false;
  const granted = await siteGranted();
  if (!activeTab.url || controllableUrl(activeTab.url, granted)) return false;
  const candidates = tabs.filter(tab => tab.id !== activeTab.id && controllableUrl(tab.url, granted))
    .sort((a, b) => a.index - b.index);
  if (!candidates.length) {
    // Only our current recovery page counts as a valid fallback. A page left over from an older
    // session must not swallow the mode: it has no controller for this session.
    if (activeTab.id === mode.recoveryTabId && recoveryUrl(activeTab.url)) return false;
    if (mode.failedRecoveryHost === activeTab.id) return false;
    const target = await prepareRecovery(mode);
    if (!target) { mode.failedRecoveryHost = activeTab.id; await writeMode(mode); return false; }
    try { await chrome.tabs.update(target.id, { active: true }); } catch (_) { return false; }
    mode.phase = "direct"; mode.closeArmed = false; mode.closeTarget = null;
    mode.hostTabId = target.id; mode.notifyTabId = target.id; mode.revision += 1;
    await writeMode(mode); await pushAfter(mode); return true;
  }
  // Prefer the tab to the right, wrapping to the last one when the host was the rightmost tab.
  const target = candidates.find(tab => tab.index > activeTab.index) || candidates[candidates.length - 1];
  try { await chrome.tabs.update(target.id, { active: true }); }
  catch (_) { return false; }
  mode.phase = "direct";
  mode.selectedAction = "";
  mode.closeArmed = false;
  mode.selectedTabId = target.id;
  mode.hostTabId = target.id;
  mode.notifyTabId = target.id;
  mode.revision += 1;
  await writeMode(mode);
  await pushAfter(mode);
  return true;
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
    hostTabId: activeTab.id, notifyTabId: sender.tab.id });
  await rememberActive(mode.windowId, activeTab.id);
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
  if (recoveryUrl(sender.url)) {
    const active = (await windowTabs(mode.windowId)).find(t => t.active);
    if (!mode.active || !sender.tab || sender.frameId !== 0 || sender.tab.id !== mode.recoveryTabId ||
        sender.tab.windowId !== mode.windowId || active?.id !== sender.tab.id || active.url !== sender.url || !mode.recoveryToken) {
      return { ok: false, error: { code: "NOT_AUTHORIZED" }, state: inactiveView(mode.revision) };
    }
  }
  if (mode.active && controllerSender(sender) && sender.tab.windowId !== mode.windowId) {
    return { ok: true, state: inactiveView(mode.revision) };
  }
  return { ok: true, state: await modeView(mode, { titles: !controllerSender(sender) || sender.frameId === 0 }) };
}

const MRU_KEY = "remote:browser-mru";
const CLOSED_KEY = "remote:browser-closed";
const pendingRecovery = new Map();
const navigationVersions = new Map();
const recoveryUrl = url => typeof url === "string" && url.split("?")[0].split("#")[0] === chrome.runtime.getURL("recovery.html");
async function storageMap(key) { return (await chrome.storage.session.get(key))[key] || {}; }
async function rememberActive(windowId, tabId) {
  const map = await storageMap(MRU_KEY);
  map[windowId] = [tabId, ...(map[windowId] || []).filter(id => id !== tabId)].slice(0, 100);
  await chrome.storage.session.set({ [MRU_KEY]: map });
}
async function getFavorites() {
  const data = await chrome.storage.local.get(R.FAVORITES_KEY);
  return R.normalizeFavorites(data[R.FAVORITES_KEY]);
}
async function menuItems(mode, tabs) {
  const group = R.BROWSER_GROUPS.find(g => g.id === mode.menuGroup) || R.BROWSER_GROUPS[0];
  const onRecovery = mode.hostTabId === mode.recoveryTabId && Number.isFinite(mode.recoveryTabId);
  const pageOnly = new Set(["focus", "input", "googleSearch", "scroll", "scrollTop", "scrollBottom", "reload", "close"]);
  const decorate = item => onRecovery && pageOnly.has(item.id)
    ? { ...item, disabled: true, hint: "请先打开网页" } : { ...item };
  if (group.id === "tabs") return tabs.filter(t => !recoveryUrl(t.url)).map(t => ({ id: `tab:${t.id}`, title: t.title || t.url || "标签",
    icon: R.safeIconUrl(t.favIconUrl), iconOptional: true }));
  if (group.id === "sites") {
    const favorites = await getFavorites();
    return [{ id: "youtube", title: "YouTube", icon: "https://www.youtube.com/favicon.ico" }, decorate({ id: "favoriteCurrent", title: "收藏当前网页" }),
      ...favorites.map(f => ({ id: `favorite:${f.id}`, title: f.title, icon: R.faviconUrl(f) })),
      ...favorites.map(f => ({ id: `removeFavorite:${f.id}`, title: `移除 ${f.title}` }))];
  }
  return group.items.map(decorate);
}
async function openWeb(mode, url) {
  const safe = R.safeWebUrl(url);
  if (!safe || !controllableUrl(safe, await siteGranted())) return { code: "NOT_AUTHORIZED", message: "请先授权访问普通网页" };
  try {
    const existing = (await windowTabs(mode.windowId)).find(tab => R.safeWebUrl(tab.url) === safe);
    const target = existing ? await chrome.tabs.update(existing.id, { active: true }) : await chrome.tabs.create({ windowId: mode.windowId, url: safe, active: true });
    mode.hostTabId = target.id; mode.notifyTabId = target.id; mode.selectedTabId = target.id;
    await rememberActive(mode.windowId, target.id);
    return null;
  } catch (_) { return { code: "OPERATION_FAILED" }; }
}
async function prepareRecovery(mode) {
  const old = (await windowTabs(mode.windowId)).find(t => t.id === mode.recoveryTabId && recoveryUrl(t.url));
  if (old && mode.recoveryToken) return old;
  const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
  const url = `${chrome.runtime.getURL("recovery.html")}?session=${encodeURIComponent(mode.sessionId)}&token=${encodeURIComponent(token)}`;
  let readyResolve;
  const ready = new Promise(resolve => { readyResolve = resolve; });
  const pending = { sessionId: mode.sessionId, windowId: mode.windowId, token, url, tabId: null, resolve: readyResolve };
  pendingRecovery.set(token, pending);
  try {
    const tab = await chrome.tabs.create({ windowId: mode.windowId, url, active: false });
    pending.tabId = tab.id;
    const ok = await Promise.race([ready, new Promise(resolve => setTimeout(() => resolve(false), 8000))]);
    if (!ok) { chrome.tabs.remove(tab.id).catch(() => {}); return null; }
    mode.recoveryTabId = tab.id; mode.recoveryToken = token;
    return tab;
  } catch (_) { return null; }
  finally { pendingRecovery.delete(token); }
}
async function recoveryReady(message, sender) {
  const pending = pendingRecovery.get(message.token);
  if (!pending || message.sessionId !== pending.sessionId || sender.url !== pending.url ||
      sender.id !== chrome.runtime.id || (sender.frameId !== undefined && sender.frameId !== 0)) return { ok: false };
  const tabId = sender.tab?.id ?? message.tabId;
  const tab = (await windowTabs(pending.windowId)).find(t => t.id === tabId && t.url === pending.url);
  if (!tab || (pending.tabId !== null && pending.tabId !== tab.id)) return { ok: false };
  pending.resolve(true);
  return { ok: true };
}
// Extension documents may omit sender.tab. Bind only our exact recovery document to the tab
// created for this session, checking its full URL and the private per-session token.
async function bindRecoverySender(message, sender) {
  if (!recoveryUrl(sender.url) || sender.id !== chrome.runtime.id ||
      (sender.frameId !== undefined && sender.frameId !== 0)) return null;
  const mode = await readMode();
  const expected = `${chrome.runtime.getURL("recovery.html")}?session=${encodeURIComponent(mode.sessionId)}&token=${encodeURIComponent(mode.recoveryToken)}`;
  if (!mode.active || !mode.recoveryToken || sender.url !== expected ||
      message.sessionId !== mode.sessionId || message.token !== mode.recoveryToken) return null;
  const tab = (await windowTabs(mode.windowId)).find(t => t.id === mode.recoveryTabId && t.url === expected);
  if (!tab || (sender.tab?.id ?? message.tabId) !== tab.id) return null;
  return { ...sender, tab, frameId: 0 };
}
async function handleInput(message, sender) {
  const mode = await readMode();
  const fail = async code => ({ ok: false, error: { code }, state: await modeView(mode) });
  if (!mode.active) return fail("NOT_ACTIVE");
  const recovery = recoveryUrl(sender.url);
  if ((!controllerSender(sender) && !recovery) || !sender.tab || sender.frameId !== 0 ||
      (recovery && (sender.tab.id !== mode.recoveryTabId || !mode.recoveryToken))) return fail("NOT_AUTHORIZED");
  if (message.sessionId !== mode.sessionId || sender.tab.windowId !== mode.windowId) return fail("STALE_SESSION");
  if (!BROWSER_INPUTS.includes(message.input)) return fail("INVALID_INPUT");
  const requestId = typeof message.requestId === "string" ? message.requestId.slice(0, 60) : "";
  if (requestId && mode.recent.includes(requestId)) return { ok: true, state: await modeView(mode) };
  const tabs = await controllableTabs(mode.windowId);
  const allTabs = await windowTabs(mode.windowId);
  const activeTab = allTabs.find(t => t.active);
  if (!activeTab || activeTab.id !== sender.tab.id) return fail("NOT_ACTIVE_TAB");
  if (recovery && (!recoveryUrl(activeTab.url) || activeTab.id !== mode.recoveryTabId || activeTab.url !== sender.url ||
      activeTab.url !== `${chrome.runtime.getURL("recovery.html")}?session=${encodeURIComponent(mode.sessionId)}&token=${encodeURIComponent(mode.recoveryToken)}`)) return fail("NOT_AUTHORIZED");
  let error = null, pageAction;
  const input = message.input;
  const disarm = () => { mode.closeArmed = false; mode.closeTarget = null; };
  if (input !== "activateSelected") disarm();
  try {
    if (input === "previousTab" || input === "nextTab") {
      const choices = recovery ? [activeTab, ...tabs] : tabs;
      if (choices.length > 1) {
        const step = input === "nextTab" ? 1 : -1;
        const target = choices[(choices.findIndex(t => t.id === activeTab.id) + step + choices.length) % choices.length];
        await chrome.tabs.update(target.id, { active: true });
        await rememberActive(mode.windowId, target.id);
      }
    } else if (input === "back" || input === "forward") {
      if (recovery) error = { code: "NOT_AUTHORIZED" };
      else try { await (input === "back" ? chrome.tabs.goBack(activeTab.id) : chrome.tabs.goForward(activeTab.id)); }
      catch (_) { error = { code: "NO_HISTORY", message: input === "back" ? "没有可返回的页面" : "没有可前进的页面" }; }
    } else if (input === "reload") {
      if (recovery) error = { code: "NOT_AUTHORIZED" }; else await chrome.tabs.reload(activeTab.id);
    } else if (input === "closeTab") {
      error = { code: "CONFIRM_REQUIRED", message: "请在页面菜单中确认关闭" };
    } else if (input === "openTitles") {
      mode.phase = "titles"; mode.menuGroup = "common"; mode.selectedItemId = "previousRecent";
    } else if (input === "groupNext" || input === "groupPrevious") {
      if (mode.phase === "titles") {
        const groups = R.BROWSER_GROUPS;
        const index = Math.max(0, groups.findIndex(g => g.id === mode.menuGroup));
        mode.menuGroup = groups[(index + (input === "groupNext" ? 1 : -1) + groups.length) % groups.length].id;
        mode.selectedItemId = (await menuItems(mode, tabs))[0]?.id || "";
      }
    } else if (input === "selectionNext" || input === "selectionPrevious") {
      if (mode.phase === "titles") {
        const items = await menuItems(mode, tabs);
        const index = Math.max(0, items.findIndex(i => i.id === mode.selectedItemId));
        mode.selectedItemId = items[Math.max(0, Math.min(items.length - 1, index + (input === "selectionNext" ? 1 : -1)))]?.id || "";
      }
    } else if (input === "activateSelected" && mode.phase === "titles") {
      const item = (await menuItems(mode, tabs)).find(i => i.id === mode.selectedItemId);
      if (!item || message.expectedItemId !== item.id) error = { code: "STALE_SELECTION" };
      else if (item.disabled) error = { code: "OPERATION_FAILED" };
      else {
        const id = item.id;
        if (recovery && ["focus", "input", "googleSearch", "scroll", "scrollTop", "scrollBottom", "reload", "close", "favoriteCurrent"].includes(id)) error = { code: "NOT_AUTHORIZED" };
        else if (["focus", "input", "googleSearch", "scroll", "scrollTop", "scrollBottom"].includes(id)) {
          pageAction = { action: id, sessionId: mode.sessionId, requestId }; mode.phase = "direct"; disarm();
        } else if (id === "reload") { await chrome.tabs.reload(activeTab.id); mode.phase = "direct"; disarm(); }
        else if (id === "close") {
          const target = mode.closeTarget;
          if (!mode.closeArmed || target?.tabId !== activeTab.id || target?.url !== activeTab.url || target?.sessionId !== mode.sessionId || target?.navigationVersion !== (navigationVersions.get(activeTab.id) || 0)) {
            mode.closeArmed = true; mode.closeTarget = { tabId: activeTab.id, url: activeTab.url, sessionId: mode.sessionId, navigationVersion: navigationVersions.get(activeTab.id) || 0 };
          } else {
            const safe = R.safeWebUrl(activeTab.url);
            const recoveryTarget = !tabs.some(t => t.id !== activeTab.id) ? await prepareRecovery(mode) : null;
            const current = (await windowTabs(mode.windowId)).find(t => t.id === activeTab.id);
            if (!tabs.some(t => t.id !== activeTab.id) && !recoveryTarget) error = { code: "OPERATION_FAILED", message: "恢复页未准备好，已取消关闭" };
            else if (!current || !current.active || current.url !== activeTab.url || target.navigationVersion !== (navigationVersions.get(activeTab.id) || 0)) error = { code: "STALE_SELECTION", message: "标签已变化，已取消关闭" };
            else {
              await chrome.tabs.remove(activeTab.id);
              if (recoveryTarget) await chrome.tabs.update(recoveryTarget.id, { active: true });
              if (safe) {
                const map = await storageMap(CLOSED_KEY);
                map[mode.windowId] = [{ url: safe, title: activeTab.title || "" }, ...(map[mode.windowId] || [])].slice(0, 5);
                await chrome.storage.session.set({ [CLOSED_KEY]: map });
              }
              const next = (await windowTabs(mode.windowId)).find(t => t.active);
              mode.hostTabId = next?.id ?? null; mode.notifyTabId = next?.id ?? null; mode.selectedTabId = next?.id ?? null; mode.phase = "direct";
            }
            disarm();
          }
        } else if (id === "previousRecent") {
          const map = await storageMap(MRU_KEY);
          const target = (map[mode.windowId] || []).map(id => tabs.find(t => t.id === id)).find(t => t && t.id !== activeTab.id);
          if (!target) error = { code: "NO_RECENT", message: "没有最近标签" };
          else { await chrome.tabs.update(target.id, { active: true }); await rememberActive(mode.windowId, target.id); mode.phase = "direct"; }
          disarm();
        } else if (id === "restore") {
          const map = await storageMap(CLOSED_KEY); const entry = (map[mode.windowId] || [])[0];
          if (!entry) error = { code: "NOTHING_TO_RESTORE", message: "没有可恢复的标签" };
          else {
            const safe = R.safeWebUrl(entry.url);
            if (!safe || !controllableUrl(safe, await siteGranted())) error = { code: "NOT_AUTHORIZED", message: "请先授权访问普通网页" };
            else {
              const target = await chrome.tabs.create({ windowId: mode.windowId, url: safe, active: true });
              map[mode.windowId].shift(); await chrome.storage.session.set({ [CLOSED_KEY]: map });
              await rememberActive(mode.windowId, target.id); mode.phase = "direct";
            }
          }
          disarm();
        } else if (id === "youtube" || id.startsWith("favorite:")) {
          const favorite = id.startsWith("favorite:") ? (await getFavorites()).find(f => f.id === id.slice(9)) : null;
          error = await openWeb(mode, id === "youtube" ? "https://www.youtube.com/" : favorite?.url);
          if (!error) mode.phase = "direct";
          disarm();
        } else if (id === "favoriteCurrent") {
          const list = await getFavorites(), url = R.safeWebUrl(activeTab.url);
          if (!url) error = { code: "INVALID_URL" };
          else if (list.some(f => f.url === url)) error = { code: "ALREADY_EXISTS", message: "网页已收藏" };
          else if (list.length >= 8) error = { code: "FAVORITES_FULL", message: "收藏已满，请先移除" };
          else await chrome.storage.local.set({ [R.FAVORITES_KEY]: R.normalizeFavorites([...list, { id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, title: activeTab.title || url, url, icon: R.safeIconUrl(activeTab.favIconUrl) }]) });
          disarm();
        } else if (id.startsWith("removeFavorite:")) {
          if (!mode.closeArmed || mode.closeTarget?.itemId !== id || mode.closeTarget?.sessionId !== mode.sessionId) {
            mode.closeArmed = true; mode.closeTarget = { itemId: id, sessionId: mode.sessionId, tabId: activeTab.id };
          } else {
            const list = (await getFavorites()).filter(f => f.id !== id.slice("removeFavorite:".length));
            await chrome.storage.local.set({ [R.FAVORITES_KEY]: list }); mode.selectedItemId = "youtube"; disarm();
          }
        } else if (id.startsWith("tab:")) {
          const target = tabs.find(t => `tab:${t.id}` === id);
          if (!target) error = { code: "TAB_GONE" };
          else { await chrome.tabs.update(target.id, { active: true }); await rememberActive(mode.windowId, target.id); mode.phase = "direct"; }
          disarm();
        }
      }
    } else if (input === "escape") {
      if (mode.phase === "titles") mode.phase = "direct";
      else return { ok: true, state: await deactivateMode() };
    }
  } catch (_) { error = { code: "OPERATION_FAILED" }; }
  if (requestId) mode.recent = [...mode.recent, requestId].slice(-20);
  mode.revision += 1;
  const latest = (await windowTabs(mode.windowId)).find(t => t.active);
  if (latest) {
    mode.notifyTabId = latest.id;
    if (controllableUrl(latest.url, await siteGranted()) || (recoveryUrl(latest.url) && latest.id === mode.recoveryTabId)) mode.hostTabId = latest.id;
  }
  await writeMode(mode);
  await pushAfter(mode);
  return { ok: !error, error: error || undefined, state: await modeView(mode), ...(pageAction ? { pageAction } : {}) };
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
  if (recoveryUrl(sender.url)) {
    sender = await serialized(() => bindRecoverySender(message, sender));
    if (!sender) return { ok: false, error: { code: "NOT_AUTHORIZED" } };
  }
  if (!extensionSender(sender) && !await eligibleController(sender)) {
    return { ok: false, error: { code: "NOT_AUTHORIZED" }, state: await modeView(normalizeMode(null)) };
  }
  switch (message.type) {
    case "remote:browser-favorites-save": {
      if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL("options.html")) return { ok: false };
      return serialized(async () => {
        const current = await getFavorites();
        if (message.expected !== JSON.stringify(current)) return { ok: false, error: { code: "CONFLICT" } };
        const value = message.favorites;
        if (!Array.isArray(value) || value.length > 8 || value.some(item => !R.safeWebUrl(item?.url) ||
            typeof item?.title !== "string" || !item.title.trim() || item.title.trim().length > 80)) return { ok: false, error: { code: "INVALID_INPUT" } };
        const normalized = R.normalizeFavorites(value);
        if (normalized.length !== value.length) return { ok: false, error: { code: "INVALID_INPUT" } };
        await chrome.storage.local.set({ [R.FAVORITES_KEY]: normalized });
        schedulePush();
        return { ok: true, favorites: normalized };
      });
    }
    case "remote:browser-state":
      return recoveryUrl(sender.url) ? serialized(() => stateReply(sender)) : stateReply(sender);
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
  if (message.type === "remote:recovery-ready") {
    recoveryReady(message, sender).then(respond, () => respond({ ok: false }));
    return true;
  }
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
  void serialized(async () => {
    await rememberActive(windowId, tabId);
    const mode = await readMode();
    // A recovery page from an earlier session is inert: its controller is bound to a token that
    // no longer exists. Close it once the user moves to another tab so it cannot trap the remote.
    if (Number.isFinite(mode.recoveryTabId) && tabId !== mode.recoveryTabId) {
      const tabs = await windowTabs(windowId);
      const grant = await siteGranted();
      const replacement = tabs.some(tab => tab.id !== mode.recoveryTabId && tab.id !== tabId && controllableUrl(tab.url, grant)) ||
        controllableUrl(tabs.find(tab => tab.id === tabId)?.url, grant);
      if (!mode.active || replacement) {
        const stale = mode.recoveryTabId;
        mode.recoveryTabId = null;
        mode.recoveryToken = "";
        if (mode.active) mode.revision += 1;
        await writeMode(mode);
        chrome.tabs.remove(stale).catch(() => {});
      }
    }
    if (mode.active && mode.windowId === windowId && mode.closeArmed && mode.closeTarget?.tabId !== tabId) {
      mode.closeArmed = false;
      mode.closeTarget = null;
      mode.revision += 1;
      await writeMode(mode);
    }
    await notifyActivated(tabId, windowId);
  });
  schedulePush();
});
chrome.tabs.onCreated.addListener(() => schedulePush());
chrome.tabs.onMoved.addListener(() => schedulePush());
chrome.tabs.onAttached.addListener(() => schedulePush());
chrome.tabs.onDetached.addListener(() => schedulePush());
chrome.tabs.onReplaced.addListener(() => schedulePush());
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading" || changeInfo.url !== undefined) navigationVersions.set(tabId, (navigationVersions.get(tabId) || 0) + 1);
  if (changeInfo.title !== undefined || changeInfo.status === "complete") schedulePush();
  // Only a completed navigation has a settled URL. Reacting while a normal page is still loading
  // would race with the previous URL and switch tabs for no reason.
  if (changeInfo.status === "loading" || changeInfo.url !== undefined || changeInfo.status === "complete") {
    void serialized(async () => {
      const mode = await readMode();
      if (mode.active && mode.closeArmed && mode.closeTarget?.tabId === tabId &&
          (changeInfo.status === "loading" || changeInfo.url !== undefined)) {
        mode.closeArmed = false;
        mode.closeTarget = null;
        mode.revision += 1;
        await writeMode(mode);
      }
      if (mode.active && changeInfo.status === "complete") await rehomeStranded(mode);
    });
  }
});
chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  void serialized(async () => {
    const mode = await readMode();
    if (!mode.active || removeInfo?.windowId !== mode.windowId) return;
    const tabs = await windowTabs(mode.windowId);
    if (!tabs.length) { await deactivateMode(); return; }
    let changed = false;
    // An armed close targets the active tab; if the window changed underneath it, it must not
    // carry over and close the replacement on the next confirm.
    if (mode.closeArmed) {
      mode.closeArmed = false;
      if (mode.selectedAction === "close") mode.selectedAction = "";
      changed = true;
    }
    if (mode.hostTabId === tabId) {
      mode.hostTabId = null;
      changed = true;
    }
    if (!tabs.some(tab => tab.id === mode.selectedTabId)) {
      mode.selectedTabId = (tabs.find(tab => tab.active) || tabs[0]).id;
      mode.selectedAction = "";
      changed = true;
    }
    if (changed) {
      mode.revision += 1;
      await writeMode(mode);
    }
    // Closing the last controllable tab can leave a browser page active; keep the remote usable.
    if (await rehomeStranded(mode, { requireHost: false })) return;
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
