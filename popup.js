"use strict";
const R = globalThis.YouTubeRemote;
async function render() {
  const stored = await chrome.storage.local.get("remoteSettings");
  const settings = R.normalize(stored.remoteSettings);
  document.getElementById("enabled").checked = settings.enabled;
  document.getElementById("sequence-help").textContent = settings.bindings.confirm ?
    `双击 ${R.label(settings.bindings.confirm)} 进入复合键。↑↓ 选择，Enter 确认；← / → 开始组合，Esc 退出。` : "请在设置中绑定确认键，以启用复合键模式。";
  const list = document.getElementById("shortcuts"); list.replaceChildren();
  for (const action of ["confirm", "back", "home", "search", "guide", "sidebar", "player", "togglePlayback", "fullscreen", "historyBack"]) {
    const row = document.createElement("div"); row.className = "shortcut";
    const title = document.createElement("dt"); title.textContent = R.ACTIONS[action];
    const value = document.createElement("dd"); const key = document.createElement("kbd"); key.textContent = R.label(settings.bindings[action]); value.append(key);
    row.append(title, value); list.append(row);
  }
  document.getElementById("double-help").textContent = R.DOUBLE_ACTIONS.filter((a) => settings.doubles[a])
    .map((a) => `双击 ${R.label(settings.doubles[a])}：${R.ACTIONS[a]}`).join("；") || "双击操作未绑定";
}
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
