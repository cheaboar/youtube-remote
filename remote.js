(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.YouTubeRemote = api;
})(globalThis, function () {
  "use strict";
  const ACTIONS = {
    up: "向上", down: "向下", left: "向左", right: "向右", confirm: "确认",
    back: "逐层返回", home: "首页", search: "搜索", sidebar: "右侧列表", player: "播放器",
    togglePlayback: "播放 / 暂停", fullscreen: "视频全屏", historyBack: "直接返回上一页"
  };
  const DOUBLE_ACTIONS = ["search", "sidebar", "player", "togglePlayback", "fullscreen"];
  const defaults = {
    enabled: true, showStatus: true, doubleInterval: 400,
    bindings: { up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight", confirm: "Enter",
      back: "Escape", home: "Alt+Shift+KeyH", search: "Alt+Shift+KeyS", sidebar: "Alt+Shift+KeyY", player: "Alt+Shift+KeyP",
      togglePlayback: "Alt+Shift+KeyK", fullscreen: "Alt+Shift+KeyF", historyBack: "Alt+Shift+KeyB" },
    doubles: { search: "ArrowUp", sidebar: "ArrowDown", player: "", togglePlayback: "", fullscreen: "" }
  };
  const cloneDefaults = () => JSON.parse(JSON.stringify(defaults));
  function chord(event) {
    if (["Shift", "Control", "Alt", "Meta", "AltGraph", "Unidentified", "Process", "Dead"].includes(event.key)) return "";
    let code = event.code || event.key;
    if (code === "NumpadEnter") code = "Enter";
    if (code === " ") code = "Space";
    if (/^[a-z]$/i.test(code)) code = `Key${code.toUpperCase()}`;
    if (/^\d$/.test(code)) code = `Digit${code}`;
    if (!code) return "";
    return [event.ctrlKey && "Ctrl", event.altKey && "Alt", event.shiftKey && "Shift", event.metaKey && "Meta", code].filter(Boolean).join("+");
  }
  function label(value) {
    return value ? value.replace(/Key([A-Z])/g, "$1").replace(/Digit(\d)/g, "$1")
      .replace("ArrowUp", "↑").replace("ArrowDown", "↓").replace("ArrowLeft", "←").replace("ArrowRight", "→").replace("Escape", "Esc") : "未绑定";
  }
  function validate(settings) {
    if (!settings || typeof settings.enabled !== "boolean" || typeof settings.showStatus !== "boolean") return "设置格式不正确";
    if (!Number.isInteger(settings.doubleInterval) || settings.doubleInterval < 200 || settings.doubleInterval > 1000) return "双击间隔应为 200–1000 毫秒";
    const used = new Map();
    const syntax = /^(?:Ctrl\+)?(?:Alt\+)?(?:Shift\+)?(?:Meta\+)?[A-Za-z0-9]+$/;
    for (const action of Object.keys(ACTIONS)) {
      const value = settings.bindings?.[action];
      if (typeof value !== "string" || (value && !syntax.test(value))) return `请重新录制「${ACTIONS[action]}」`;
      if (!value) continue;
      if (used.has(value)) return `「${ACTIONS[action]}」与「${ACTIONS[used.get(value)]}」使用了同一个按键`;
      if (/^(Ctrl|Meta)\+(Key[LNTRW]|Tab)$/.test(value) || value === "Alt+F4") return `${label(value)} 是浏览器或系统保留快捷键`;
      used.set(value, action);
    }
    const doubles = new Set();
    for (const action of DOUBLE_ACTIONS) {
      const value = settings.doubles?.[action];
      if (typeof value !== "string" || (value && !syntax.test(value))) return "请重新录制双击按键";
      if (!value) continue;
      if (doubles.has(value)) return "两个双击操作不能使用同一个按键";
      const single = used.get(value);
      if (single && !["up", "down", "left", "right"].includes(single)) return "双击按键只能与方向操作共用，避免重复确认或返回";
      doubles.add(value);
    }
    return "";
  }
  function normalize(value) {
    if (!value || typeof value !== "object") return cloneDefaults();
    const settings = { ...value, bindings: { ...value.bindings } };
    if (!Object.hasOwn(settings.bindings, "home")) {
      const home = defaults.bindings.home;
      const used = [...Object.values(settings.bindings), ...Object.values(settings.doubles || {})];
      settings.bindings.home = used.includes(home) ? "" : home;
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
  return { ACTIONS, DOUBLE_ACTIONS, cloneDefaults, chord, label, validate, normalize, resolve, createMatcher };
});
