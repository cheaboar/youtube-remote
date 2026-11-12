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
  for (const action of Object.keys(settings.sequences)) settings.sequences[action] = [];
  assert.match(R.validate(settings), /至少保留/);
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
