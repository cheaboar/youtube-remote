"use strict";
const R = globalThis.YouTubeRemote;
let doubleItems = { watch: [], shorts: [] };
let youtubeTab = false;
let shortsTab = false;
let homeSite = "youtube";
let playerTab = false;
let currentSettings = null;
let entryTapNode = null;
const HOMES = {
  douyin: "https://www.douyin.com/jingxuan",
  bilibili: "https://www.bilibili.com/",
  youku: "https://www.youku.com/ku/webhome",
  youtube: "https://www.youtube.com/"
};
// Settings store the key codes a remote emits. A remote user never sees those names, so the popup
// speaks in directions, confirm and back; any other recorded button keeps its recorded label.
const REMOTE_BUTTONS = {
  ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→",
  Enter: "确认键", NumpadEnter: "确认键", Return: "确认键",
  Escape: "返回键", Backspace: "返回键"
};
const remoteLabel = value => value ? REMOTE_BUTTONS[value] || R.label(value) : "未绑定";
// The entry gesture depends on the page: YouTube and the playback pages spend the double tap on
// their command panel, so browser mode needs a third tap there.
function paintDoubleHelp() {
  if (entryTapNode) entryTapNode.textContent = youtubeTab || playerTab ? "三击" : "双击";
  const items = (shortsTab ? doubleItems.shorts : doubleItems.watch).slice();
  const help = document.getElementById("double-help");
  help.textContent = items.join("；");
  help.hidden = !items.length;
}
const sequenceStep = step => R.label(step);
// The remote's fastest route to anything that has no dedicated button is the command panel, so the
// popup lists the current site's own direction sequences instead of keyboard-only fallbacks.
function sequenceSamples(settings) {
  let map = settings.sequences, catalog = R.SEQUENCE_ACTIONS;
  let picks = ["search", "home", "sidebar", "reload", "closeTab"];
  if (homeSite === "douyin") {
    map = settings.douyinSequences; catalog = R.DOUYIN_SEQUENCE_ACTIONS;
    picks = ["togglePlayback", "seekBackward", "mute", "comments", "like"];
  } else if (homeSite === "bilibili" || homeSite === "youku") {
    map = homeSite === "bilibili" ? settings.bilibiliSequences : settings.youkuSequences;
    catalog = R.VIDEO_SEQUENCE_ACTIONS;
    picks = ["togglePlayback", "seekBackward", "mute", "fav", "comments"];
  }
  return picks.filter(action => Array.isArray(map?.[action]) && map[action].length)
    .map(action => `${map[action].map(sequenceStep).join(" ")} ${catalog[action] || R.ACTIONS[action] || action}`);
}
function paintSequences() {
  if (!currentSettings) return;
  const confirm = currentSettings.bindings.confirm;
  const note = document.getElementById("sequence-help");
  if (!confirm) {
    note.textContent = "请在设置中绑定确认键，以启用指令面板。";
    return;
  }
  const exit = currentSettings.bindings.back ? `${remoteLabel(currentSettings.bindings.back)} 退出` : "返回键退出";
  const samples = sequenceSamples(currentSettings);
  note.textContent = `选片页和播放页双击 ${remoteLabel(confirm)} 打开指令面板：方向键选择，` +
    `${remoteLabel(confirm)} 执行，${exit}。` +
    (samples.length ? `面板内常用组合：${samples.join(" · ")}。` : "");
}
async function render() {
  const stored = await chrome.storage.local.get("remoteSettings");
  const settings = R.normalize(stored.remoteSettings);
  currentSettings = settings;
  document.getElementById("enabled").checked = settings.enabled;
  const list = document.getElementById("shortcuts"); list.replaceChildren();
  entryTapNode = null;
  const row = (title, parts) => {
    const wrap = document.createElement("div"); wrap.className = "shortcut";
    const name = document.createElement("dt"); name.textContent = title;
    const value = document.createElement("dd"); value.className = "key-combo";
    for (const part of parts) {
      if (!part) continue;
      if (part instanceof Node) { value.append(part); continue; }
      const node = document.createElement(part.button ? "kbd" : "span");
      if (!part.button) node.className = "times";
      node.textContent = part.text;
      value.append(node);
    }
    wrap.append(name, value); list.append(wrap);
  };
  const button = value => value ? { text: remoteLabel(value), button: true } : null;
  const directions = ["up", "down", "left", "right"].map(name => settings.bindings[name]).filter(Boolean);
  if (directions.length) row("选片 / 移动", directions.map(value => ({ text: remoteLabel(value), button: true })));
  if (settings.bindings.confirm) {
    row("打开 / 播放", [button(settings.bindings.confirm)]);
    row("指令面板", [{ text: "双击" }, button(settings.bindings.confirm)]);
  }
  if (settings.bindings.browser) {
    entryTapNode = document.createElement("span");
    entryTapNode.className = "times";
    entryTapNode.textContent = "双击";
    row("浏览器模式", [entryTapNode, button(settings.bindings.browser)]);
  }
  if (settings.bindings.back) row("逐层返回", [button(settings.bindings.back)]);
  const describe = (actions) => actions.filter((a) => settings.doubles[a])
    .map((a) => `双击 ${remoteLabel(settings.doubles[a])}：${R.DOUBLE_LABELS[a] || R.ACTIONS[a]}`);
  doubleItems = { watch: describe(R.DOUBLE_ACTIONS), shorts: describe(R.SHORTS_DOUBLE_ACTIONS) };
  paintSequences();
  paintDoubleHelp();
  void renderGlobal();
}
const SITE_ORIGINS = ["http://*/*", "https://*/*"];
async function renderGlobal() {
  const button = document.getElementById("global");
  let granted = false;
  try { granted = await chrome.permissions.contains({ origins: SITE_ORIGINS }); }
  catch (_) { granted = false; }
  let active = false;
  try { active = !!(await chrome.runtime.sendMessage({ type: "remote:browser-state" }))?.state?.active; }
  catch (_) { active = false; }
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = tab?.url || "";
    const next = /^https:\/\/www\.youtube\.com\//.test(url);
    const nextShorts = /^https:\/\/www\.youtube\.com\/shorts\//.test(url);
    const nextHome = /^https:\/\/www\.bilibili\.com\//.test(url) ? "bilibili"
      : /^https:\/\/(www|v)\.youku\.com\//.test(url) ? "youku"
      : /^https:\/\/www\.douyin\.com\//.test(url) ? "douyin" : "youtube";
    const nextPlayer = /^https:\/\/www\.douyin\.com\/(video|note)\//.test(url) ||
      /^https:\/\/www\.bilibili\.com\/video\//.test(url) ||
      /^https:\/\/v\.youku\.com\//.test(url) || /^https:\/\/www\.youku\.com\/v_show\//.test(url);
    youtubeTab = next;
    shortsTab = nextShorts;
    playerTab = nextPlayer;
    homeSite = nextHome;
    document.getElementById("home").title = `在当前标签页打开${
      { douyin: "抖音精选", bilibili: "哔哩哔哩首页", youku: "优酷首页", youtube: " YouTube 首页" }[homeSite]}`;
    // The tap count and the sequence catalog depend on the current tab.
    paintDoubleHelp();
    paintSequences();
  } catch (_) { /* Keep the generic double-tap wording. */ }
  button.dataset.active = String(active);
  button.dataset.granted = String(granted);
  button.textContent = active ? "退出浏览器模式" : granted ? "浏览器全局遥控已启用 · 查看设置" : "启用浏览器全局遥控";
}
document.getElementById("global").addEventListener("click", (event) => {
  const button = event.currentTarget;
  if (button.dataset.active === "true") {
    chrome.runtime.sendMessage({ type: "remote:browser-exit" }).catch(() => null).then(() => renderGlobal());
    return;
  }
  if (button.dataset.granted === "true") { chrome.runtime.openOptionsPage(); return; }
  // The permission prompt must be requested from inside the click gesture.
  chrome.permissions.request({ origins: SITE_ORIGINS }).then((granted) => {
    if (!granted) return renderGlobal();
    return chrome.runtime.sendMessage({ type: "remote:browser-permission-sync" }).catch(() => null).then(() => renderGlobal());
  }).catch(() => renderGlobal());
});
document.getElementById("enabled").addEventListener("change", async (event) => {
  const stored = await chrome.storage.local.get("remoteSettings"); const settings = R.normalize(stored.remoteSettings);
  settings.enabled = event.target.checked; await chrome.storage.local.set({ remoteSettings: settings });
});
document.getElementById("settings").addEventListener("click", () => chrome.runtime.openOptionsPage());
document.getElementById("home").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("No active tab");
    await chrome.tabs.update(tab.id, { url: HOMES[homeSite] || HOMES.youtube });
    window.close();
  } catch (_) {
    button.disabled = false;
    button.textContent = "重试首页";
  }
});
chrome.storage.onChanged.addListener((changes, area) => { if (area === "local" && changes.remoteSettings) void render(); });
void render();
