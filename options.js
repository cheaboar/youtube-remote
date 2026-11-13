"use strict";
const R = globalThis.YouTubeRemote;
let draft = R.cloneDefaults();
let recording = null;
let diagnosticsUntil = 0;
const $ = (id) => document.getElementById(id);
function feedback(text, error = false) { $("feedback").textContent = text; $("feedback").classList.toggle("error", error); }
const SEQUENCE_GROUPS = ["sequences", "douyinSequences", "bilibiliSequences", "youkuSequences"];
const sequenceNames = { douyinSequences: "抖音", bilibiliSequences: "B站", youkuSequences: "优酷" };
const VIDEO_SEQUENCE_GROUPS = ["bilibiliSequences", "youkuSequences"];
const isSequenceGroup = (group) => SEQUENCE_GROUPS.includes(group);
const sequenceCatalog = (group) => group === "douyinSequences" ? R.DOUYIN_SEQUENCE_ACTIONS
  : VIDEO_SEQUENCE_GROUPS.includes(group) ? R.VIDEO_SEQUENCE_ACTIONS : R.SEQUENCE_ACTIONS;
const sequenceGroupList = (group) => group === "douyinSequences" ? R.DOUYIN_SEQUENCE_GROUPS
  : VIDEO_SEQUENCE_GROUPS.includes(group) ? R.VIDEO_SEQUENCE_GROUPS : R.SEQUENCE_GROUPS;
function renderBindings() {
  for (const group of ["bindings", "doubles", ...SEQUENCE_GROUPS]) {
    const host = $(group);
    host.replaceChildren();
    const actions = group === "bindings" ? Object.keys(R.ACTIONS)
      : group === "doubles" ? [...R.DOUBLE_ACTIONS, ...R.SHORTS_DOUBLE_ACTIONS]
      : Object.keys(sequenceCatalog(group));
    for (const action of actions) {
      if (group === "doubles" && action === R.SHORTS_DOUBLE_ACTIONS[0]) {
        const heading = document.createElement("h4"); heading.className = "binding-group";
        heading.textContent = "Shorts 页面"; host.append(heading);
      }
      if (isSequenceGroup(group)) {
        const category = sequenceGroupList(group).find(item => Object.keys(item.actions)[0] === action);
        if (category) {
          const heading = document.createElement("h4"); heading.className = "binding-group";
          heading.textContent = category.title; host.append(heading);
        }
      }
      const row = document.createElement("div"); row.className = "binding";
      const name = isSequenceGroup(group) ? sequenceCatalog(group)[action] : R.DOUBLE_LABELS[action] || R.ACTIONS[action];
      const title = document.createElement("span"); title.textContent = name;
      const keys = document.createElement("div"); keys.className = "keys";
      const button = document.createElement("button"); button.className = "record";
      button.dataset.action = action; button.dataset.group = group;
      button.textContent = isSequenceGroup(group) ? draft[group][action].map(R.label).join("  ") || "菜单选择" : R.label(draft[group][action]);
      button.setAttribute("aria-label", `录制${group === "doubles" ? "双击" : isSequenceGroup(group) ? "复合键" : ""}${name}`);
      button.addEventListener("click", () => {
        stopRecording();
        recording = { group, action, keys: [] };
        document.querySelectorAll(".recording").forEach((item) => item.classList.remove("recording"));
        const active = document.querySelector(`[data-group="${group}"][data-action="${action}"]`);
        active.classList.add("recording"); active.textContent = "请按遥控器键…";
        $("cancel-recording").hidden = false;
        $("finish-sequence").hidden = !isSequenceGroup(group);
        $("undo-sequence").hidden = !isSequenceGroup(group);
        $("finish-sequence").disabled = true;
        feedback(isSequenceGroup(group) ? "先按 ← 或 →，再依次输入共 2–4 个键；Backspace 撤销，Esc 取消。" :
          "按一次要绑定的键或组合键。Esc 也可以录制；取消请点击「取消录制」。");
      });
      const clear = document.createElement("button"); clear.className = "clear"; clear.textContent = "清除";
      clear.setAttribute("aria-label", `清除${group === "doubles" ? "双击" : isSequenceGroup(group) ? "复合键" : ""}${name}`);
      clear.addEventListener("click", () => {
        draft[group][action] = isSequenceGroup(group) ? [] : "";
        stopRecording();
        feedback(isSequenceGroup(group) ? "已清除组合，仍可从面板选择执行；保存后生效。" : "已清除，保存后生效。");
      });
      keys.append(button, clear); row.append(title, keys); host.append(row);
    }
  }
  $("sequence-entry").textContent = draft.bindings.confirm ? `双击 ${R.label(draft.bindings.confirm)} 进入复合键模式；入口跟随确认键。` : "请先绑定确认键，才能双击进入复合键模式。";
}
function stopRecording() {
  const wasSystem = recording?.group === "system";
  recording = null;
  for (const id of ["cancel-recording", "finish-sequence", "undo-sequence"]) $(id).hidden = true;
  renderBindings();
  if (wasSystem) renderSystem();
}
function showSequenceRecording() {
  const button = document.querySelector('.recording');
  button.textContent = recording.keys.map(R.label).join("  ") || "请按遥控器键…";
  $("finish-sequence").disabled = recording.keys.length < 2;
}
function finishSequence() {
  if (!isSequenceGroup(recording?.group) || recording.keys.length < 2) return;
  draft[recording.group][recording.action] = recording.keys.slice();
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
  if (isSequenceGroup(recording.group) && event.key === "Escape") { stopRecording(); feedback("已取消录制。"); return; }
  if (isSequenceGroup(recording.group) && event.key === "Backspace") { recording.keys.pop(); showSequenceRecording(); return; }
  const value = R.chord(event); if (!value) return;
  if (recording.group === "system") {
    const { profileIndex, bindingIndex, field } = recording;
    const row = systemDraft.profiles[profileIndex]?.bindings[bindingIndex];
    if (!row) { stopRecording(); return; }
    if (field === "source") {
      if (!R.validSystemSource(value)) {
        return systemFeedback(`「${R.label(value)}」不能作为遥控按键：只支持单个按键，且不能带 Ctrl / Alt / Shift。`, true);
      }
      row.source = R.normalizeSystemChord(value);
    } else {
      if (!R.validSystemTarget(value)) return systemFeedback(`「${R.label(value)}」不是受支持的目标快捷键。`, true);
      row.target = R.normalizeSystemChord(value);
    }
    systemDirty = true;
    stopRecording();
    systemFeedback(`已录制 ${field === "source" ? "遥控按键" : "目标快捷键"}「${R.systemLabel(value)}」，保存后请重新下载配置。`);
    return;
  }
  if (isSequenceGroup(recording.group)) {
    if (value === draft.bindings.back) return feedback("返回键用于退出复合键模式，请使用其他键。", true);
    if (value === "Enter" || value === draft.bindings.confirm) return feedback("Enter 和确认键用于执行选中指令，请使用其他键。", true);
    const starts = recording.group === "sequences"
      ? ["ArrowLeft", "ArrowRight"]
      : [draft.bindings.left, draft.bindings.right, "ArrowLeft", "ArrowRight"].filter(Boolean);
    if (!recording.keys.length && !starts.includes(value)) {
      return feedback(recording.group === "sequences"
        ? "复合键请以 ← 或 → 开头；↑↓ 用于在面板中选择指令。"
        : `${sequenceNames[recording.group]}组合键请以 ← 或 → 开头；播放页面板中用 ← / → 开始筛选。`, true);
    }
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
  if (recording && isSequenceGroup(recording.group)) { recording.keys.pop(); showSequenceRecording(); }
});
$("save").addEventListener("click", async () => {
  if (recording) return feedback("请先完成或取消录制，再保存设置。", true);
  draft.enabled = $("enabled").checked; draft.showStatus = $("show-status").checked; draft.doubleInterval = Number($("interval").value);
  const error = R.validate(draft); if (error) return feedback(error, true);
  try { await chrome.storage.local.set({ remoteSettings: draft }); feedback("设置已保存，YouTube、抖音、B站和优酷页面立即生效。"); }
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
  $("diagnostic-state").textContent = active ? "诊断进行中，请切回 YouTube、抖音、B站或优酷操作遥控器。" : "诊断未开启。旧记录会在对应标签页关闭后删除。";
  const rows = events.map((event) => {
    const row = document.createElement("tr");
    for (const text of [new Date(event.time).toLocaleTimeString() + ` / ${event.tab}`, event.region,
      `${event.key}\n${event.code}`, `${event.repeat ? "重复 " : ""}${event.composing ? "组合输入 " : ""}${R.ACTIONS[event.action] || R.DOUBLE_LABELS[event.action] || R.SEQUENCE_ACTIONS[event.action] || R.DOUYIN_SEQUENCE_ACTIONS[event.action] || R.VIDEO_SEQUENCE_ACTIONS[event.action] || (event.action === "sequence" ? "复合键输入" : event.type)}`]) {
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

let systemDraft = { enabled: true, profiles: [] };
let systemSnapshot = "", systemDirty = false, systemConflict = false, systemReady = false, systemSaving = false;
const systemVersion = (value) => JSON.stringify(value ?? null);
function systemFeedback(text, error = false) {
  $("system-feedback").textContent = text; $("system-feedback").classList.toggle("error", error);
}
function newSystemBinding() {
  return { id: `keys-${crypto.randomUUID()}`, source: "", target: "" };
}
function newSystemProfile() {
  return { id: `profile-${crypto.randomUUID()}`, name: "", process: "", title: "", enabled: true, bindings: [newSystemBinding()] };
}
function renderSystem() {
  $("system-enabled").checked = systemDraft.enabled;
  const host = $("system-profiles"); host.replaceChildren();
  const active = recording?.group === "system" ? recording : null;
  if (!systemDraft.profiles.length) {
    const empty = document.createElement("p"); empty.className = "hint";
    empty.textContent = systemReady ? "还没有软件配置。点击「添加软件配置」开始。" : "正在加载系统映射…";
    host.append(empty);
  }
  systemDraft.profiles.forEach((profile, profileIndex) => {
    const card = document.createElement("article"); card.className = "system-profile";
    const head = document.createElement("div"); head.className = "system-head";
    const enabled = document.createElement("label"); enabled.className = "system-enabled";
    const enabledInput = document.createElement("input"); enabledInput.type = "checkbox"; enabledInput.checked = profile.enabled;
    enabledInput.addEventListener("change", () => { profile.enabled = enabledInput.checked; systemDirty = true; });
    enabled.append(enabledInput, document.createTextNode("启用")); head.append(enabled);
    for (const [field, text, maxLength, placeholder] of [
      ["name", "名称", 80, "例如：PotPlayer"],
      ["process", "进程名", 260, "例如：PotPlayerMini64.exe"],
      ["title", "窗口标题包含（可选）", 200, "留空则匹配该软件的全部窗口"]
    ]) {
      const wrapper = document.createElement("label"); wrapper.textContent = text;
      const input = document.createElement("input"); input.type = "text"; input.maxLength = maxLength;
      input.value = profile[field]; input.placeholder = placeholder;
      input.addEventListener("input", () => { profile[field] = input.value; systemDirty = true; });
      wrapper.append(input); head.append(wrapper);
    }
    const remove = document.createElement("button"); remove.className = "remove"; remove.textContent = "删除配置";
    remove.setAttribute("aria-label", `删除配置 ${profile.name || profileIndex + 1}`);
    remove.addEventListener("click", () => {
      if (!confirm(`删除「${profile.name || profile.process || `配置 ${profileIndex + 1}`}」及其全部按键映射？`)) return;
      systemDraft.profiles.splice(profileIndex, 1); systemDirty = true; renderSystem();
    });
    head.append(remove);
    const mappings = document.createElement("div"); mappings.className = "system-mappings";
    profile.bindings.forEach((row, bindingIndex) => {
      const line = document.createElement("div"); line.className = "system-mapping";
      const sourceRecording = active?.profileIndex === profileIndex && active?.bindingIndex === bindingIndex && active?.field === "source";
      const source = document.createElement("button"); source.className = `record${sourceRecording ? " recording" : ""}`;
      source.textContent = sourceRecording ? "请按遥控器键…" : row.source ? R.systemLabel(row.source) : "录制遥控键";
      source.setAttribute("aria-label", `录制第 ${bindingIndex + 1} 行的遥控按键`);
      source.addEventListener("click", () => startSystemRecording(profileIndex, bindingIndex, "source"));
      const clearSource = document.createElement("button"); clearSource.className = "clear"; clearSource.textContent = "清除";
      clearSource.setAttribute("aria-label", `清除第 ${bindingIndex + 1} 行的遥控按键`);
      clearSource.disabled = !row.source;
      clearSource.addEventListener("click", () => { row.source = ""; systemDirty = true; renderSystem(); });
      const arrow = document.createElement("span"); arrow.className = "system-arrow"; arrow.textContent = "⇒"; arrow.setAttribute("aria-hidden", "true");
      const target = document.createElement("input"); target.type = "text"; target.maxLength = 80;
      target.value = row.target; target.placeholder = "目标快捷键，例如 Ctrl+Shift+KeyS";
      target.setAttribute("aria-label", `第 ${bindingIndex + 1} 行的目标快捷键`);
      target.addEventListener("input", () => { row.target = target.value; systemDirty = true; });
      const targetRecording = active?.profileIndex === profileIndex && active?.bindingIndex === bindingIndex && active?.field === "target";
      const targetButton = document.createElement("button"); targetButton.className = `record${targetRecording ? " recording" : ""}`;
      targetButton.textContent = targetRecording ? "请按目标键…" : "录制目标";
      targetButton.setAttribute("aria-label", `录制第 ${bindingIndex + 1} 行的目标快捷键`);
      targetButton.addEventListener("click", () => startSystemRecording(profileIndex, bindingIndex, "target"));
      const clearTarget = document.createElement("button"); clearTarget.className = "clear"; clearTarget.textContent = "清除";
      clearTarget.setAttribute("aria-label", `清除第 ${bindingIndex + 1} 行的目标快捷键`);
      clearTarget.disabled = !row.target;
      clearTarget.addEventListener("click", () => { row.target = ""; systemDirty = true; renderSystem(); });
      const removeRow = document.createElement("button"); removeRow.className = "remove"; removeRow.textContent = "删除";
      removeRow.setAttribute("aria-label", `删除第 ${bindingIndex + 1} 行映射`);
      removeRow.addEventListener("click", () => { profile.bindings.splice(bindingIndex, 1); systemDirty = true; renderSystem(); });
      line.append(source, clearSource, arrow, target, targetButton, clearTarget, removeRow);
      mappings.append(line);
    });
    if (!profile.bindings.length) {
      const empty = document.createElement("p"); empty.className = "hint"; empty.textContent = "这个软件还没有按键映射。";
      mappings.append(empty);
    }
    const add = document.createElement("button"); add.textContent = "添加按键映射";
    add.disabled = profile.bindings.length >= R.SYSTEM_LIMITS.bindings;
    add.addEventListener("click", () => { profile.bindings.push(newSystemBinding()); systemDirty = true; renderSystem(); });
    card.append(head, mappings, add); host.append(card);
  });
  $("system-add").disabled = !systemReady || systemDraft.profiles.length >= R.SYSTEM_LIMITS.profiles;
  $("system-preset-douyin").disabled = !systemReady || systemDraft.profiles.length >= R.SYSTEM_LIMITS.profiles;
  $("system-save").disabled = !systemReady;
  $("system-download").disabled = !systemReady;
}
function startSystemRecording(profileIndex, bindingIndex, field) {
  stopRecording();
  recording = { group: "system", profileIndex, bindingIndex, field };
  $("cancel-recording").hidden = false;
  renderSystem();
  systemFeedback(field === "source"
    ? "按下要拦截的遥控按键（单个按键，不含 Ctrl / Alt / Shift）；Esc 也可录制，取消请点「取消录制」。"
    : "按下目标软件使用的快捷键组合；浏览器保留的组合无法录入时，可直接在输入框填写。");
}
async function loadSystemMap() {
  try {
    const saved = await chrome.storage.local.get(R.SYSTEM_MAP_KEY);
    const value = saved[R.SYSTEM_MAP_KEY];
    systemSnapshot = systemVersion(value);
    systemDraft = R.normalizeSystemMap(value);
    systemDirty = false; systemConflict = false; systemReady = true;
    renderSystem(); systemFeedback("已加载系统快捷键映射。修改后请保存，并重新下载配置。");
  } catch (_) { systemFeedback("加载失败，请重新打开设置页。", true); }
}
async function saveSystemMap(announce = true) {
  if (recording) { systemFeedback("请先完成或取消录制。", true); return false; }
  const normalized = R.normalizeSystemMap(systemDraft);
  const error = R.validateSystemMap(normalized);
  if (error) { systemFeedback(error, true); return false; }
  systemSaving = true;
  try {
    await chrome.storage.local.set({ [R.SYSTEM_MAP_KEY]: normalized });
    systemDraft = normalized; systemSnapshot = systemVersion(normalized);
    systemDirty = false; systemConflict = false;
    renderSystem();
    if (announce) systemFeedback("映射已保存。请重新下载配置并让本机助手重新加载。");
    return true;
  } catch (_) { systemFeedback("保存失败，请重试。", true); return false; }
  finally { systemSaving = false; }
}
$("system-enabled").addEventListener("change", (event) => { systemDraft.enabled = event.target.checked; systemDirty = true; });
$("system-add").addEventListener("click", () => {
  if (systemDraft.profiles.length >= R.SYSTEM_LIMITS.profiles) return;
  systemDraft.profiles.push(newSystemProfile()); systemDirty = true; renderSystem();
});
$("system-preset-douyin").addEventListener("click", () => {
  if (!systemReady) return systemFeedback("正在加载系统映射，请稍候。", true);
  if (systemDraft.profiles.length >= R.SYSTEM_LIMITS.profiles)
    return systemFeedback(`最多添加 ${R.SYSTEM_LIMITS.profiles} 个软件配置。`, true);
  const preset = R.systemPreset("douyin");
  if (!preset) return systemFeedback("预设不可用，请重新打开设置页。", true);
  const exists = systemDraft.profiles.some(profile =>
    (profile.process && profile.process.toLowerCase() === preset.process.toLowerCase()) || profile.name === preset.name);
  if (exists) return systemFeedback("已有抖音电脑版配置，请直接修改现有配置。", true);
  systemDraft.profiles.push({
    ...newSystemProfile(), name: preset.name, process: preset.process, title: preset.title,
    enabled: preset.enabled !== false,
    bindings: preset.bindings.map(row => ({ ...newSystemBinding(), ...row }))
  });
  systemDirty = true; renderSystem();
  systemFeedback("已添加抖音电脑版预设：确认键→空格（播放/暂停）、Home→Z（点赞）、PageUp/PageDown→上/下一条。请核对进程名与抖音内快捷键后保存。");
});
$("system-save").addEventListener("click", () => { void saveSystemMap(); });
$("system-download").addEventListener("click", async () => {
  if (recording) return systemFeedback("请先完成或取消录制。", true);
  const normalized = R.normalizeSystemMap(systemDraft);
  const error = R.validateSystemMap(normalized);
  if (error) return systemFeedback(error, true);
  systemDraft = normalized;
  if (!await saveSystemMap(false)) return;
  const blob = new Blob([R.systemMapConfigJson(systemDraft)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a"); link.href = url; link.download = "remote-keys.json"; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  systemFeedback("已下载 remote-keys.json。放进扩展目录的 native 文件夹后，本机助手会在 1–2 秒内自动重新加载。");
});
$("system-reload").addEventListener("click", () => {
  if (systemDirty && !confirm("重新加载会丢弃尚未保存的系统映射修改，继续吗？")) return;
  void loadSystemMap();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes[R.SYSTEM_MAP_KEY] || !systemReady || systemSaving) return;
  const value = changes[R.SYSTEM_MAP_KEY].newValue;
  if (systemVersion(value) === systemSnapshot) return;
  if (systemDirty) { systemConflict = true; systemFeedback("系统映射已在其他位置更改。请先保存或重新加载。", true); }
  else { systemSnapshot = systemVersion(value); systemDraft = R.normalizeSystemMap(value); renderSystem(); systemFeedback("系统映射已更新。"); }
});
renderSystem(); void loadSystemMap();

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
  $("site-state").textContent = granted ? "已授权网站访问" : "仅在 YouTube / 抖音内可用";
  $("browser-exit").hidden = !(await browserModeState())?.active;
}
$("site-grant").addEventListener("click", () => {
  // The permission prompt must be requested from inside the click gesture.
  chrome.permissions.request({ origins: SITE_ORIGINS }).then(async (granted) => {
    if (granted) await chrome.runtime.sendMessage({ type: "remote:browser-permission-sync" }).catch(() => null);
    $("global-feedback").textContent = granted ? "已授权：普通网页中也可以双击入口键进入浏览器模式。" :
      "未授权：浏览器模式仍可在 YouTube / 抖音内使用。";
    await renderGlobal();
  }).catch(() => { $("global-feedback").textContent = "授权没有完成，请重试。"; });
});
$("site-revoke").addEventListener("click", async () => {
  try { await chrome.permissions.remove({ origins: SITE_ORIGINS }); }
  catch (_) { /* Already removed. */ }
  $("global-feedback").textContent = "已撤销：浏览器模式只在 YouTube / 抖音内可用。";
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
