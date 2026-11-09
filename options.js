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
    const actions = group === "bindings" ? Object.keys(R.ACTIONS) : group === "doubles" ? R.DOUBLE_ACTIONS : Object.keys(R.SEQUENCE_ACTIONS);
    for (const action of actions) {
      if (group === "sequences") {
        const category = R.SEQUENCE_GROUPS.find(item => Object.keys(item.actions)[0] === action);
        if (category) {
          const heading = document.createElement("h4"); heading.className = "binding-group";
          heading.textContent = category.title; host.append(heading);
        }
      }
      const row = document.createElement("div"); row.className = "binding";
      const name = group === "sequences" ? R.SEQUENCE_ACTIONS[action] : R.ACTIONS[action];
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
      `${event.key}\n${event.code}`, `${event.repeat ? "重复 " : ""}${event.composing ? "组合输入 " : ""}${R.ACTIONS[event.action] || R.SEQUENCE_ACTIONS[event.action] || (event.action === "sequence" ? "复合键输入" : event.type)}`]) {
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
