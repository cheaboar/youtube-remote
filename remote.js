(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.YouTubeRemote = api;
})(globalThis, function () {
  "use strict";
  const ACTIONS = {
    up: "向上", down: "向下", left: "向左", right: "向右", confirm: "确认",
    back: "逐层返回", home: "首页", search: "搜索", guide: "左侧导航", sidebar: "右侧列表", player: "播放器",
    togglePlayback: "播放 / 暂停", fullscreen: "视频全屏", historyBack: "直接返回上一页"
  };
  const DOUBLE_ACTIONS = ["search", "sidebar", "player", "togglePlayback", "fullscreen"];
  const SEQUENCE_GROUPS = [
    { id: "common", title: "常用", actions: { togglePlayback: "播放 / 暂停", historyBack: "返回上一页",
      search: "定位搜索框", sidebar: "右侧列表", home: "返回首页", guide: "左侧导航" } },
    { id: "player", title: "播放器", actions: { mute: "静音 / 取消静音", captions: "字幕开关",
      fullscreen: "视频全屏", theater: "影院模式", playerSettings: "播放器设置" } },
    { id: "page", title: "页面", actions: { reload: "刷新当前页面", closeTab: "关闭当前标签页" } }
  ];
  const SEQUENCE_ACTIONS = Object.assign({}, ...SEQUENCE_GROUPS.map(group => group.actions));
  const legacySequences = {
    closeTab: ["ArrowDown", "ArrowRight"], reload: ["ArrowLeft", "ArrowRight"],
    home: ["ArrowUp", "ArrowUp"], search: ["ArrowUp", "ArrowRight"],
    historyBack: ["ArrowDown", "ArrowLeft"], togglePlayback: ["ArrowRight", "ArrowRight"],
    fullscreen: ["ArrowRight", "ArrowUp"], sidebar: ["ArrowRight", "ArrowDown"]
  };
  const defaults = {
    enabled: true, showStatus: true, doubleInterval: 400,
    bindings: { up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight", confirm: "Enter",
      back: "Escape", home: "Alt+Shift+KeyH", search: "Alt+Shift+KeyS", guide: "Alt+Shift+KeyG", sidebar: "Alt+Shift+KeyY", player: "Alt+Shift+KeyP",
      togglePlayback: "Alt+Shift+KeyK", fullscreen: "Alt+Shift+KeyF", historyBack: "Alt+Shift+KeyB" },
    doubles: { search: "ArrowUp", sidebar: "ArrowDown", player: "", togglePlayback: "", fullscreen: "" },
    sequences: {
      closeTab: ["ArrowLeft", "ArrowRight", "ArrowRight"], reload: ["ArrowLeft", "ArrowRight", "ArrowLeft"],
      home: ["ArrowLeft", "ArrowUp"], search: ["ArrowLeft", "ArrowLeft"],
      historyBack: ["ArrowRight", "ArrowLeft"], togglePlayback: ["ArrowRight", "ArrowRight"],
      fullscreen: ["ArrowRight", "ArrowUp"], sidebar: ["ArrowRight", "ArrowDown"],
      mute: ["ArrowLeft", "ArrowDown", "ArrowLeft"], captions: ["ArrowLeft", "ArrowDown", "ArrowRight"],
      theater: ["ArrowLeft", "ArrowDown", "ArrowUp"], playerSettings: ["ArrowLeft", "ArrowDown", "ArrowDown"],
      guide: ["ArrowLeft", "ArrowRight", "ArrowUp"]
    }
  };
  const cloneDefaults = () => JSON.parse(JSON.stringify(defaults));
  const canonicalChord = value => typeof value === "string" ? value.replace(/(^|\+)(Return|NumpadEnter)$/, "$1Enter") : value;
  function chord(event) {
    if (["Shift", "Control", "Alt", "Meta", "AltGraph", "Process", "Dead"].includes(event.key)) return "";
    const unknown = value => !value || value === "Unidentified";
    const enter = [event.key, event.code].some(value => ["Enter", "Return", "NumpadEnter"].includes(value)) ||
      unknown(event.key) && unknown(event.code) && (event.keyCode === 13 || event.which === 13);
    let code = enter ? "Enter" : unknown(event.code) ? event.key : event.code;
    if (code === " ") code = "Space";
    if (/^[a-z]$/i.test(code)) code = `Key${code.toUpperCase()}`;
    if (/^\d$/.test(code)) code = `Digit${code}`;
    if (unknown(code)) return "";
    return [event.ctrlKey && "Ctrl", event.altKey && "Alt", event.shiftKey && "Shift", event.metaKey && "Meta", code].filter(Boolean).join("+");
  }
  function label(value) {
    return value ? value.replace(/Key([A-Z])/g, "$1").replace(/Digit(\d)/g, "$1")
      .replace("ArrowUp", "↑").replace("ArrowDown", "↓").replace("ArrowLeft", "←").replace("ArrowRight", "→").replace("Escape", "Esc") : "未绑定";
  }
  const validChord = (value) => typeof value === "string" && /^(?:Ctrl\+)?(?:Alt\+)?(?:Shift\+)?(?:Meta\+)?[A-Za-z0-9]+$/.test(value);
  const reservedChord = (value) => /^(Ctrl|Meta)\+(?:Shift\+)?(Key[LNTRW]|Tab)$/.test(value) || value === "Alt+F4";
  function sequenceCandidates(sequences, prefix) {
    const candidates = Object.keys(SEQUENCE_ACTIONS).filter(action => sequences[action]?.length &&
      prefix.every((key, index) => sequences[action][index] === key))
      .map(action => ({ action, keys: sequences[action] }));
    return { candidates, action: candidates.find(item => item.keys.length === prefix.length)?.action || null };
  }
  function validate(settings) {
    if (!settings || typeof settings.enabled !== "boolean" || typeof settings.showStatus !== "boolean") return "设置格式不正确";
    if (!Number.isInteger(settings.doubleInterval) || settings.doubleInterval < 200 || settings.doubleInterval > 1000) return "双击间隔应为 200–1000 毫秒";
    const used = new Map();
    for (const action of Object.keys(ACTIONS)) {
      const value = settings.bindings?.[action];
      if (typeof value !== "string" || (value && !validChord(value))) return `请重新录制「${ACTIONS[action]}」`;
      if (!value) continue;
      if (used.has(value)) return `「${ACTIONS[action]}」与「${ACTIONS[used.get(value)]}」使用了同一个按键`;
      if (reservedChord(value)) return `${label(value)} 是浏览器或系统保留快捷键`;
      used.set(value, action);
    }
    const doubles = new Set();
    for (const action of DOUBLE_ACTIONS) {
      const value = settings.doubles?.[action];
      if (typeof value !== "string" || (value && !validChord(value))) return "请重新录制双击按键";
      if (!value) continue;
      if (doubles.has(value)) return "两个双击操作不能使用同一个按键";
      const single = used.get(value);
      if (single && !["up", "down", "left", "right"].includes(single)) return "双击按键只能与方向操作共用，避免重复确认或返回";
      doubles.add(value);
    }
    const sequences = [];
    for (const action of Object.keys(SEQUENCE_ACTIONS)) {
      const keys = settings.sequences?.[action];
      if (!Array.isArray(keys) || keys.length && (keys.length < 2 || keys.length > 4) || keys.some(key => !validChord(key)))
        return `「${SEQUENCE_ACTIONS[action]}」需要录制 2–4 个按键，或清空以禁用`;
      if (!keys.length) continue;
      if (keys.some(key => ["Escape", "Backspace", settings.bindings.back].includes(key))) return "复合键不能使用返回键、Esc 或 Backspace";
      if (keys.some(reservedChord)) return "复合键不能使用浏览器或系统保留快捷键";
      if (sequences.some(other => keys.every((key, index) => other[index] === key) || other.every((key, index) => keys[index] === key)))
        return "复合键存在重复或前缀冲突，请修改按键顺序";
      sequences.push(keys);
    }
    if (!sequences.length) return "请至少保留一条有效复合键";
    return "";
  }
  function normalize(value) {
    if (!value || typeof value !== "object") return cloneDefaults();
    const normalizeGroup = group => Object.fromEntries(Object.entries(group || {}).map(([action, keys]) =>
      [action, Array.isArray(keys) ? keys.map(canonicalChord) : canonicalChord(keys)]));
    const settings = { ...value, bindings: normalizeGroup(value.bindings), doubles: normalizeGroup(value.doubles) };
    if (Object.hasOwn(value, "sequences")) {
      settings.sequences = normalizeGroup(value.sequences);
      // Upgrade the old preset as a whole so that custom sequences never acquire prefix conflicts.
      const oldPreset = Object.keys(legacySequences).every(action => {
        const keys = settings.sequences[action];
        return Array.isArray(keys) && (!keys.length || JSON.stringify(keys) === JSON.stringify(legacySequences[action]));
      }) && Object.entries(settings.sequences).every(([action, keys]) => Object.hasOwn(legacySequences, action) ||
        Array.isArray(keys) && (!keys.length || JSON.stringify(keys) === JSON.stringify(defaults.sequences[action])));
      if (oldPreset) {
        for (const action of Object.keys(SEQUENCE_ACTIONS)) {
          if (!Object.hasOwn(settings.sequences, action) || settings.sequences[action].length) settings.sequences[action] = [...defaults.sequences[action]];
          if (settings.sequences[action].includes(settings.bindings.back)) settings.sequences[action] = [];
        }
      }
      // Add new commands without overwriting custom or disabled sequences. Conflicting presets stay disabled.
      for (const action of Object.keys(SEQUENCE_ACTIONS)) {
        if (Object.hasOwn(settings.sequences, action)) continue;
        const keys = defaults.sequences[action];
        const conflict = keys.includes(settings.bindings.back) || Object.values(settings.sequences).some(other =>
          Array.isArray(other) && other.length && (keys.every((key, i) => other[i] === key) || other.every((key, i) => keys[i] === key)));
        settings.sequences[action] = conflict ? [] : [...keys];
      }
    }
    for (const action of ["home", "guide"]) {
      if (Object.hasOwn(settings.bindings, action)) continue;
      const shortcut = defaults.bindings[action];
      const used = [...Object.values(settings.bindings), ...Object.values(settings.doubles || {})];
      settings.bindings[action] = used.includes(shortcut) ? "" : shortcut;
    }
    if (!Object.hasOwn(settings, "sequences")) {
      settings.sequences = cloneDefaults().sequences;
      // Old remotes may use an arrow as Back. Keep that mapping and avoid creating reserved sequences.
      for (const action of Object.keys(SEQUENCE_ACTIONS)) {
        if (settings.sequences[action].includes(settings.bindings.back)) settings.sequences[action] = [];
      }
    }
    return validate(settings) ? cloneDefaults() : JSON.parse(JSON.stringify(settings));
  }
  function resolve(settings, value) { return Object.keys(ACTIONS).find((action) => settings.bindings[action] === value && value) || null; }
  function createMatcher() {
    let previous = null;
    return {
      reset() { previous = null; },
      match(event, settings, region) {
        const value = chord(event);
        let action = resolve(settings, value);
        const doubleAction = region === "player" && DOUBLE_ACTIONS.find((name) => settings.doubles[name] === value && value);
        if (!doubleAction) previous = null;
        else if (!event.repeat) {
          if (previous?.value === value && event.timeStamp >= previous.time && event.timeStamp - previous.time <= settings.doubleInterval) {
            previous = null;
            return doubleAction;
          }
          previous = { value, time: event.timeStamp };
        }
        if (event.repeat && !["up", "down", "left", "right"].includes(action)) action = null;
        return action;
      }
    };
  }
  return { ACTIONS, DOUBLE_ACTIONS, SEQUENCE_ACTIONS, SEQUENCE_GROUPS, cloneDefaults, chord, label, validate, normalize,
    resolve, createMatcher, sequenceCandidates };
});
