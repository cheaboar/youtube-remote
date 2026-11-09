"use strict";
const R = globalThis.YouTubeRemote;
let draft = R.cloneDefaults();
let recording = null;
let diagnosticsUntil = 0;
const $ = (id) => document.getElementById(id);
function feedback(text, error = false) { $("feedback").textContent = text; $("feedback").classList.toggle("error", error); }
function renderBindings() {
  for (const group of ["bindings", "doubles"]) {
    const host = $(group);
    host.replaceChildren();
    const actions = group === "bindings" ? Object.keys(R.ACTIONS) : R.DOUBLE_ACTIONS;
    for (const action of actions) {
      const row = document.createElement("div"); row.className = "binding";
      const title = document.createElement("span"); title.textContent = R.ACTIONS[action];
      const keys = document.createElement("div"); keys.className = "keys";
      const button = document.createElement("button"); button.className = "record";
      button.dataset.action = action; button.dataset.group = group;
      button.textContent = R.label(draft[group][action]);
      button.setAttribute("aria-label", `录制${group === "doubles" ? "双击" : ""}${R.ACTIONS[action]}`);
      button.addEventListener("click", () => {
        recording = { group, action };
        document.querySelectorAll(".recording").forEach((item) => item.classList.remove("recording"));
        button.classList.add("recording"); button.textContent = "请按遥控器键…";
        $("cancel-recording").hidden = false;
        feedback("按一次要绑定的键或组合键。Esc 也可以录制；取消请点击「取消录制」。");
      });
      const clear = document.createElement("button"); clear.className = "clear"; clear.textContent = "清除";
      clear.setAttribute("aria-label", `清除${group === "doubles" ? "双击" : ""}${R.ACTIONS[action]}`);
      clear.addEventListener("click", () => { draft[group][action] = ""; stopRecording(); feedback("已清除，保存后生效。"); });
      keys.append(button, clear); row.append(title, keys); host.append(row);
    }
  }
}
function stopRecording() { recording = null; $("cancel-recording").hidden = true; renderBindings(); }
function render() {
  $("enabled").checked = draft.enabled; $("show-status").checked = draft.showStatus; $("interval").value = draft.doubleInterval;
  renderBindings();
}
window.addEventListener("keydown", (event) => {
  if (!recording) return;
  event.preventDefault(); event.stopImmediatePropagation();
  if (event.repeat || event.isComposing) return;
  const value = R.chord(event); if (!value) return;
  draft[recording.group][recording.action] = value;
  stopRecording();
  const error = R.validate(draft);
  feedback(error || `已录制 ${R.label(value)}，保存后生效。`, !!error);
}, true);
$("cancel-recording").addEventListener("click", () => { stopRecording(); feedback("已取消录制。"); });
$("save").addEventListener("click", async () => {
  draft.enabled = $("enabled").checked; draft.showStatus = $("show-status").checked; draft.doubleInterval = Number($("interval").value);
  const error = R.validate(draft); if (error) return feedback(error, true);
  try { await chrome.storage.local.set({ remoteSettings: draft }); feedback("设置已保存，YouTube 页面立即生效。"); }
  catch (_) { feedback("保存失败，请重新打开设置页面。", true); }
});
$("reset").addEventListener("click", async () => {
  draft = R.cloneDefaults(); recording = null; render();
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
      `${event.key}\n${event.code}`, `${event.repeat ? "重复 " : ""}${event.composing ? "组合输入 " : ""}${R.ACTIONS[event.action] || event.type}`]) {
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
void chrome.storage.local.get(["remoteSettings", "diagnosticsUntil"]).then((saved) => {
  draft = R.normalize(saved.remoteSettings); diagnosticsUntil = saved.diagnosticsUntil || 0; render(); void renderEvents();
});
setInterval(() => { if (diagnosticsUntil && Date.now() > diagnosticsUntil) { diagnosticsUntil = 0; void renderEvents(); } }, 1000);
