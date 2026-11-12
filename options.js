"use strict";
const R = globalThis.YouTubeRemote;
let draft = R.cloneDefaults();
let recording = null;
let diagnosticsUntil = 0;
const $ = (id) => document.getElementById(id);
function feedback(text, error = false) { $("feedback").textContent = text; $("feedback").classList.toggle("error", error); }
function renderBindings() {
  for (const group of ["bindings", "doubles", "sequences"]) {
    const host = $(group);
    host.replaceChildren();
    const actions = group === "bindings" ? Object.keys(R.ACTIONS)
      : group === "doubles" ? [...R.DOUBLE_ACTIONS, ...R.SHORTS_DOUBLE_ACTIONS]
      : Object.keys(R.SEQUENCE_ACTIONS);
    for (const action of actions) {
      if (group === "doubles" && action === R.SHORTS_DOUBLE_ACTIONS[0]) {
        const heading = document.createElement("h4"); heading.className = "binding-group";
        heading.textContent = "Shorts 页面"; host.append(heading);
      }
      if (group === "sequences") {
        const category = R.SEQUENCE_GROUPS.find(item => Object.keys(item.actions)[0] === action);
        if (category) {
          const heading = document.createElement("h4"); heading.className = "binding-group";
          heading.textContent = category.title; host.append(heading);
        }
      }
      const row = document.createElement("div"); row.className = "binding";
      const name = group === "sequences" ? R.SEQUENCE_ACTIONS[action] : R.DOUBLE_LABELS[action] || R.ACTIONS[action];
      const title = document.createElement("span"); title.textContent = name;
      const keys = document.createElement("div"); keys.className = "keys";
      const button = document.createElement("button"); button.className = "record";
      button.dataset.action = action; button.dataset.group = group;
      button.textContent = group === "sequences" ? draft.sequences[action].map(R.label).join("  ") || "菜单选择" : R.label(draft[group][action]);
      button.setAttribute("aria-label", `录制${group === "doubles" ? "双击" : group === "sequences" ? "复合键" : ""}${name}`);
      button.addEventListener("click", () => {
        stopRecording();
        recording = { group, action, keys: [] };
        document.querySelectorAll(".recording").forEach((item) => item.classList.remove("recording"));
        const active = document.querySelector(`[data-group="${group}"][data-action="${action}"]`);
        active.classList.add("recording"); active.textContent = "请按遥控器键…";
        $("cancel-recording").hidden = false;
        $("finish-sequence").hidden = group !== "sequences";
        $("undo-sequence").hidden = group !== "sequences";
        $("finish-sequence").disabled = true;
        feedback(group === "sequences" ? "先按 ← 或 →，再依次输入共 2–4 个键；Backspace 撤销，Esc 取消。" :
          "按一次要绑定的键或组合键。Esc 也可以录制；取消请点击「取消录制」。");
      });
      const clear = document.createElement("button"); clear.className = "clear"; clear.textContent = "清除";
      clear.setAttribute("aria-label", `清除${group === "doubles" ? "双击" : group === "sequences" ? "复合键" : ""}${name}`);
      clear.addEventListener("click", () => { draft[group][action] = group === "sequences" ? [] : ""; stopRecording(); feedback(group === "sequences" ? "已清除组合，仍可从面板选择执行；保存后生效。" : "已清除，保存后生效。"); });
      keys.append(button, clear); row.append(title, keys); host.append(row);
    }
  }
  $("sequence-entry").textContent = draft.bindings.confirm ? `双击 ${R.label(draft.bindings.confirm)} 进入复合键模式；入口跟随确认键。` : "请先绑定确认键，才能双击进入复合键模式。";
}
function stopRecording() {
  recording = null;
  for (const id of ["cancel-recording", "finish-sequence", "undo-sequence"]) $(id).hidden = true;
  renderBindings();
}
function showSequenceRecording() {
  const button = document.querySelector('.recording');
  button.textContent = recording.keys.map(R.label).join("  ") || "请按遥控器键…";
  $("finish-sequence").disabled = recording.keys.length < 2;
}
function finishSequence() {
  if (recording?.group !== "sequences" || recording.keys.length < 2) return;
  draft.sequences[recording.action] = recording.keys.slice();
  stopRecording();
  const error = R.validate(draft);
  feedback(error || "复合键已录制，保存后生效。", !!error);
}
function render() {
  $("enabled").checked = draft.enabled; $("show-status").checked = draft.showStatus; $("interval").value = draft.doubleInterval;
  renderBindings();
}
window.addEventListener("keydown", (event) => {
  if (!recording) return;
  event.preventDefault(); event.stopImmediatePropagation();
  if (event.repeat || event.isComposing) return;
  if (recording.group === "sequences" && event.key === "Escape") { stopRecording(); feedback("已取消录制。"); return; }
  if (recording.group === "sequences" && event.key === "Backspace") { recording.keys.pop(); showSequenceRecording(); return; }
  const value = R.chord(event); if (!value) return;
  if (recording.group === "sequences") {
    if (value === draft.bindings.back) return feedback("返回键用于退出复合键模式，请使用其他键。", true);
    if (value === "Enter" || value === draft.bindings.confirm) return feedback("Enter 和确认键用于执行选中指令，请使用其他键。", true);
    if (!recording.keys.length && !["ArrowLeft", "ArrowRight"].includes(value)) return feedback("复合键请以 ← 或 → 开头；↑↓ 用于在面板中选择指令。", true);
    recording.keys.push(value); showSequenceRecording();
    feedback("继续输入组合，完成后点击「完成序列」；Backspace 撤销，Esc 取消。");
    if (recording.keys.length === 4) finishSequence();
    return;
  }
  draft[recording.group][recording.action] = value;
  stopRecording();
  const error = R.validate(draft);
  feedback(error || `已录制 ${R.label(value)}，保存后生效。`, !!error);
}, true);
$("cancel-recording").addEventListener("click", () => { stopRecording(); feedback("已取消录制。"); });
$("finish-sequence").addEventListener("click", finishSequence);
$("undo-sequence").addEventListener("click", () => {
  if (recording?.group === "sequences") { recording.keys.pop(); showSequenceRecording(); }
});
$("save").addEventListener("click", async () => {
  if (recording) return feedback("请先完成或取消录制，再保存设置。", true);
  draft.enabled = $("enabled").checked; draft.showStatus = $("show-status").checked; draft.doubleInterval = Number($("interval").value);
  const error = R.validate(draft); if (error) return feedback(error, true);
  try { await chrome.storage.local.set({ remoteSettings: draft }); feedback("设置已保存，YouTube 页面立即生效。"); }
  catch (_) { feedback("保存失败，请重新打开设置页面。", true); }
});
$("reset").addEventListener("click", async () => {
  draft = R.cloneDefaults(); stopRecording(); render();
  await chrome.storage.local.set({ remoteSettings: draft }); feedback("已恢复默认映射。");
});
$("diagnostics").addEventListener("click", async () => {
  diagnosticsUntil = diagnosticsUntil > Date.now() ? 0 : Date.now() + 5 * 60 * 1000;
  await chrome.storage.local.set({ diagnosticsUntil }); await renderEvents();
});
async function renderEvents() {
  const all = await chrome.storage.session.get(null);
  const events = Object.entries(all).filter(([key]) => key.startsWith("remote:tab:"))
    .flatMap(([key, value]) => (value.events || []).map((event) => ({ ...event, tab: key.split(":").at(-1) })))
    .sort((a, b) => b.time - a.time).slice(0, 40);
  const active = diagnosticsUntil > Date.now();
  $("diagnostics").textContent = active ? "停止诊断" : "开始诊断 5 分钟";
  $("diagnostic-state").textContent = active ? "诊断进行中，请切回 YouTube 操作遥控器。" : "诊断未开启。旧记录会在对应标签页关闭后删除。";
  const rows = events.map((event) => {
    const row = document.createElement("tr");
    for (const text of [new Date(event.time).toLocaleTimeString() + ` / ${event.tab}`, event.region,
      `${event.key}\n${event.code}`, `${event.repeat ? "重复 " : ""}${event.composing ? "组合输入 " : ""}${R.ACTIONS[event.action] || R.DOUBLE_LABELS[event.action] || R.SEQUENCE_ACTIONS[event.action] || (event.action === "sequence" ? "复合键输入" : event.type)}`]) {
      const cell = document.createElement("td"); cell.textContent = text; row.append(cell);
    }
    return row;
  });
  if (!rows.length) { const row = document.createElement("tr"); const cell = document.createElement("td"); cell.colSpan = 4; cell.textContent = "还没有收到按键。"; row.append(cell); rows.push(row); }
  $("events").replaceChildren(...rows);
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.diagnosticsUntil) diagnosticsUntil = Number(changes.diagnosticsUntil.newValue) || 0;
  if (area === "session" || changes.diagnosticsUntil) void renderEvents();
});
let favoriteDraft = [], favoriteSnapshot = "", favoriteDirty = false, favoriteConflict = false, favoriteReady = false;
const favoriteVersion = (value) => JSON.stringify(value ?? null);
function favoriteFeedback(text, error = false) {
  $("favorite-feedback").textContent = text; $("favorite-feedback").classList.toggle("error", error);
}
function favoritePreview(item) {
  const icon = R.buildIcon(document, R.faviconUrl(item), item.title || item.url);
  icon.style.alignSelf = "center"; icon.style.marginTop = "18px";
  return icon;
}
function renderFavorites() {
  const host = $("favorites"); host.replaceChildren();
  if (!favoriteDraft.length) { const empty = document.createElement("p"); empty.className = "hint"; empty.textContent = "还没有常用网站。"; host.append(empty); }
  favoriteDraft.forEach((item, index) => {
    const row = document.createElement("div"); row.className = "favorite-row";
    for (const [field, label, maxLength] of [["title", "名称", 80], ["url", "网址", 4096]]) {
      const wrapper = document.createElement("label"); wrapper.textContent = `${label} ${index + 1}`;
      const input = document.createElement("input"); input.type = field === "url" ? "url" : "text";
      input.maxLength = maxLength; input.value = item[field];
      input.addEventListener("input", () => {
        item[field] = input.value; favoriteDirty = true;
        if (field === "url") { delete item.icon; const next = favoritePreview(item); preview.replaceWith(next); preview = next; }
        else if (preview.firstChild?.nodeType === Node.TEXT_NODE) preview.firstChild.nodeValue = R.iconLetter(item.title);
      });
      wrapper.append(input); row.append(wrapper);
    }
    let preview = favoritePreview(item);
    row.prepend(preview);
    const actions = document.createElement("div"); actions.className = "favorite-actions";
    for (const [label, direction] of [["上移", -1], ["下移", 1], ["删除", 0]]) {
      const button = document.createElement("button"); button.textContent = label;
      button.setAttribute("aria-label", `${label}网站 ${index + 1}`);
      button.disabled = direction < 0 ? index === 0 : direction > 0 ? index === favoriteDraft.length - 1 : false;
      button.addEventListener("click", () => {
        if (!direction) favoriteDraft.splice(index, 1);
        else [favoriteDraft[index], favoriteDraft[index + direction]] = [favoriteDraft[index + direction], favoriteDraft[index]];
        favoriteDirty = true; renderFavorites();
      });
      actions.append(button);
    }
    row.append(actions); host.append(row);
  });
  $("favorite-add").disabled = !favoriteReady || favoriteDraft.length >= 8;
  $("favorite-save").disabled = !favoriteReady;
}
async function loadFavorites() {
  try {
    const saved = await chrome.storage.local.get(R.FAVORITES_KEY);
    favoriteSnapshot = favoriteVersion(saved[R.FAVORITES_KEY]);
    favoriteDraft = R.normalizeFavorites(saved[R.FAVORITES_KEY]);
    favoriteDirty = false; favoriteConflict = false; favoriteReady = true;
    renderFavorites(); favoriteFeedback("已加载常用网站。");
  } catch (_) { favoriteFeedback("加载失败，请重新打开设置页。", true); }
}
$("favorite-add").addEventListener("click", () => {
  if (favoriteDraft.length >= 8) return;
  favoriteDraft.push({ id: `site-${crypto.randomUUID()}`, title: "", url: "" }); favoriteDirty = true; renderFavorites();
});
$("favorite-reload").addEventListener("click", () => {
  if (favoriteDirty && !confirm("重新加载会丢弃尚未保存的常用网站修改，继续吗？")) return;
  void loadFavorites();
});
$("favorite-save").addEventListener("click", async () => {
  const urls = new Set();
  for (const item of favoriteDraft) {
    const url = R.safeWebUrl(item.url);
    if (!url || url.length > 4096) return favoriteFeedback("请输入有效的 HTTP(S) 网址，且不能包含用户名或密码（最多 4096 字符）。", true);
    if (!item.title.trim() || item.title.trim().length > 80) return favoriteFeedback("请填写网站名称（最多 80 字符）。", true);
    if (urls.has(url)) return favoriteFeedback("网址重复，请先删除或修改重复的网站。", true);
    urls.add(url);
  }
  try {
    const normalized = R.normalizeFavorites(favoriteDraft);
    const expected = JSON.stringify(R.normalizeFavorites(favoriteSnapshot === "null" ? [] : JSON.parse(favoriteSnapshot)));
    const result = await chrome.runtime.sendMessage({ type: "remote:browser-favorites-save",
      expected, favorites: normalized });
    if (!result?.ok) {
      if (result?.error?.code === "CONFLICT") {
        favoriteConflict = true;
        return favoriteFeedback("常用网站已在其他位置更改。请先重新加载，再重新编辑，避免覆盖。", true);
      }
      return favoriteFeedback("收藏格式无效或保存失败，请检查后重试。", true);
    }
    favoriteSnapshot = JSON.stringify(result.favorites); favoriteDraft = result.favorites;
    favoriteDirty = false; favoriteConflict = false;
    renderFavorites(); favoriteFeedback("常用网站已保存。");
  } catch (_) { favoriteFeedback("保存失败，请重试。", true); }
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes[R.FAVORITES_KEY] || !favoriteReady) return;
  const value = changes[R.FAVORITES_KEY].newValue;
  if (favoriteVersion(value) === favoriteSnapshot) return;
  if (favoriteDirty) { favoriteConflict = true; favoriteFeedback("常用网站已在其他位置更改。请先重新加载，再重新编辑，避免覆盖。", true); }
  else { favoriteSnapshot = favoriteVersion(value); favoriteDraft = R.normalizeFavorites(value); renderFavorites(); favoriteFeedback("常用网站已更新。"); }
});
renderFavorites(); void loadFavorites();

const SITE_ORIGINS = ["http://*/*", "https://*/*"];
async function browserModeState() {
  try { return (await chrome.runtime.sendMessage({ type: "remote:browser-state" }))?.state || null; }
  catch (_) { return null; }
}
async function renderGlobal() {
  let granted = false;
  try { granted = await chrome.permissions.contains({ origins: SITE_ORIGINS }); }
  catch (_) { granted = false; }
  $("site-grant").disabled = granted;
  $("site-revoke").disabled = !granted;
  $("site-state").textContent = granted ? "已授权网站访问" : "仅在 YouTube 内可用";
  $("browser-exit").hidden = !(await browserModeState())?.active;
}
$("site-grant").addEventListener("click", () => {
  // The permission prompt must be requested from inside the click gesture.
  chrome.permissions.request({ origins: SITE_ORIGINS }).then(async (granted) => {
    if (granted) await chrome.runtime.sendMessage({ type: "remote:browser-permission-sync" }).catch(() => null);
    $("global-feedback").textContent = granted ? "已授权：普通网页中也可以双击入口键进入浏览器模式。" :
      "未授权：浏览器模式仍可在 YouTube 内使用。";
    await renderGlobal();
  }).catch(() => { $("global-feedback").textContent = "授权没有完成，请重试。"; });
});
$("site-revoke").addEventListener("click", async () => {
  try { await chrome.permissions.remove({ origins: SITE_ORIGINS }); }
  catch (_) { /* Already removed. */ }
  $("global-feedback").textContent = "已撤销：浏览器模式只在 YouTube 内可用。";
  await renderGlobal();
});
$("browser-exit").addEventListener("click", async () => {
  try { await chrome.runtime.sendMessage({ type: "remote:browser-exit" }); }
  catch (_) { /* No active worker. */ }
  await renderGlobal();
});
chrome.permissions.onAdded.addListener(() => void renderGlobal());
chrome.permissions.onRemoved.addListener(() => void renderGlobal());
// Trusted extension pages receive session-storage events, so the exit button tracks the live mode.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && changes["remote:browser-mode"]) void renderGlobal();
});
void renderGlobal();

void chrome.storage.local.get(["remoteSettings", "diagnosticsUntil"]).then((saved) => {
  draft = R.normalize(saved.remoteSettings); diagnosticsUntil = saved.diagnosticsUntil || 0; render(); void renderEvents();
});
setInterval(() => { if (diagnosticsUntil && Date.now() > diagnosticsUntil) { diagnosticsUntil = 0; void renderEvents(); } }, 1000);
