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
