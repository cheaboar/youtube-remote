const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const R = require("../remote.js");

const root = path.resolve(__dirname, "..");
const helper = path.join(root, "native", "RemoteKeysBridge.ps1");
const skip = process.platform !== "win32" && "Windows PowerShell helper";

function validate(config) {
  return spawnSync("powershell.exe",
    ["-NoProfile", "-Sta", "-ExecutionPolicy", "Bypass", "-File", helper, "-Config", config, "-Validate"],
    { cwd: root, encoding: "utf8", windowsHide: true, timeout: 60000 });
}

test("native helper accepts the example config without installing a hook", { skip }, () => {
  const result = validate(path.join(root, "native", "remote-keys.example.json"));
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("native helper accepts a config exported by the extension", { skip }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "youtube-native-config-"));
  const file = path.join(dir, "remote-keys.json");
  fs.writeFileSync(file, R.systemMapConfigJson({ profiles: [
    { name: "Notepad", process: "notepad.exe", title: "", enabled: true, bindings: [
      { source: "ArrowLeft", target: "Ctrl+ArrowLeft" },
      { source: "ArrowUp", target: "AudioVolumeUp" },
      { source: "Enter", target: "MediaPlayPause" }
    ] }
  ] }), "utf8");
  const result = validate(file);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("native helper fails validation when the config is missing", { skip }, () => {
  const result = validate(path.join(os.tmpdir(), "youtube-remote-missing-config.json"));
  assert.equal(result.status, 1);
});

test("native helper ignores only its own injected keys", () => {
  const script = fs.readFileSync(helper, "utf8");
  assert.match(script, /private static readonly IntPtr InjectedMarker/);
  assert.match(script, /data\.dwExtraInfo != InjectedMarker/);
  assert.match(script, /input\.u\.ki\.dwExtraInfo = InjectedMarker/);
  // Software remotes also send injected events; discarding every LLKHF_INJECTED key breaks them.
  assert.doesNotMatch(script, /\(data\.flags & LLKHF_INJECTED\) == 0/);
});
