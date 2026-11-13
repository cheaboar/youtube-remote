const test = require("node:test");
const assert = require("node:assert/strict");
const R = require("../remote.js");
const event = (key, timeStamp, extra = {}) => ({ key, code: key, timeStamp, repeat: false, ...extra });
test("default mappings are valid and normalize physical modifier chords", () => {
  assert.equal(R.validate(R.cloneDefaults()), "");
  assert.equal(R.chord(event("ß", 0, { code: "KeyS", altKey: true, shiftKey: true })), "Alt+Shift+KeyS");
  assert.equal(R.chord(event("Enter", 0, { code: "NumpadEnter" })), "Enter");
  assert.equal(R.chord(event("s", 0, { code: "" })), "KeyS");
});
test("Return and keypad variants normalize to Enter, including missing or unidentified codes", () => {
  for (const fields of [
    { key: "Return", code: "Return" }, { key: "Return", code: "" },
    { key: "Return", code: "Unidentified" }, { key: "Enter", code: "Unidentified" },
    { key: "Unidentified", code: "Enter" }, { key: "Enter", code: "NumpadEnter" },
    { key: "Unidentified", code: "", keyCode: 13 }
  ]) assert.equal(R.chord(fields), "Enter", JSON.stringify(fields));
  assert.equal(R.chord({ key: "Return", code: "Return", altKey: true }), "Alt+Enter");
  assert.equal(R.chord({ key: "Process", code: "Enter", keyCode: 229 }), "");
});
test("stored Return bindings and sequence steps migrate without resetting custom mappings", () => {
  const settings = R.cloneDefaults();
  settings.bindings.confirm = "Return";
  settings.bindings.search = "F8";
  settings.sequences.home = ["Return", "ArrowUp"];
  const normalized = R.normalize(settings);
  assert.equal(normalized.bindings.confirm, "Enter");
  assert.equal(normalized.bindings.search, "F8");
  assert.deepEqual(normalized.sequences.home, ["Enter", "ArrowUp"]);
  assert.equal(settings.bindings.confirm, "Return");
  assert.equal(settings.sequences.home[0], "Return");
});
test("conflicting mappings and destructive single/double overlaps are rejected", () => {
  const settings = R.cloneDefaults();
  settings.bindings.search = "Enter";
  assert.match(R.validate(settings), /同一个按键/);
  settings.bindings.search = "F8";
  settings.doubles.search = "Escape";
  assert.match(R.validate(settings), /方向操作共用/);
});
test("adding home preserves existing remote settings and occupied shortcuts", () => {
  const legacy = R.cloneDefaults();
  delete legacy.bindings.home;
  legacy.bindings.search = "F8";
  legacy.enabled = false;
  legacy.doubleInterval = 600;
  const migrated = R.normalize(legacy);
  assert.equal(migrated.bindings.home, "Alt+Shift+KeyH");
  assert.equal(migrated.bindings.search, "F8");
  assert.equal(migrated.enabled, false);
  assert.equal(migrated.doubleInterval, 600);
  assert.equal(legacy.bindings.home, undefined);
  legacy.bindings.search = "Alt+Shift+KeyH";
  assert.equal(R.normalize(legacy).bindings.home, "");
  assert.equal(R.normalize(legacy).bindings.search, "Alt+Shift+KeyH");
  legacy.bindings.search = "F8";
  legacy.doubles.search = "Alt+Shift+KeyH";
  assert.equal(R.normalize(legacy).bindings.home, "");
  assert.equal(R.normalize(legacy).doubles.search, "Alt+Shift+KeyH");
});
test("the browser entry shares the confirm key and migrates without resetting settings", () => {
  const defaults = R.cloneDefaults();
  assert.equal(defaults.bindings.browser, "Enter");
  assert.equal(defaults.bindings.confirm, "Enter");
  assert.equal(R.validate(defaults), "");
  // Content scripts keep resolving Enter to the confirm action; browser.js owns the gesture.
  assert.equal(R.resolve(defaults, "Enter"), "confirm");

  const legacy = R.cloneDefaults();
  delete legacy.bindings.browser;
  legacy.bindings.search = "F8";
  legacy.enabled = false;
  const migrated = R.normalize(legacy);
  assert.equal(migrated.bindings.browser, "Enter");
  assert.equal(migrated.bindings.search, "F8");
  assert.equal(migrated.enabled, false);
  assert.equal(legacy.bindings.browser, undefined);
  // An occupied Enter keeps the old mapping and leaves the new entry unbound.
  legacy.bindings.confirm = "F13";
  legacy.bindings.search = "Enter";
  assert.equal(R.normalize(legacy).bindings.browser, "");
  assert.equal(R.normalize(legacy).bindings.search, "Enter");
  legacy.bindings.search = "F8";
  legacy.doubles.search = "Enter";
  assert.equal(R.normalize(legacy).bindings.browser, "");
  assert.equal(R.normalize(legacy).doubles.search, "Enter");
  // Explicitly cleared or customised entries survive and migration stays idempotent.
  legacy.doubles.search = "";
  legacy.bindings.browser = "";
  assert.equal(R.normalize(legacy).bindings.browser, "");
  legacy.bindings.browser = "F9";
  const custom = R.normalize(legacy);
  assert.equal(custom.bindings.browser, "F9");
  assert.deepEqual(R.normalize(custom), custom);
  // Sharing the confirm key is allowed; sharing any other binding is not.
  legacy.bindings.browser = "Enter";
  legacy.bindings.confirm = "Enter";
  assert.equal(R.validate(legacy), "");
  legacy.bindings.search = "Enter";
  assert.match(R.validate(legacy), /同一个按键/);
  legacy.bindings.search = "F8";
  legacy.bindings.back = "Enter";
  assert.match(R.validate(legacy), /同一个按键/);
});
test("browser page controls need no keyboard key but stay recordable", () => {
  const defaults = R.cloneDefaults();
  assert.equal(defaults.bindings.focusMode, "");
  assert.equal(defaults.bindings.focusInput, "");
  assert.equal(defaults.bindings.browserClose, "");
  assert.equal(R.validate(defaults), "");
  // The remote uses the browser mode's action list (arrows + confirm); Tab, Backspace and
  // Alt+Shift+I would only work on a keyboard, so they must not be grabbed by default.
  assert.equal(R.resolve(defaults, "Tab"), null);
  assert.equal(R.resolve(defaults, "Backspace"), null);
  assert.equal(R.resolve(defaults, "Alt+Shift+KeyI"), null);
  // Page controls are browser-mode actions, not entries in the YouTube command panel.
  assert.equal(R.SEQUENCE_ACTIONS.focusMode, undefined);
  assert.equal(R.SEQUENCE_ACTIONS.browserClose, undefined);

  const legacy = R.cloneDefaults();
  for (const action of ["focusMode", "focusInput", "browserClose"]) delete legacy.bindings[action];
  legacy.bindings.search = "F8";
  legacy.enabled = false;
  legacy.doubleInterval = 650;
  const migrated = R.normalize(legacy);
  assert.equal(migrated.bindings.focusMode, "");
  assert.equal(migrated.bindings.focusInput, "");
  assert.equal(migrated.bindings.browserClose, "");
  assert.equal(migrated.bindings.search, "F8");
  assert.equal(migrated.enabled, false);
  assert.equal(migrated.doubleInterval, 650);
  assert.equal(legacy.bindings.focusMode, undefined);
  assert.deepEqual(R.normalize(migrated), migrated);

  // A remote with extra buttons (or a keyboard) can still record direct shortcuts.
  const custom = R.cloneDefaults();
  custom.bindings.focusMode = "Tab";
  custom.bindings.focusInput = "Alt+Shift+KeyI";
  custom.bindings.browserClose = "Backspace";
  assert.equal(R.resolve(custom, "Tab"), "focusMode");
  assert.equal(R.resolve(custom, "Backspace"), "browserClose");
  assert.equal(R.resolve(custom, "Alt+Shift+KeyI"), "focusInput");
  assert.equal(R.validate(custom), "");
  assert.deepEqual(R.normalize(custom), custom);

  // The duplicate check still applies once a key is recorded.
  const conflict = R.cloneDefaults();
  conflict.bindings.search = "Tab";
  conflict.bindings.focusMode = "Tab";
  assert.match(R.validate(conflict), /同一个按键/);
  conflict.bindings.focusMode = "Backspace";
  assert.equal(R.validate(conflict), "");
});
test("favorites normalize independently, reject unsafe URLs and keep stable IDs", () => {
  assert.equal(R.safeWebUrl("javascript:alert(1)"), "");
  assert.equal(R.safeWebUrl("https://user:pass@example.com/"), "");
  assert.equal(R.safeWebUrl("file:///tmp/a"), "");
  assert.equal(R.safeWebUrl("https://EXAMPLE.com"), "https://example.com/");
  const items = R.normalizeFavorites([
    { id: "a", title: " A ", url: "https://example.com" },
    { id: "b", title: "duplicate", url: "https://example.com/" },
    { id: "a", title: "Query", url: "https://example.com/?q=1#result" },
    { url: "javascript:alert(1)" }, null
  ]);
  assert.equal(items.length, 2);
  assert.equal(items[0].title, "A");
  assert.notEqual(items[0].id, items[1].id);
  assert.deepEqual(R.normalizeFavorites(items), items);
  assert.equal(R.normalizeFavorites(Array.from({ length: 20 }, (_, i) =>
    ({ id: `id-${i}`, url: `https://example.com/${i}` }))).length, 8);
  assert.deepEqual(R.normalizeFavorites({}), []);
  assert.equal(new Set(R.BROWSER_GROUPS.map(g => g.id)).size, 4);
});

test("tap counting ignores held keys, restarts after the interval and reaches three taps", () => {
  const tap = R.createTapCounter();
  assert.equal(tap.press(event("Enter", 0), 400), 1);
  assert.equal(tap.count, 1);
  assert.equal(tap.press(event("Enter", 120, { repeat: true }), 400), 0);
  assert.equal(tap.count, 1);
  assert.equal(tap.press(event("Enter", 300), 400), 2);
  assert.equal(tap.press(event("Enter", 500), 400), 3);
  tap.reset();
  assert.equal(tap.count, 0);
  assert.equal(tap.press(event("Enter", 800), 400), 1);
  assert.equal(tap.press(event("Enter", 1200), 400), 2);
  assert.equal(tap.press(event("Enter", 1700), 400), 1);
  assert.equal(tap.press(event("Enter", 1701, { repeat: true }), 400), 0);
});
test("double taps only run in player region and repeated keydowns cannot confirm", () => {
  const matcher = R.createMatcher(), settings = R.cloneDefaults();
  assert.equal(matcher.match(event("ArrowDown", 0), settings, "player"), "down");
  assert.equal(matcher.match(event("ArrowDown", 150), settings, "player"), "sidebar");
  assert.equal(matcher.match(event("ArrowDown", 200), settings, "sidebar"), "down");
  assert.equal(matcher.match(event("ArrowDown", 250), settings, "sidebar"), "down");
  assert.equal(matcher.match(event("Enter", 300, { repeat: true }), settings, "player"), null);
});
test("other keys and reset break a double tap sequence", () => {
  const matcher = R.createMatcher(), settings = R.cloneDefaults();
  matcher.match(event("ArrowUp", 0), settings, "player");
  matcher.match(event("x", 50), settings, "player");
  assert.equal(matcher.match(event("ArrowUp", 100), settings, "player"), "up");
  matcher.reset();
  assert.equal(matcher.match(event("ArrowUp", 150), settings, "player"), "up");
});
test("Shorts doubles stay on the Shorts page and leave list keys alone", () => {
  const matcher = R.createMatcher(), settings = R.cloneDefaults();
  assert.equal(matcher.match(event("ArrowUp", 0), settings, "player", "shorts"), "up");
  assert.equal(matcher.match(event("ArrowUp", 150), settings, "player", "shorts"), "shortsLike");
  matcher.reset();
  assert.equal(matcher.match(event("ArrowRight", 0), settings, "player", "shorts"), "right");
  assert.equal(matcher.match(event("ArrowRight", 150), settings, "player", "shorts"), "shortsComments");
  matcher.reset();
  assert.equal(matcher.match(event("ArrowLeft", 0), settings, "player", "shorts"), "left");
  assert.equal(matcher.match(event("ArrowLeft", 150), settings, "player", "shorts"), "shortsCloseComments");
  matcher.reset();
  // On a watch page the same keys keep their own doubles.
  assert.equal(matcher.match(event("ArrowUp", 0), settings, "player"), "up");
  assert.equal(matcher.match(event("ArrowUp", 150), settings, "player"), "search");
  matcher.reset();
  // Shorts doubles never fire in the list regions.
  assert.equal(matcher.match(event("ArrowUp", 0), settings, "list", "shorts"), "up");
  assert.equal(matcher.match(event("ArrowUp", 150), settings, "list", "shorts"), "up");
});
test("Shorts comment focus keeps ↑↓ scrolling instead of liking", () => {
  const matcher = R.createMatcher(), settings = R.cloneDefaults();
  assert.equal(matcher.match(event("ArrowUp", 0), settings, "shortsComments", "shorts"), "up");
  assert.equal(matcher.match(event("ArrowUp", 150), settings, "shortsComments", "shorts"), "up");
  matcher.reset();
  // ← still closes the panel with a double tap.
  assert.equal(matcher.match(event("ArrowLeft", 0), settings, "shortsComments", "shorts"), "left");
  assert.equal(matcher.match(event("ArrowLeft", 150), settings, "shortsComments", "shorts"), "shortsCloseComments");
});
test("Shorts doubles migrate without resetting existing settings", () => {
  const legacy = R.cloneDefaults();
  for (const action of R.SHORTS_DOUBLE_ACTIONS) delete legacy.doubles[action];
  legacy.doubles.search = "KeyZ";
  const migrated = R.normalize(legacy);
  assert.equal(migrated.doubles.search, "KeyZ");
  assert.equal(migrated.doubles.shortsComments, "ArrowRight");
  assert.equal(migrated.doubles.shortsCloseComments, "ArrowLeft");
  assert.equal(migrated.doubles.shortsLike, "ArrowUp");
  // A default whose single key belongs to a non-directional action stays unbound.
  delete legacy.doubles.shortsComments;
  legacy.bindings.right = "KeyR";
  legacy.bindings.search = "ArrowRight";
  assert.equal(R.normalize(legacy).doubles.shortsComments, "");
});
test("Shorts double validation rejects duplicates and non-directional singles", () => {
  const settings = R.cloneDefaults();
  settings.doubles.shortsLike = settings.doubles.shortsComments;
  assert.match(R.validate(settings), /同一个按键/);
  const other = R.cloneDefaults();
  other.doubles.shortsComments = "Enter";
  assert.match(R.validate(other), /方向操作共用/);
});

test("sequence candidates filter by ordered prefix and only complete at an exact match", () => {
  const { sequences } = R.cloneDefaults();
  assert.equal(R.sequenceCandidates(sequences, []).candidates.length, 17);
  assert.ok(Object.values(sequences).every(keys => ["ArrowLeft", "ArrowRight"].includes(keys[0])));
  const partial = R.sequenceCandidates(sequences, ["ArrowLeft", "ArrowDown"]);
  assert.deepEqual(partial.candidates.map(item => item.action), ["mute", "captions", "theater", "playerSettings"]);
  assert.equal(partial.action, null);
  assert.equal(R.sequenceCandidates(sequences, ["ArrowLeft", "ArrowRight", "ArrowRight", "ArrowRight"]).action, "closeTab");
  assert.equal(R.sequenceCandidates(sequences, ["ArrowLeft", "ArrowRight", "ArrowDown"]).action, "toggleGuide");
  assert.equal(R.sequenceCandidates(sequences, ["ArrowRight", "ArrowDown"]).action, "sidebar");
  assert.equal(R.sequenceCandidates(sequences, ["ArrowLeft", "ArrowDown", "ArrowUp"]).action, "theater");
  assert.equal(R.sequenceCandidates(sequences, ["KeyZ"]).candidates.length, 0);
});

test("sequence validation rejects ambiguous prefixes, reserved keys and invalid lengths", () => {
  const settings = R.cloneDefaults();
  settings.sequences.home = [...settings.sequences.closeTab];
  assert.match(R.validate(settings), /重复或前缀/);
  settings.sequences.home = ["ArrowLeft", "ArrowRight", "ArrowRight"];
  assert.match(R.validate(settings), /重复或前缀/);
  settings.sequences.home = ["Escape", "ArrowUp"];
  assert.match(R.validate(settings), /返回键/);
  settings.bindings.back = "F9";
  settings.sequences.home = ["F9", "ArrowUp"];
  assert.match(R.validate(settings), /返回键/);
  settings.sequences.home = ["Ctrl+KeyW", "ArrowUp"];
  assert.match(R.validate(settings), /系统保留/);
  settings.sequences.home = ["F7"];
  assert.match(R.validate(settings), /2–4/);
  settings.sequences.home = ["F7", "Enter", "ArrowUp", "ArrowRight"];
  assert.equal(R.validate(settings), "");
  for (const key of ["sequences", "douyinSequences", "bilibiliSequences", "youkuSequences"]) {
    for (const action of Object.keys(settings[key])) settings[key][action] = [];
  }
  assert.match(R.validate(settings), /至少保留/);
});

test("Douyin sequences start with left/right, filter by leftmost prefix and end on an exact match", () => {
  const { douyinSequences } = R.cloneDefaults();
  assert.equal(Object.keys(R.DOUYIN_SEQUENCE_ACTIONS).length, 20);
  assert.equal(R.douyinSequenceCandidates(douyinSequences, []).candidates.length, 20);
  assert.ok(Object.values(douyinSequences).every(keys => ["ArrowLeft", "ArrowRight"].includes(keys[0])));
  const rightUp = R.douyinSequenceCandidates(douyinSequences, ["ArrowRight", "ArrowUp"]);
  assert.deepEqual(rightUp.candidates.map(item => item.action), ["fullscreen", "pageFullscreen", "like", "collect"]);
  assert.equal(rightUp.action, null);
  assert.equal(R.douyinSequenceCandidates(douyinSequences, ["ArrowRight", "ArrowUp", "ArrowUp"]).action, "like");
  assert.equal(R.douyinSequenceCandidates(douyinSequences, ["ArrowLeft", "ArrowRight", "ArrowDown"]).action, "scrollTop");
  assert.equal(R.douyinSequenceCandidates(douyinSequences, ["ArrowLeft", "ArrowDown", "ArrowUp"]).candidates.length, 0);
  assert.equal(R.douyinSequenceCandidates(douyinSequences, ["KeyZ"]).candidates.length, 0);
  // No default is a prefix of another, so one exact key chain always identifies one command.
  for (const keys of Object.values(douyinSequences)) {
    const result = R.douyinSequenceCandidates(douyinSequences, keys);
    assert.equal(result.action !== null, true);
    assert.equal(result.candidates.filter(item => item.keys.length === keys.length).length, 1);
  }
  // The YouTube namespace is unaffected by the Douyin tree.
  assert.equal(R.sequenceCandidates(R.cloneDefaults().sequences, ["ArrowRight", "ArrowUp"]).action, "fullscreen");
});

test("Douyin sequence validation keeps conflicts local to the playback page", () => {
  const settings = R.cloneDefaults();
  settings.douyinSequences.like = ["ArrowRight", "ArrowUp"];
  assert.match(R.validate(settings), /重复或前缀/);
  settings.douyinSequences.like = ["ArrowRight", "ArrowUp", "ArrowUp"];
  settings.douyinSequences.collect = [...settings.douyinSequences.like];
  assert.match(R.validate(settings), /重复或前缀/);
  settings.douyinSequences.collect = ["Escape", "ArrowUp"];
  assert.match(R.validate(settings), /返回键/);
  settings.douyinSequences.collect = ["F7"];
  assert.match(R.validate(settings), /2–4/);
  settings.douyinSequences.collect = ["KeyZ", "ArrowUp"];
  assert.equal(R.validate(settings), "");
  // Sharing a key chain with a YouTube command is fine: they run on different pages.
  settings.sequences.togglePlayback = ["ArrowRight", "ArrowRight"];
  assert.equal(R.validate(settings), "");
  for (const action of Object.keys(settings.sequences)) settings.sequences[action] = [];
  assert.equal(R.validate(settings), "");
  for (const action of Object.keys(settings.douyinSequences)) settings.douyinSequences[action] = [];
  assert.equal(R.validate(settings), "");
  for (const key of ["bilibiliSequences", "youkuSequences"]) {
    for (const action of Object.keys(settings[key])) settings[key][action] = [];
  }
  assert.match(R.validate(settings), /至少保留/);
});

test("Bilibili and Youku share a playback catalog while keeping separate sequence maps", () => {
  const { bilibiliSequences, youkuSequences } = R.cloneDefaults();
  assert.equal(Object.keys(R.VIDEO_SEQUENCE_ACTIONS).length, 20);
  assert.equal(R.VIDEO_SEQUENCE_GROUPS.length, 4);
  for (const map of [bilibiliSequences, youkuSequences]) {
    assert.equal(Object.keys(map).length, 20);
    assert.equal(R.videoSequenceCandidates(map, []).candidates.length, 20);
    assert.ok(Object.values(map).every(keys => ["ArrowLeft", "ArrowRight"].includes(keys[0])));
    assert.equal(R.videoSequenceCandidates(map, ["ArrowRight", "ArrowUp", "ArrowUp"]).action, "like");
    assert.equal(R.videoSequenceCandidates(map, ["ArrowRight", "ArrowDown", "ArrowLeft"]).action, "danmaku");
    assert.equal(R.videoSequenceCandidates(map, ["ArrowRight", "ArrowDown", "ArrowRight"]).action, "nextEpisode");
    assert.equal(R.videoSequenceCandidates(map, ["ArrowLeft", "ArrowRight", "ArrowDown"]).action, "scrollTop");
    assert.equal(R.videoSequenceCandidates(map, ["ArrowLeft", "ArrowDown", "ArrowUp"]).candidates.length, 0);
    assert.equal(R.videoSequenceCandidates(map, ["KeyZ"]).candidates.length, 0);
    for (const keys of Object.values(map)) {
      const result = R.videoSequenceCandidates(map, keys);
      assert.equal(result.action !== null, true);
      assert.equal(result.candidates.filter(item => item.keys.length === keys.length).length, 1);
    }
  }
  assert.deepEqual(bilibiliSequences, youkuSequences);

  const settings = R.cloneDefaults();
  // Editing one site's map cannot disturb the other site's defaults.
  settings.bilibiliSequences.like = ["ArrowRight", "ArrowUp"];
  assert.match(R.validate(settings), /重复或前缀/);
  settings.bilibiliSequences.like = ["ArrowRight", "ArrowUp", "ArrowUp"];
  assert.equal(R.validate(settings), "");
  assert.equal(R.videoSequenceCandidates(settings.bilibiliSequences, ["ArrowRight", "ArrowUp"]).action, null);
  assert.equal(R.videoSequenceCandidates(settings.youkuSequences, ["ArrowRight", "ArrowUp", "ArrowUp"]).action, "like");
  settings.youkuSequences.like = ["Escape", "ArrowUp"];
  assert.match(R.validate(settings), /返回键/);
  settings.youkuSequences.like = ["F7"];
  assert.match(R.validate(settings), /2–4/);
  settings.youkuSequences.like = ["KeyZ", "ArrowUp"];
  assert.equal(R.validate(settings), "");
});

test("old settings gain Bilibili and Youku sequences and drop Back from every playback map", () => {
  const legacy = R.cloneDefaults();
  delete legacy.bilibiliSequences;
  delete legacy.youkuSequences;
  const migrated = R.normalize(legacy);
  assert.deepEqual(migrated.bilibiliSequences, R.cloneDefaults().bilibiliSequences);
  assert.deepEqual(migrated.youkuSequences, R.cloneDefaults().youkuSequences);
  assert.equal(R.validate(migrated), "");

  const custom = R.cloneDefaults();
  custom.youkuSequences.rail = ["ArrowRight", "ArrowDown", "KeyZ"];
  const kept = R.normalize(custom);
  assert.deepEqual(kept.youkuSequences.rail, ["ArrowRight", "ArrowDown", "KeyZ"]);
  assert.deepEqual(kept.bilibiliSequences, R.cloneDefaults().bilibiliSequences);
  assert.deepEqual(R.normalize(kept), kept);

  const arrowBack = R.cloneDefaults();
  arrowBack.bindings.back = "ArrowDown";
  arrowBack.bindings.down = "F9";
  arrowBack.doubles.sidebar = "";
  delete arrowBack.sequences;
  delete arrowBack.douyinSequences;
  delete arrowBack.bilibiliSequences;
  delete arrowBack.youkuSequences;
  const sanitized = R.normalize(arrowBack);
  for (const key of ["bilibiliSequences", "youkuSequences"]) {
    for (const [action, keys] of Object.entries(sanitized[key])) {
      assert.equal(keys.includes("ArrowDown"), false, `${key}.${action} kept the Back key`);
    }
  }
  assert.equal(R.validate(sanitized), "");
});

test("old settings gain Douyin sequences without resetting custom mappings", () => {
  const legacy = R.cloneDefaults();
  delete legacy.douyinSequences;
  legacy.sequences.home = ["KeyZ", "ArrowUp"];
  const migrated = R.normalize(legacy);
  assert.deepEqual(migrated.douyinSequences, R.cloneDefaults().douyinSequences);
  assert.deepEqual(migrated.sequences.home, ["KeyZ", "ArrowUp"]);
  assert.equal(R.validate(migrated), "");

  const custom = R.cloneDefaults();
  custom.douyinSequences.like = ["ArrowRight", "ArrowDown", "KeyZ"];
  const kept = R.normalize(custom);
  assert.deepEqual(kept.douyinSequences.like, ["ArrowRight", "ArrowDown", "KeyZ"]);
  assert.deepEqual(kept.douyinSequences.rail, R.cloneDefaults().douyinSequences.rail);
  assert.deepEqual(R.normalize(kept), kept);

  // An arrow used as Back must not leave unreachable sequences behind.
  const arrowBack = R.cloneDefaults();
  arrowBack.bindings.back = "ArrowDown";
  arrowBack.bindings.down = "F9";
  arrowBack.doubles.sidebar = "";
  delete arrowBack.sequences;
  delete arrowBack.douyinSequences;
  const sanitized = R.normalize(arrowBack);
  assert.equal(sanitized.bindings.back, "ArrowDown");
  for (const [action, keys] of Object.entries(sanitized.douyinSequences)) {
    assert.equal(keys.includes("ArrowDown"), false, `${action} kept the Back key`);
  }
  assert.equal(R.validate(sanitized), "");
});

test("old settings gain sequences without resetting remote bindings, including an arrow Back key", () => {
  const legacy = R.cloneDefaults();
  delete legacy.sequences;
  legacy.bindings.confirm = "F8";
  legacy.bindings.back = "ArrowDown";
  legacy.bindings.down = "F9";
  legacy.doubles.sidebar = "";
  legacy.enabled = false;
  const migrated = R.normalize(legacy);
  assert.equal(migrated.enabled, false);
  assert.equal(migrated.bindings.confirm, "F8");
  assert.equal(migrated.bindings.back, "ArrowDown");
  assert.deepEqual(migrated.sequences.theater, []);
  assert.equal(R.validate(migrated), "");
  assert.equal(legacy.sequences, undefined);
});

test("old sequence presets upgrade to horizontal starts without resetting remote settings or disabled commands", () => {
  const legacy = R.cloneDefaults();
  legacy.enabled = false; legacy.doubleInterval = 650; legacy.bindings.confirm = "F8";
  legacy.sequences = {
    closeTab: ["ArrowDown", "ArrowRight"], reload: ["ArrowLeft", "ArrowRight"],
    home: ["ArrowUp", "ArrowUp"], search: [], historyBack: ["ArrowDown", "ArrowLeft"],
    togglePlayback: ["ArrowRight", "ArrowRight"], fullscreen: ["ArrowRight", "ArrowUp"], sidebar: ["ArrowRight", "ArrowDown"]
  };
  const migrated = R.normalize(legacy);
  assert.equal(migrated.enabled, false);
  assert.equal(migrated.doubleInterval, 650);
  assert.equal(migrated.bindings.confirm, "F8");
  assert.deepEqual(migrated.sequences.search, []);
  assert.deepEqual(migrated.sequences.closeTab, ["ArrowLeft", "ArrowRight", "ArrowRight", "ArrowRight"]);
  assert.deepEqual(migrated.sequences.mute, ["ArrowLeft", "ArrowDown", "ArrowLeft"]);
  assert.equal(R.validate(migrated), "");
  assert.deepEqual(R.normalize(migrated), migrated);
  assert.equal(legacy.sequences.mute, undefined);
});

test("adding player commands preserves custom sequences and disables conflicting new defaults", () => {
  const custom = R.cloneDefaults();
  for (const action of ["mute", "captions", "theater", "playerSettings"]) delete custom.sequences[action];
  custom.bindings.confirm = "F8";
  custom.sequences.closeTab = ["ArrowLeft", "ArrowDown"];
  custom.sequences.fullscreen = [];
  const migrated = R.normalize(custom);
  assert.equal(migrated.bindings.confirm, "F8");
  assert.deepEqual(migrated.sequences.closeTab, custom.sequences.closeTab);
  assert.deepEqual(migrated.sequences.fullscreen, []);
  for (const action of ["mute", "captions", "theater", "playerSettings"]) assert.deepEqual(migrated.sequences[action], []);
  assert.equal(R.validate(migrated), "");
});

test("adding guide controls preserves legacy mappings, including an occupied guide shortcut", () => {
  const legacy = R.cloneDefaults();
  delete legacy.bindings.guide; delete legacy.sequences.guide;
  delete legacy.bindings.toggleGuide; delete legacy.sequences.toggleGuide;
  for (const action of ["pipComments", "restorePlayback", "scrollTop"]) delete legacy.sequences[action];
  legacy.bindings.confirm = "F8";
  legacy.bindings.search = "Alt+Shift+KeyG";
  legacy.sequences.reload = ["ArrowLeft", "ArrowRight"];
  legacy.sequences.closeTab = ["F5", "F6"];
  const migrated = R.normalize(legacy);
  assert.equal(migrated.bindings.guide, "");
  assert.equal(migrated.bindings.confirm, "F8");
  assert.equal(migrated.bindings.search, "Alt+Shift+KeyG");
  assert.deepEqual(migrated.sequences.guide, []);
  assert.deepEqual(migrated.sequences.reload, legacy.sequences.reload);
  assert.equal(R.validate(migrated), "");
  legacy.bindings.search = "F7";
  assert.equal(R.normalize(legacy).bindings.guide, "Alt+Shift+KeyG");
});

test("adding the guide toggle keeps legacy settings and disables conflicting presets", () => {
  const legacy = R.cloneDefaults();
  delete legacy.bindings.toggleGuide; delete legacy.sequences.toggleGuide;
  legacy.bindings.confirm = "F8";
  legacy.bindings.search = "Alt+Shift+KeyN";
  const migrated = R.normalize(legacy);
  assert.equal(migrated.bindings.toggleGuide, "");
  assert.equal(migrated.bindings.confirm, "F8");
  assert.deepEqual(migrated.sequences.toggleGuide, ["ArrowLeft", "ArrowRight", "ArrowDown"]);
  assert.equal(R.validate(migrated), "");
  legacy.bindings.search = "F7";
  assert.equal(R.normalize(legacy).bindings.toggleGuide, "Alt+Shift+KeyN");
  legacy.sequences.home = ["ArrowLeft", "ArrowRight", "ArrowDown"];
  const conflicting = R.normalize(legacy);
  assert.deepEqual(conflicting.sequences.toggleGuide, []);
  assert.equal(R.validate(conflicting), "");
  assert.equal(R.sequenceCandidates(conflicting.sequences, ["ArrowLeft", "ArrowRight", "ArrowDown"]).action, "home");
});

test("favorite icons keep only safe web URLs and fall back to the site favicon", () => {
  const [kept, dropped] = R.normalizeFavorites([
    { id: "a", title: "A", url: "https://a.example/page?x=1", icon: "https://cdn.example/a.png" },
    { id: "b", title: "B", url: "https://b.example/", icon: "javascript:alert(1)" }
  ]);
  assert.equal(kept.icon, "https://cdn.example/a.png");
  assert.equal("icon" in dropped, false);
  assert.equal(R.faviconUrl(kept), "https://cdn.example/a.png");
  assert.equal(R.faviconUrl(dropped), "https://b.example/favicon.ico");
  assert.equal(R.safeIconUrl("https://user:pw@x.example/i.png"), "");
  assert.equal(R.safeIconUrl("data:image/png;base64,AAAA"), "");
  assert.equal(R.faviconUrl({ url: "ftp://x.example/" }), "");
});

test("system chords normalize aliases, modifier order and media keys", () => {
  assert.equal(R.normalizeSystemChord("ctrl + shift + s"), "Ctrl+Shift+KeyS");
  assert.equal(R.normalizeSystemChord("Shift+Ctrl+ArrowRight"), "Ctrl+Shift+ArrowRight");
  assert.equal(R.normalizeSystemChord("left"), "ArrowLeft");
  assert.equal(R.normalizeSystemChord("↑"), "ArrowUp");
  assert.equal(R.normalizeSystemChord("volumeup"), "AudioVolumeUp");
  assert.equal(R.normalizeSystemChord("Mute"), "AudioVolumeMute");
  assert.equal(R.normalizeSystemChord("numpad5"), "Numpad5");
  assert.equal(R.normalizeSystemChord("f12"), "F12");
  assert.equal(R.normalizeSystemChord("Hyper+KeyA"), "");
  assert.equal(R.normalizeSystemChord("Ctrl+"), "");
  assert.equal(R.normalizeSystemChord("Ctrl"), "");
  assert.equal(R.validSystemSource("left"), true);
  assert.equal(R.validSystemSource("Ctrl+Left"), false);
  assert.equal(R.validSystemTarget("Ctrl+Shift+ArrowRight"), true);
  assert.equal(R.validSystemTarget("Hyper+KeyA"), false);
  assert.equal(R.validSystemTarget("KeyA"), true);
  assert.equal(R.systemLabel("AudioVolumeUp"), "音量+");
  assert.equal(R.systemLabel("Ctrl+ArrowRight"), "Ctrl + →");
});

test("system map normalizes profiles, keeps stable IDs and clamps limits", () => {
  const map = R.normalizeSystemMap({
    profiles: [{
      id: "p1", name: " PotPlayer ", process: " PotPlayerMini64.exe ", title: " 影片 ", enabled: false,
      bindings: [
        { id: "b1", source: "left", target: "ctrl + left" },
        { id: "b1", source: "right", target: "" },
        { source: "Enter", target: "playpause" }
      ]
    }, null]
  });
  assert.equal(map.enabled, true);
  assert.equal(map.profiles.length, 1);
  assert.deepEqual(map.profiles[0], {
    id: "p1", name: "PotPlayer", process: "PotPlayerMini64.exe", title: "影片", enabled: false,
    bindings: [
      { id: "b1", source: "ArrowLeft", target: "Ctrl+ArrowLeft" },
      { id: "keys-2-1", source: "ArrowRight", target: "" },
      { id: "keys-3", source: "Enter", target: "MediaPlayPause" }
    ]
  });
  assert.deepEqual(R.normalizeSystemMap(null), { enabled: true, profiles: [] });
  assert.equal(R.normalizeSystemMap({ profiles: Array.from({ length: 12 }, (_, i) =>
    ({ id: `p-${i}`, bindings: [] })) }).profiles.length, 8);
  assert.equal(R.normalizeSystemMap({ enabled: false, profiles: [] }).enabled, false);
});

test("system map validation rejects incomplete, duplicate and unsupported mappings", () => {
  const valid = { profiles: [{ process: "vlc.exe", bindings: [{ source: "ArrowLeft", target: "Ctrl+ArrowLeft" }] }] };
  assert.equal(R.validateSystemMap(valid), "");
  const row = (source, target) => ({ profiles: [{ process: "vlc.exe", bindings: [{ source, target }] }] });
  assert.match(R.validateSystemMap(row("", "KeyA")), /缺少遥控按键/);
  assert.match(R.validateSystemMap(row("KeyA", "")), /缺少目标快捷键/);
  assert.match(R.validateSystemMap(row("KeyA", "Nope")), /目标快捷键/);
  assert.match(R.validateSystemMap(row("IntlBackslash", "KeyA")), /遥控按键/);
  assert.match(R.validateSystemMap(row("KeyA", "KeyA")), /不能映射到自身/);
  assert.match(R.validateSystemMap(row("Ctrl+KeyA", "KeyB")), /遥控按键/);
  assert.match(R.validateSystemMap({ profiles: [{ process: "vlc.exe", bindings: [
    { source: "ArrowLeft", target: "KeyB" }, { source: "left", target: "KeyC" }] }] }), /遥控按键重复/);
  assert.equal(R.validateSystemMap({ profiles: [{ process: "", title: "", bindings: [] },
    { process: "", title: "", bindings: [] }] }), "只能有一个全局配置（进程名和窗口标题都留空）");
  assert.match(R.validateSystemMap({ profiles: [{ process: "bad*name.exe", bindings: [] }] }), /无效字符/);
  assert.equal(R.validateSystemMap({ profiles: [{ process: "C:\\Program Files\\DAUM\\PotPlayer\\PotPlayerMini64.exe", bindings: [] }] }), "");
  assert.match(R.validateSystemMap({ profiles: Array.from({ length: 9 }, () => ({ bindings: [] })) }), /最多添加 8/);
  // Completely blank rows are ignored while editing.
  assert.equal(R.validateSystemMap(row("", "")), "");
});

test("system presets provide a valid, editable Douyin profile", () => {
  const preset = R.systemPreset("douyin");
  assert.equal(preset.name, "抖音电脑版");
  assert.equal(preset.process, "douyin.exe");
  assert.equal(preset.enabled, true);
  assert.deepEqual(preset.bindings, [
    { source: "Enter", target: "Space" },
    { source: "Home", target: "KeyZ" },
    { source: "PageUp", target: "ArrowUp" },
    { source: "PageDown", target: "ArrowDown" }
  ]);
  assert.equal(R.validateSystemMap({ profiles: [preset] }), "");
  assert.equal(R.systemPreset("unknown"), null);
  // Callers can add ids without mutating the shared preset.
  preset.bindings[0].target = "KeyX";
  preset.name = "changed";
  assert.equal(R.systemPreset("douyin").bindings[0].target, "Space");
  assert.equal(R.systemPreset("douyin").name, "抖音电脑版");
});

test("system map export drops disabled profiles and blank rows", () => {
  const json = R.systemMapConfigJson({ profiles: [
    { name: "VLC", process: "vlc.exe", enabled: true, bindings: [
      { source: "left", target: "ctrl + left" }, { source: "", target: "" }] },
    { name: "Off", process: "off.exe", enabled: false, bindings: [{ source: "Enter", target: "Space" }] }
  ] });
  const config = JSON.parse(json);
  assert.equal(config.version, 1);
  assert.equal(config.enabled, true);
  assert.equal(typeof config.generatedAt, "string");
  assert.deepEqual(config.profiles, [{ name: "VLC", process: "vlc.exe", title: "",
    bindings: [{ source: "ArrowLeft", target: "Ctrl+ArrowLeft" }] }]);
  assert.equal(R.systemMapConfig({ enabled: false, profiles: [] }).enabled, false);
  assert.deepEqual(R.systemMapConfig({ profiles: [{ name: "Empty", process: "empty.exe", bindings: [] }] }).profiles, []);
  assert.match(json, /\n  "profiles"/);
});
