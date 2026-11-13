"use strict";
const R = globalThis.YouTubeRemote;
let entryKey = "";
let doubleItems = { watch: [], shorts: [] };
let youtubeTab = false;
let shortsTab = false;
let homeSite = "youtube";
let playerTab = false;
const HOMES = {
  douyin: "https://www.douyin.com/jingxuan",
  bilibili: "https://www.bilibili.com/",
  youku: "https://www.youku.com/ku/webhome",
  youtube: "https://www.youtube.com/"
};
// The entry gesture depends on the page: YouTube and the playback pages spend the double tap on
// their command panel, so browser mode needs a third tap there.
function paintDoubleHelp() {
  const items = (shortsTab ? doubleItems.shorts : doubleItems.watch).slice();
  if (entryKey) items.push(`${youtubeTab || playerTab ? "三击" : "双击"} ${R.label(entryKey)}：浏览器模式`);
  document.getElementById("double-help").textContent = items.join("；") || "双击操作未绑定";
}
async function render() {
  const stored = await chrome.storage.local.get("remoteSettings");
  const settings = R.normalize(stored.remoteSettings);
  document.getElementById("enabled").checked = settings.enabled;
  document.getElementById("sequence-help").textContent = settings.bindings.confirm ?
    `双击 ${R.label(settings.bindings.confirm)} 打开面板：↑↓ 选择，Enter 确认；YouTube 可用 ← / → 组合，Esc 退出。` :
    "请在设置中绑定确认键，以启用复合键模式。";
  const list = document.getElementById("shortcuts"); list.replaceChildren();
  for (const action of ["confirm", "back", "home", "search", "guide", "toggleGuide", "sidebar", "player", "togglePlayback", "fullscreen", "restorePlayback", "historyBack"]) {
    const row = document.createElement("div"); row.className = "shortcut";
    const title = document.createElement("dt"); title.textContent = R.ACTIONS[action];
    const value = document.createElement("dd"); const key = document.createElement("kbd"); key.textContent = R.label(settings.bindings[action]); value.append(key);
    row.append(title, value); list.append(row);
  }
  const describe = (actions) => actions.filter((a) => settings.doubles[a])
    .map((a) => `双击 ${R.label(settings.doubles[a])}：${R.DOUBLE_LABELS[a] || R.ACTIONS[a]}`);
  doubleItems = { watch: describe(R.DOUBLE_ACTIONS), shorts: describe(R.SHORTS_DOUBLE_ACTIONS) };
  entryKey = settings.bindings.browser || "";
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
    if (nextShorts !== shortsTab || nextPlayer !== playerTab) {
      shortsTab = nextShorts; playerTab = nextPlayer; paintDoubleHelp();
    }
    youtubeTab = next;
    if (nextHome !== homeSite) {
      homeSite = nextHome;
      document.getElementById("home").title = `在当前标签页打开${
        { douyin: "抖音精选", bilibili: "哔哩哔哩首页", youku: "优酷首页", youtube: " YouTube 首页" }[homeSite]}`;
    }
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
