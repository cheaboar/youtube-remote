"use strict";
const R = globalThis.YouTubeRemote;
let entryKey = "";
let doubleItems = [];
let youtubeTab = false;
// The entry gesture depends on the page: YouTube spends the double tap on the command panel.
function paintDoubleHelp() {
  const items = doubleItems.slice();
  if (entryKey) items.push(`${youtubeTab ? "三击" : "双击"} ${R.label(entryKey)}：浏览器模式`);
  document.getElementById("double-help").textContent = items.join("；") || "双击操作未绑定";
}
async function render() {
  const stored = await chrome.storage.local.get("remoteSettings");
  const settings = R.normalize(stored.remoteSettings);
  document.getElementById("enabled").checked = settings.enabled;
  document.getElementById("sequence-help").textContent = settings.bindings.confirm ?
    `双击 ${R.label(settings.bindings.confirm)} 进入复合键。↑↓ 选择，Enter 确认；← / → 开始组合，Esc 退出。` : "请在设置中绑定确认键，以启用复合键模式。";
  const list = document.getElementById("shortcuts"); list.replaceChildren();
  for (const action of ["confirm", "back", "home", "search", "guide", "toggleGuide", "sidebar", "player", "togglePlayback", "fullscreen", "restorePlayback", "historyBack"]) {
    const row = document.createElement("div"); row.className = "shortcut";
    const title = document.createElement("dt"); title.textContent = R.ACTIONS[action];
    const value = document.createElement("dd"); const key = document.createElement("kbd"); key.textContent = R.label(settings.bindings[action]); value.append(key);
    row.append(title, value); list.append(row);
  }
  doubleItems = R.DOUBLE_ACTIONS.filter((a) => settings.doubles[a])
    .map((a) => `双击 ${R.label(settings.doubles[a])}：${R.ACTIONS[a]}`);
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
    const next = /^https:\/\/www\.youtube\.com\//.test(tab?.url || "");
    if (next !== youtubeTab) { youtubeTab = next; paintDoubleHelp(); }
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
    await chrome.tabs.update(tab.id, { url: "https://www.youtube.com/" });
    window.close();
  } catch (_) {
    button.disabled = false;
    button.textContent = "重试首页";
  }
});
chrome.storage.onChanged.addListener((changes, area) => { if (area === "local" && changes.remoteSettings) void render(); });
void render();
