(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.YouTubeRemote = api;
})(globalThis, function () {
  "use strict";
  const ACTIONS = {
    up: "向上", down: "向下", left: "向左", right: "向右", confirm: "确认",
    back: "逐层返回", home: "首页", search: "搜索", guide: "左侧导航", toggleGuide: "展开 / 收起左侧导航",
    sidebar: "右侧列表", player: "播放器",
    togglePlayback: "播放 / 暂停", fullscreen: "视频全屏", restorePlayback: "恢复正常播放", historyBack: "直接返回上一页",
    browser: "浏览器模式（双击，YouTube 内三击）",
    focusMode: "焦点模式（可选快捷键，浏览器模式内）", focusInput: "定位输入框（可选快捷键，浏览器模式内）",
    browserClose: "关闭标签页（可选快捷键，浏览器模式内）"
  };
  const DOUBLE_ACTIONS = ["search", "sidebar", "player", "togglePlayback", "fullscreen"];
  // Shorts reuses the direction keys for video switching, so its doubles are scoped to that page.
  const SHORTS_DOUBLE_ACTIONS = ["shortsComments", "shortsCloseComments", "shortsLike"];
  const DOUBLE_LABELS = { shortsComments: "展开评论并聚焦", shortsCloseComments: "关闭评论", shortsLike: "点赞" };
  const SEQUENCE_GROUPS = [
    { id: "common", title: "常用", actions: { togglePlayback: "播放 / 暂停", historyBack: "返回上一页",
      search: "定位搜索框", sidebar: "右侧列表", home: "返回首页", guide: "左侧导航",
      toggleGuide: "展开 / 收起左侧导航" } },
    { id: "player", title: "播放器", actions: { mute: "静音 / 取消静音", captions: "字幕开关",
      fullscreen: "视频全屏", theater: "影院模式", playerSettings: "播放器设置",
      pipComments: "画中画看评论", restorePlayback: "恢复正常播放" } },
    { id: "page", title: "页面", actions: { reload: "刷新当前页面", closeTab: "关闭当前标签页", scrollTop: "回到页面顶部" } }
  ];
  const SEQUENCE_ACTIONS = Object.assign({}, ...SEQUENCE_GROUPS.map(group => group.actions));
  // The Douyin playback page owns a separate sequence namespace: its commands differ from
  // YouTube's, and a shared tree would have no room left for new prefixes. Every default starts
  // with ← or → and no sequence is a prefix of another, so typing narrows the list deterministically.
  const DOUYIN_SEQUENCE_GROUPS = [
    { id: "common", title: "常用", actions: {
      togglePlayback: "播放 / 暂停", seekBackward: "后退 5 秒", seekForward: "前进 5 秒",
      mute: "静音 / 取消静音", fullscreen: "全屏", pageFullscreen: "网页全屏" } },
    { id: "interact", title: "互动", actions: {
      like: "点赞", collect: "收藏", share: "分享", comments: "评论区", follow: "关注作者" } },
    { id: "pick", title: "选片", actions: {
      rail: "右侧推荐视频", nextVideo: "下一条视频", prevVideo: "上一条视频",
      pageDown: "向下翻页", pageUp: "向上翻页" } },
    { id: "nav", title: "导航", actions: {
      search: "搜索", guide: "左侧导航", home: "抖音精选", historyBack: "返回上一页", scrollTop: "回到顶部" } }
  ];
  const DOUYIN_SEQUENCE_ACTIONS = Object.assign({}, ...DOUYIN_SEQUENCE_GROUPS.map(group => group.actions));
  // Bilibili and Youku are playback pages with the same remote-facing actions (Bilibili adds
  // like/coin/favorite/share). They share one prefix-free catalog so the panel grammar and the
  // default tree stay identical; each site still saves its own copy of the keys.
  const VIDEO_SEQUENCE_GROUPS = [
    { id: "common", title: "常用", actions: {
      togglePlayback: "播放 / 暂停", seekBackward: "后退 5 秒", seekForward: "前进 5 秒",
      mute: "静音 / 取消静音", fullscreen: "全屏", pageFullscreen: "网页全屏",
      danmaku: "弹幕开关" } },
    { id: "interact", title: "互动", actions: {
      like: "点赞", coin: "投币", fav: "收藏", share: "分享", comments: "评论区" } },
    { id: "pick", title: "选片", actions: {
      rail: "右侧推荐视频", nextEpisode: "下一集", pageDown: "向下翻页", pageUp: "向上翻页" } },
    { id: "nav", title: "导航", actions: {
      search: "搜索", home: "返回首页", historyBack: "返回上一页", scrollTop: "回到顶部" } }
  ];
  const VIDEO_SEQUENCE_ACTIONS = Object.assign({}, ...VIDEO_SEQUENCE_GROUPS.map(group => group.actions));
  const legacySequences = {
    closeTab: ["ArrowDown", "ArrowRight"], reload: ["ArrowLeft", "ArrowRight"],
    home: ["ArrowUp", "ArrowUp"], search: ["ArrowUp", "ArrowRight"],
    historyBack: ["ArrowDown", "ArrowLeft"], togglePlayback: ["ArrowRight", "ArrowRight"],
    fullscreen: ["ArrowRight", "ArrowUp"], sidebar: ["ArrowRight", "ArrowDown"]
  };
  // A preset is upgraded as a whole, so new commands can reuse the space behind its prefixes.
  const previousSequences = {
    closeTab: ["ArrowLeft", "ArrowRight", "ArrowRight"], reload: ["ArrowLeft", "ArrowRight", "ArrowLeft"],
    home: ["ArrowLeft", "ArrowUp"], search: ["ArrowLeft", "ArrowLeft"],
    historyBack: ["ArrowRight", "ArrowLeft"], togglePlayback: ["ArrowRight", "ArrowRight"],
    fullscreen: ["ArrowRight", "ArrowUp"], sidebar: ["ArrowRight", "ArrowDown"],
    mute: ["ArrowLeft", "ArrowDown", "ArrowLeft"], captions: ["ArrowLeft", "ArrowDown", "ArrowRight"],
    theater: ["ArrowLeft", "ArrowDown", "ArrowUp"], playerSettings: ["ArrowLeft", "ArrowDown", "ArrowDown"],
    guide: ["ArrowLeft", "ArrowRight", "ArrowUp"], toggleGuide: ["ArrowLeft", "ArrowRight", "ArrowDown"]
  };
  const videoSequencePreset = {
    togglePlayback: ["ArrowRight", "ArrowRight"], seekBackward: ["ArrowLeft", "ArrowLeft"],
    seekForward: ["ArrowRight", "ArrowLeft"], mute: ["ArrowLeft", "ArrowDown"],
    fullscreen: ["ArrowRight", "ArrowUp", "ArrowLeft"], pageFullscreen: ["ArrowRight", "ArrowUp", "ArrowRight"],
    danmaku: ["ArrowRight", "ArrowDown", "ArrowLeft"],
    like: ["ArrowRight", "ArrowUp", "ArrowUp"], coin: ["ArrowRight", "ArrowUp", "ArrowDown"],
    fav: ["ArrowLeft", "ArrowUp", "ArrowLeft"], share: ["ArrowLeft", "ArrowUp", "ArrowRight"],
    comments: ["ArrowLeft", "ArrowUp", "ArrowUp"], rail: ["ArrowLeft", "ArrowUp", "ArrowDown"],
    nextEpisode: ["ArrowRight", "ArrowDown", "ArrowRight"],
    pageDown: ["ArrowRight", "ArrowDown", "ArrowUp"], pageUp: ["ArrowRight", "ArrowDown", "ArrowDown"],
    search: ["ArrowLeft", "ArrowRight", "ArrowLeft"], home: ["ArrowLeft", "ArrowRight", "ArrowRight"],
    historyBack: ["ArrowLeft", "ArrowRight", "ArrowUp"], scrollTop: ["ArrowLeft", "ArrowRight", "ArrowDown"]
  };
  const defaults = {
    enabled: true, showStatus: true, doubleInterval: 400,
    bindings: { up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight", confirm: "Enter",
      back: "Escape", home: "Alt+Shift+KeyH", search: "Alt+Shift+KeyS", guide: "Alt+Shift+KeyG", toggleGuide: "Alt+Shift+KeyN",
      sidebar: "Alt+Shift+KeyY", player: "Alt+Shift+KeyP",
      togglePlayback: "Alt+Shift+KeyK", fullscreen: "Alt+Shift+KeyF", restorePlayback: "Alt+Shift+KeyR", historyBack: "Alt+Shift+KeyB",
      browser: "Enter", focusMode: "", focusInput: "", browserClose: "" },
    doubles: { search: "ArrowUp", sidebar: "ArrowDown", player: "", togglePlayback: "", fullscreen: "",
      shortsComments: "ArrowRight", shortsCloseComments: "ArrowLeft", shortsLike: "ArrowUp" },
    sequences: {
      closeTab: ["ArrowLeft", "ArrowRight", "ArrowRight", "ArrowRight"], reload: ["ArrowLeft", "ArrowRight", "ArrowLeft"],
      home: ["ArrowLeft", "ArrowUp"], search: ["ArrowLeft", "ArrowLeft"],
      historyBack: ["ArrowRight", "ArrowLeft"], togglePlayback: ["ArrowRight", "ArrowRight"],
      fullscreen: ["ArrowRight", "ArrowUp"], sidebar: ["ArrowRight", "ArrowDown"],
      mute: ["ArrowLeft", "ArrowDown", "ArrowLeft"], captions: ["ArrowLeft", "ArrowDown", "ArrowRight"],
      theater: ["ArrowLeft", "ArrowDown", "ArrowUp"], playerSettings: ["ArrowLeft", "ArrowDown", "ArrowDown"],
      guide: ["ArrowLeft", "ArrowRight", "ArrowUp"], toggleGuide: ["ArrowLeft", "ArrowRight", "ArrowDown"],
      pipComments: ["ArrowLeft", "ArrowRight", "ArrowRight", "ArrowLeft"],
      restorePlayback: ["ArrowLeft", "ArrowRight", "ArrowRight", "ArrowUp"],
      scrollTop: ["ArrowLeft", "ArrowRight", "ArrowRight", "ArrowDown"]
    },
    douyinSequences: {
      togglePlayback: ["ArrowRight", "ArrowRight"], seekBackward: ["ArrowLeft", "ArrowLeft"],
      seekForward: ["ArrowRight", "ArrowLeft"], mute: ["ArrowLeft", "ArrowDown"],
      fullscreen: ["ArrowRight", "ArrowUp", "ArrowLeft"], pageFullscreen: ["ArrowRight", "ArrowUp", "ArrowRight"],
      like: ["ArrowRight", "ArrowUp", "ArrowUp"], collect: ["ArrowRight", "ArrowUp", "ArrowDown"],
      share: ["ArrowLeft", "ArrowUp", "ArrowLeft"], comments: ["ArrowLeft", "ArrowUp", "ArrowRight"],
      follow: ["ArrowLeft", "ArrowUp", "ArrowUp"], rail: ["ArrowLeft", "ArrowUp", "ArrowDown"],
      nextVideo: ["ArrowRight", "ArrowDown", "ArrowLeft"], prevVideo: ["ArrowRight", "ArrowDown", "ArrowRight"],
      pageDown: ["ArrowRight", "ArrowDown", "ArrowUp"], pageUp: ["ArrowRight", "ArrowDown", "ArrowDown"],
      search: ["ArrowLeft", "ArrowRight", "ArrowLeft"], home: ["ArrowLeft", "ArrowRight", "ArrowRight"],
      // Every branch under ← is already a complete command, so the guide entry hangs off the
      // nav branch (← → …) and uses a letter instead of a fourth arrow.
      guide: ["ArrowLeft", "ArrowRight", "KeyG"],
      historyBack: ["ArrowLeft", "ArrowRight", "ArrowUp"], scrollTop: ["ArrowLeft", "ArrowRight", "ArrowDown"]
    },
    bilibiliSequences: { ...videoSequencePreset },
    youkuSequences: { ...videoSequencePreset }
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
  function candidatesIn(catalog, sequences, prefix) {
    const candidates = Object.keys(catalog).filter(action => sequences[action]?.length &&
      prefix.every((key, index) => sequences[action][index] === key))
      .map(action => ({ action, keys: sequences[action] }));
    return { candidates, action: candidates.find(item => item.keys.length === prefix.length)?.action || null };
  }
  function sequenceCandidates(sequences, prefix) {
    return candidatesIn(SEQUENCE_ACTIONS, sequences, prefix);
  }
  function douyinSequenceCandidates(sequences, prefix) {
    return candidatesIn(DOUYIN_SEQUENCE_ACTIONS, sequences, prefix);
  }
  function videoSequenceCandidates(sequences, prefix) {
    return candidatesIn(VIDEO_SEQUENCE_ACTIONS, sequences, prefix);
  }
  function validateSequenceMap(map, catalog, back) {
    const list = [];
    for (const action of Object.keys(catalog)) {
      const keys = map?.[action];
      if (!Array.isArray(keys) || keys.length && (keys.length < 2 || keys.length > 4) || keys.some(key => !validChord(key)))
        return { error: `「${catalog[action]}」需要录制 2–4 个按键，或清空以禁用`, list };
      if (!keys.length) continue;
      if (keys.some(key => ["Escape", "Backspace", back].includes(key))) return { error: "复合键不能使用返回键、Esc 或 Backspace", list };
      if (keys.some(reservedChord)) return { error: "复合键不能使用浏览器或系统保留快捷键", list };
      if (list.some(other => keys.every((key, index) => other[index] === key) || other.every((key, index) => keys[index] === key)))
        return { error: "复合键存在重复或前缀冲突，请修改按键顺序", list };
      list.push(keys);
    }
    return { error: "", list };
  }
  function validate(settings) {
    if (!settings || typeof settings.enabled !== "boolean" || typeof settings.showStatus !== "boolean") return "设置格式不正确";
    if (!Number.isInteger(settings.doubleInterval) || settings.doubleInterval < 200 || settings.doubleInterval > 1000) return "双击间隔应为 200–1000 毫秒";
    const used = new Map();
    for (const action of Object.keys(ACTIONS)) {
      const value = settings.bindings?.[action];
      if (typeof value !== "string" || (value && !validChord(value))) return `请重新录制「${ACTIONS[action]}」`;
      if (!value) continue;
      if (used.has(value)) {
        // The browser entry deliberately shares the confirm key: a double tap enters the mode on
        // ordinary pages, and a third tap is needed on YouTube, where the confirm key already
        // opens the command panel.
        const other = used.get(value);
        if (!(action === "browser" && other === "confirm")) return `「${ACTIONS[action]}」与「${ACTIONS[other]}」使用了同一个按键`;
        continue;
      }
      if (reservedChord(value)) return `${label(value)} 是浏览器或系统保留快捷键`;
      used.set(value, action);
    }
    for (const actions of [DOUBLE_ACTIONS, SHORTS_DOUBLE_ACTIONS]) {
      const doubles = new Set();
      for (const action of actions) {
        const value = settings.doubles?.[action];
        if (typeof value !== "string" || (value && !validChord(value))) return "请重新录制双击按键";
        if (!value) continue;
        if (doubles.has(value)) return "两个双击操作不能使用同一个按键";
        const single = used.get(value);
        if (single && !["up", "down", "left", "right"].includes(single)) return "双击按键只能与方向操作共用，避免重复确认或返回";
        doubles.add(value);
      }
    }
    // The two pages have separate namespaces, so conflicts are checked per map.
    const youtube = validateSequenceMap(settings.sequences, SEQUENCE_ACTIONS, settings.bindings.back);
    if (youtube.error) return youtube.error;
    const douyin = validateSequenceMap(settings.douyinSequences, DOUYIN_SEQUENCE_ACTIONS, settings.bindings.back);
    if (douyin.error) return douyin.error;
    const bilibili = validateSequenceMap(settings.bilibiliSequences, VIDEO_SEQUENCE_ACTIONS, settings.bindings.back);
    if (bilibili.error) return bilibili.error;
    const youku = validateSequenceMap(settings.youkuSequences, VIDEO_SEQUENCE_ACTIONS, settings.bindings.back);
    if (youku.error) return youku.error;
    if (![youtube, douyin, bilibili, youku].some(map => map.list.length)) return "请至少保留一条有效复合键";
    return "";
  }
  function normalize(value) {
    if (!value || typeof value !== "object") return cloneDefaults();
    const normalizeGroup = group => Object.fromEntries(Object.entries(group || {}).map(([action, keys]) =>
      [action, Array.isArray(keys) ? keys.map(canonicalChord) : canonicalChord(keys)]));
    const settings = { ...value, bindings: normalizeGroup(value.bindings), doubles: normalizeGroup(value.doubles) };
    if (Object.hasOwn(value, "sequences")) {
      settings.sequences = normalizeGroup(value.sequences);
      // Upgrade an untouched preset as a whole so that custom sequences never acquire prefix conflicts.
      const presetMatches = preset => Object.keys(preset).every(action => {
        const keys = settings.sequences[action];
        return Array.isArray(keys) && (!keys.length || JSON.stringify(keys) === JSON.stringify(preset[action]));
      }) && Object.entries(settings.sequences).every(([action, keys]) => Object.hasOwn(preset, action) ||
        Array.isArray(keys) && (!keys.length || JSON.stringify(keys) === JSON.stringify(defaults.sequences[action])));
      if (presetMatches(legacySequences) || presetMatches(previousSequences)) {
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
    for (const action of ["home", "guide", "toggleGuide", "restorePlayback", "browser",
      "focusMode", "focusInput", "browserClose"]) {
      if (Object.hasOwn(settings.bindings, action)) continue;
      const shortcut = defaults.bindings[action];
      const used = [...Object.values(settings.bindings), ...Object.values(settings.doubles || {})];
      // The browser entry is allowed to share the confirm key; everything else stays unbound when
      // its default is already taken.
      const shared = action === "browser" && shortcut === settings.bindings.confirm;
      settings.bindings[action] = used.includes(shortcut) && !shared ? "" : shortcut;
    }
    // Shorts doubles were added later. Keep existing remotes working and leave a default unbound
    // when it would collide with another double on the same page or a non-directional single key.
    for (const action of [...DOUBLE_ACTIONS, ...SHORTS_DOUBLE_ACTIONS]) {
      if (Object.hasOwn(settings.doubles, action)) continue;
      const shortcut = defaults.doubles[action];
      const group = SHORTS_DOUBLE_ACTIONS.includes(action) ? SHORTS_DOUBLE_ACTIONS : DOUBLE_ACTIONS;
      const used = group.filter(name => Object.hasOwn(settings.doubles, name)).map(name => settings.doubles[name]);
      const single = shortcut && Object.keys(ACTIONS).find(name => settings.bindings[name] === shortcut);
      const directional = single && ["up", "down", "left", "right"].includes(single);
      settings.doubles[action] = shortcut && used.includes(shortcut) || single && !directional ? "" : shortcut;
    }
    if (!Object.hasOwn(settings, "sequences")) {
      settings.sequences = cloneDefaults().sequences;
      // Old remotes may use an arrow as Back. Keep that mapping and avoid creating reserved sequences.
      for (const action of Object.keys(SEQUENCE_ACTIONS)) {
        if (settings.sequences[action].includes(settings.bindings.back)) settings.sequences[action] = [];
      }
    }
    // Playback-page sequence maps were added later. Seed each one on upgrade and never overwrite
    // existing entries; a command whose preset conflicts with the current Back key stays disabled.
    function seedSequenceMap(key, catalog) {
      const target = settings[key] = normalizeGroup(value[key]);
      // An arrow used as Back makes any sequence containing it unreachable; disable just those.
      for (const [action, keys] of Object.entries(target)) {
        if (Array.isArray(keys) && keys.includes(settings.bindings.back)) target[action] = [];
      }
      for (const action of Object.keys(catalog)) {
        if (Object.hasOwn(target, action)) continue;
        const keys = defaults[key][action];
        const conflict = keys.includes(settings.bindings.back) || Object.values(target).some(other =>
          Array.isArray(other) && other.length && (keys.every((key, i) => other[i] === key) || other.every((key, i) => keys[i] === key)));
        target[action] = conflict ? [] : [...keys];
      }
      return target;
    }
    seedSequenceMap("douyinSequences", DOUYIN_SEQUENCE_ACTIONS);
    seedSequenceMap("bilibiliSequences", VIDEO_SEQUENCE_ACTIONS);
    seedSequenceMap("youkuSequences", VIDEO_SEQUENCE_ACTIONS);
    return validate(settings) ? cloneDefaults() : JSON.parse(JSON.stringify(settings));
  }
  function resolve(settings, value) { return Object.keys(ACTIONS).find((action) => settings.bindings[action] === value && value) || null; }
  function createMatcher() {
    let previous = null;
    return {
      reset() { previous = null; },
      match(event, settings, region, page = "watch") {
        const value = chord(event);
        let action = resolve(settings, value);
        const shorts = page === "shorts";
        const doubles = shorts ? SHORTS_DOUBLE_ACTIONS : DOUBLE_ACTIONS;
        const doubleRegion = region === "player" || (shorts && region === "shortsComments");
        // ↑↓ browse the comment list; a quick second tap must not like the video behind it.
        const doubleAction = doubleRegion && doubles.find((name) =>
          settings.doubles[name] === value && value && !(shorts && region === "shortsComments" && name === "shortsLike"));
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
  // A press-and-release tap count. Unlike createMatcher() this is not region bound: it drives
  // global mode entry, ignores held keys and restarts when taps fall outside the interval.
  function createTapCounter() {
    let pending = null;
    return {
      reset() { pending = null; },
      press(event, interval) {
        if (event.repeat) return 0;
        const time = Number(event.timeStamp) || 0;
        pending = pending !== null && time >= pending.time && time - pending.time <= interval
          ? { count: pending.count + 1, time } : { count: 1, time };
        return pending.count;
      },
      get count() { return pending ? pending.count : 0; },
      get waiting() { return pending !== null; }
    };
  }
  const FAVORITES_KEY = "remoteFavorites";
  const SYSTEM_MAP_KEY = "remoteSystemMap";
  const SYSTEM_LIMITS = { profiles: 8, bindings: 32 };
  // One-click profiles for the Windows helper. Targets follow each app's own shortcuts and stay
  // editable, because vendors rename them between versions.
  const SYSTEM_PRESETS = [{
    id: "douyin", label: "抖音电脑版",
    profile: {
      name: "抖音电脑版", process: "douyin.exe", title: "", enabled: true,
      bindings: [
        { source: "Enter", target: "Space" },
        { source: "Home", target: "KeyZ" },
        { source: "PageUp", target: "ArrowUp" },
        { source: "PageDown", target: "ArrowDown" }
      ]
    }
  }];
  const SYSTEM_MODIFIERS = ["Ctrl", "Alt", "Shift", "Meta"];
  // KeyboardEvent.code names understood by the Windows helper. Keep this list in sync with
  // VkFromCode() in native/RemoteKeysBridge.ps1.
  const SYSTEM_KEYS = [
    "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter", "Escape", "Space", "Tab",
    "Backspace", "Delete", "Insert", "Home", "End", "PageUp", "PageDown",
    ...Array.from({ length: 26 }, (_, i) => `Key${String.fromCharCode(65 + i)}`),
    ...Array.from({ length: 10 }, (_, i) => `Digit${i}`),
    ...Array.from({ length: 24 }, (_, i) => `F${i + 1}`),
    "Backquote", "Minus", "Equal", "BracketLeft", "BracketRight", "Backslash",
    "Semicolon", "Quote", "Comma", "Period", "Slash",
    "CapsLock", "NumLock", "ScrollLock", "PrintScreen", "Pause",
    ...Array.from({ length: 10 }, (_, i) => `Numpad${i}`),
    "NumpadMultiply", "NumpadAdd", "NumpadSubtract", "NumpadDecimal", "NumpadDivide",
    "AudioVolumeMute", "AudioVolumeDown", "AudioVolumeUp",
    "MediaTrackNext", "MediaTrackPrevious", "MediaStop", "MediaPlayPause",
    "BrowserBack", "BrowserForward", "BrowserRefresh", "BrowserStop",
    "BrowserSearch", "BrowserFavorites", "BrowserHome"
  ];
  const SYSTEM_KEY_LOOKUP = new Map(SYSTEM_KEYS.map(key => [key.toLowerCase(), key]));
  const SYSTEM_ALIASES = {
    return: "Enter", enter: "Enter", esc: "Escape", spacebar: "Space",
    pgup: "PageUp", pgdn: "PageDown", del: "Delete", ins: "Insert",
    up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight",
    "↑": "ArrowUp", "↓": "ArrowDown", "←": "ArrowLeft", "→": "ArrowRight",
    control: "Ctrl", ctrl: "Ctrl", alt: "Alt", option: "Alt", shift: "Shift",
    win: "Meta", windows: "Meta", meta: "Meta", cmd: "Meta", super: "Meta",
    volumeup: "AudioVolumeUp", volumedown: "AudioVolumeDown", volumemute: "AudioVolumeMute",
    mute: "AudioVolumeMute", playpause: "MediaPlayPause", nexttrack: "MediaTrackNext",
    prevtrack: "MediaTrackPrevious", previous: "MediaTrackPrevious", next: "MediaTrackNext", stop: "MediaStop"
  };
  const SYSTEM_LABELS = {
    Space: "空格", Backspace: "退格", Delete: "Delete", Insert: "Insert", Home: "Home", End: "End",
    PageUp: "Page Up", PageDown: "Page Down", CapsLock: "Caps Lock", NumLock: "Num Lock",
    ScrollLock: "Scroll Lock", PrintScreen: "Print Screen", Pause: "Pause",
    Backquote: "`", Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]",
    Backslash: "\\", Semicolon: ";", Quote: "'", Comma: ",", Period: ".", Slash: "/",
    AudioVolumeMute: "音量静音", AudioVolumeDown: "音量−", AudioVolumeUp: "音量+",
    MediaTrackNext: "下一曲", MediaTrackPrevious: "上一曲", MediaStop: "停止",
    MediaPlayPause: "播放/暂停", BrowserBack: "浏览器后退", BrowserForward: "浏览器前进",
    BrowserRefresh: "刷新", BrowserStop: "停止加载", BrowserSearch: "浏览器搜索",
    BrowserFavorites: "收藏夹", BrowserHome: "浏览器主页",
    NumpadMultiply: "小键盘 *", NumpadAdd: "小键盘 +", NumpadSubtract: "小键盘 −",
    NumpadDecimal: "小键盘 .", NumpadDivide: "小键盘 /"
  };
  const BROWSER_GROUPS = [
    { id: "common", title: "常用", items: [
      { id: "previousRecent", title: "返回上个标签" },
      { id: "googleSearch", title: "谷歌搜索", hint: "输入关键词" },
      { id: "scroll", title: "滚动网页" },
      { id: "input", title: "选择输入框" }, { id: "focus", title: "网页焦点模式" },
      { id: "restore", title: "恢复上次关闭" }] },
    { id: "sites", title: "网站", items: [] },
    { id: "tabs", title: "标签", items: [] },
    { id: "page", title: "页面", items: [
      { id: "scroll", title: "滚动网页" }, { id: "scrollTop", title: "回到顶部" },
      { id: "scrollBottom", title: "到底部" }, { id: "reload", title: "刷新当前页面" },
      { id: "close", title: "关闭当前标签页" }] }
  ];
  function safeWebUrl(value) {
    if (typeof value !== "string" || value.length > 4096) return "";
    try {
      const url = new URL(value);
      return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : "";
    } catch (_) { return ""; }
  }
  function safeIconUrl(value) {
    if (typeof value !== "string" || value.length > 2048) return "";
    try {
      const url = new URL(value);
      return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : "";
    } catch (_) { return ""; }
  }
  // Saved page icon first, then the site's conventional /favicon.ico. Callers fall back to a letter badge on load errors.
  function faviconUrl(item) {
    const saved = safeIconUrl(item?.icon);
    if (saved) return saved;
    const page = safeWebUrl(item?.url);
    return page ? `${new URL(page).origin}/favicon.ico` : "";
  }
  function iconLetter(title) {
    return (Array.from(String(title || "").trim())[0] || "•").toUpperCase();
  }
  // With `optional`, nothing is shown (and no space is reserved) until the image has actually loaded.
  function buildIcon(doc, src, title, { optional = false } = {}) {
    const badge = doc.createElement("span");
    badge.setAttribute("aria-hidden", "true");
    badge.className = "fav-icon";
    Object.assign(badge.style, { position: "relative", display: "inline-flex", alignItems: "center", justifyContent: "center",
      flex: "0 0 auto", width: "20px", height: "20px", borderRadius: "5px", overflow: "hidden", boxSizing: "border-box",
      background: "rgba(120,130,150,.2)", color: "inherit", font: "600 11px/1 system-ui,sans-serif" });
    if (!optional) badge.textContent = iconLetter(title);
    else badge.style.display = "none";
    const safe = safeIconUrl(src);
    if (safe) {
      const img = doc.createElement("img");
      img.alt = ""; img.referrerPolicy = "no-referrer"; img.decoding = "async"; img.draggable = false;
      img.src = safe;
      Object.assign(img.style, { position: "absolute", inset: "0", width: "100%", height: "100%", objectFit: "contain", background: "#fff" });
      if (optional) {
        img.addEventListener("load", () => { if (img.naturalWidth > 0) badge.style.display = "inline-flex"; else badge.remove(); });
        img.addEventListener("error", () => badge.remove());
      } else img.addEventListener("error", () => img.remove());
      badge.append(img);
    }
    return badge;
  }
  function normalizeFavorites(value) {
    if (!Array.isArray(value)) return [];
    const result = [], urls = new Set(), ids = new Set();
    for (const item of value) {
      const url = safeWebUrl(item?.url);
      if (!url || urls.has(url)) continue;
      let id = typeof item.id === "string" && /^[a-zA-Z0-9_-]{1,60}$/.test(item.id) ? item.id : `site-${result.length + 1}`;
      let suffix = 0;
      while (ids.has(id)) id = `site-${result.length + 1}-${++suffix}`;
      const title = typeof item.title === "string" ? item.title.trim().slice(0, 80) : "";
      const icon = safeIconUrl(item.icon);
      result.push(icon ? { id, title: title || new URL(url).hostname, url, icon } : { id, title: title || new URL(url).hostname, url });
      urls.add(url); ids.add(id);
      if (result.length === 8) break;
    }
    return result;
  }
  function canonicalSystemToken(value) {
    const text = String(value || "").trim();
    if (!text) return "";
    const named = SYSTEM_KEY_LOOKUP.get(text.toLowerCase()) || SYSTEM_ALIASES[text.toLowerCase()];
    if (named) return named;
    if (/^[a-z]$/i.test(text)) return `Key${text.toUpperCase()}`;
    if (/^\d$/.test(text)) return `Digit${text}`;
    if (/^f([1-9]|1\d|2[0-4])$/i.test(text)) return text.toUpperCase();
    const numpad = /^numpad([0-9])$/i.exec(text);
    if (numpad) return `Numpad${numpad[1]}`;
    const numpadNamed = /^numpad(add|subtract|multiply|divide|decimal)$/i.exec(text);
    if (numpadNamed) return "Numpad" + numpadNamed[1][0].toUpperCase() + numpadNamed[1].slice(1).toLowerCase();
    return "";
  }
  // "ctrl + shift + s" -> "Ctrl+Shift+KeyS"; unknown tokens make the whole chord invalid.
  function normalizeSystemChord(value) {
    if (typeof value !== "string") return "";
    const parts = value.trim().replace(/\s*\+\s*/g, "+").split("+").filter(Boolean);
    if (!parts.length) return "";
    const key = canonicalSystemToken(parts.pop());
    if (!key || SYSTEM_MODIFIERS.includes(key)) return "";
    const mods = [];
    for (const part of parts) {
      const mod = canonicalSystemToken(part);
      if (!SYSTEM_MODIFIERS.includes(mod)) return "";
      if (!mods.includes(mod)) mods.push(mod);
    }
    mods.sort((a, b) => SYSTEM_MODIFIERS.indexOf(a) - SYSTEM_MODIFIERS.indexOf(b));
    return [...mods, key].join("+");
  }
  function validSystemSource(value) {
    const normalized = normalizeSystemChord(value);
    return !!normalized && SYSTEM_KEYS.includes(normalized);
  }
  function validSystemTarget(value) {
    const normalized = normalizeSystemChord(value);
    if (!normalized) return false;
    const parts = normalized.split("+");
    return SYSTEM_KEYS.includes(parts[parts.length - 1]) && parts.slice(0, -1).every(mod => SYSTEM_MODIFIERS.includes(mod));
  }
  function systemLabel(value) {
    const normalized = normalizeSystemChord(value);
    if (!normalized) return String(value || "").trim() || "未录制";
    return normalized.split("+").map(part => SYSTEM_LABELS[part] || label(part)).join(" + ");
  }
  // Returns a fresh copy so callers can assign their own ids without mutating the preset.
  function systemPreset(id) {
    const preset = SYSTEM_PRESETS.find(item => item.id === id);
    return preset ? JSON.parse(JSON.stringify(preset.profile)) : null;
  }
  function normalizeSystemMap(value) {
    const source = value && typeof value === "object" ? value : {};
    const profiles = [], ids = new Set();
    for (const item of (Array.isArray(source.profiles) ? source.profiles : []).slice(0, SYSTEM_LIMITS.profiles)) {
      if (!item || typeof item !== "object") continue;
      let id = typeof item.id === "string" && /^[a-zA-Z0-9_-]{1,60}$/.test(item.id) ? item.id : `system-${profiles.length + 1}`;
      let suffix = 0;
      while (ids.has(id)) id = `system-${profiles.length + 1}-${++suffix}`;
      ids.add(id);
      const bindings = [], bindingIds = new Set();
      for (const row of (Array.isArray(item.bindings) ? item.bindings : []).slice(0, SYSTEM_LIMITS.bindings)) {
        if (!row || typeof row !== "object") continue;
        let bid = typeof row.id === "string" && /^[a-zA-Z0-9_-]{1,60}$/.test(row.id) ? row.id : `keys-${bindings.length + 1}`;
        let rowSuffix = 0;
        while (bindingIds.has(bid)) bid = `keys-${bindings.length + 1}-${++rowSuffix}`;
        bindingIds.add(bid);
        const rawSource = typeof row.source === "string" ? row.source.trim().slice(0, 80) : "";
        const rawTarget = typeof row.target === "string" ? row.target.trim().replace(/\s+/g, " ").slice(0, 80) : "";
        bindings.push({
          id: bid,
          source: validSystemSource(rawSource) ? normalizeSystemChord(rawSource) : rawSource,
          target: validSystemTarget(rawTarget) ? normalizeSystemChord(rawTarget) : rawTarget
        });
      }
      profiles.push({
        id,
        name: typeof item.name === "string" ? item.name.trim().slice(0, 80) : "",
        process: typeof item.process === "string" ? item.process.trim().slice(0, 260) : "",
        title: typeof item.title === "string" ? item.title.trim().slice(0, 200) : "",
        enabled: item.enabled !== false,
        bindings
      });
    }
    return { enabled: source.enabled !== false, profiles };
  }
  function validateSystemMap(value) {
    const rawProfiles = value && typeof value === "object" && Array.isArray(value.profiles) ? value.profiles : [];
    if (rawProfiles.length > SYSTEM_LIMITS.profiles) return `最多添加 ${SYSTEM_LIMITS.profiles} 个软件配置`;
    for (const raw of rawProfiles) {
      if (Array.isArray(raw?.bindings) && raw.bindings.length > SYSTEM_LIMITS.bindings) {
        return `每个软件最多 ${SYSTEM_LIMITS.bindings} 条按键映射`;
      }
    }
    const map = normalizeSystemMap(value);
    let globals = 0;
    for (let i = 0; i < map.profiles.length; i++) {
      const profile = map.profiles[i];
      const name = profile.name || profile.process || profile.title || `配置 ${i + 1}`;
      if (!profile.process && !profile.title) {
        globals++;
        if (globals > 1) return "只能有一个全局配置（进程名和窗口标题都留空）";
      }
      if (profile.process && /[*?"<>|\u0000-\u001f]/.test(profile.process)) return `「${name}」的进程名包含无效字符`;
      const sources = new Set();
      for (const row of profile.bindings) {
        const source = normalizeSystemChord(row.source);
        const target = normalizeSystemChord(row.target);
        if (!row.source && !row.target) continue;
        if (!row.source) return `「${name}」有一行缺少遥控按键`;
        if (!row.target) return `「${name}」有一行缺少目标快捷键`;
        if (!validSystemSource(source)) return `「${name}」的遥控按键「${systemLabel(row.source)}」不受支持`;
        if (!validSystemTarget(target)) return `「${name}」的目标快捷键「${row.target}」不受支持`;
        if (source === target) return `「${name}」中的 ${systemLabel(source)} 不能映射到自身`;
        if (sources.has(source)) return `「${name}」中遥控按键重复：${systemLabel(source)}`;
        sources.add(source);
      }
    }
    return "";
  }
  function systemMapConfig(value) {
    const map = normalizeSystemMap(value);
    return {
      version: 1,
      generatedAt: new Date().toISOString(),
      enabled: map.enabled,
      profiles: map.profiles.filter(profile => profile.enabled).map(profile => ({
        name: profile.name,
        process: profile.process,
        title: profile.title,
        bindings: profile.bindings
          .map(row => ({ source: normalizeSystemChord(row.source), target: normalizeSystemChord(row.target) }))
          .filter(row => row.source && row.target)
      })).filter(profile => profile.bindings.length > 0)
    };
  }
  function systemMapConfigJson(value) {
    return JSON.stringify(systemMapConfig(value), null, 2);
  }
  return { ACTIONS, DOUBLE_ACTIONS, SHORTS_DOUBLE_ACTIONS, DOUBLE_LABELS, SEQUENCE_ACTIONS, SEQUENCE_GROUPS,
    DOUYIN_SEQUENCE_ACTIONS, DOUYIN_SEQUENCE_GROUPS, VIDEO_SEQUENCE_ACTIONS, VIDEO_SEQUENCE_GROUPS, BROWSER_GROUPS, FAVORITES_KEY,
    SYSTEM_MAP_KEY, SYSTEM_LIMITS, SYSTEM_KEYS, SYSTEM_MODIFIERS, SYSTEM_LABELS, SYSTEM_PRESETS,
    safeWebUrl, safeIconUrl, faviconUrl, iconLetter, buildIcon, normalizeFavorites, cloneDefaults, chord, label, validate, normalize,
    resolve, createMatcher, sequenceCandidates, douyinSequenceCandidates, videoSequenceCandidates, createTapCounter,
    normalizeSystemChord, validSystemSource, validSystemTarget, systemLabel, systemPreset, normalizeSystemMap, validateSystemMap,
    systemMapConfig, systemMapConfigJson };
});
