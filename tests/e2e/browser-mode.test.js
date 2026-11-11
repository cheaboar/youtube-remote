const { test, before, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright");
const R = require("../../remote.js");

let context, worker, extensionId, profile, extensionDir, youtubeFixture, siteFixture;
const errors = [];
const root = path.resolve(__dirname, "../..");
const EXTENSION_FILES = ["background.js", "browser.js", "content.js", "content.css", "navigation.js", "remote.js",
  "youtube.js", "options.html", "options.css", "options.js", "popup.html", "popup.css", "popup.js", "manifest.json"];

// The optional host permission cannot be granted from a headless browser prompt, so the suite runs
// the production scripts from a temporary copy whose manifest already grants both web schemes.
// This verifies the authorized runtime, not the native consent dialog.
async function buildExtension() {
  extensionDir = await fs.mkdtemp(path.join(os.tmpdir(), "youtube-browser-ext-"));
  for (const file of EXTENSION_FILES) await fs.copyFile(path.join(root, file), path.join(extensionDir, file));
  await fs.cp(path.join(root, "icons"), path.join(extensionDir, "icons"), { recursive: true });
  const manifest = JSON.parse(await fs.readFile(path.join(root, "manifest.json"), "utf8"));
  manifest.host_permissions = ["http://*/*", "https://*/*"];
  delete manifest.optional_host_permissions;
  await fs.writeFile(path.join(extensionDir, "manifest.json"), JSON.stringify(manifest, null, 2));
}

before(async () => {
  profile = await fs.mkdtemp(path.join(os.tmpdir(), "youtube-browser-e2e-"));
  await buildExtension();
  youtubeFixture = await fs.readFile(path.join(__dirname, "fixture.html"), "utf8");
  siteFixture = await fs.readFile(path.join(__dirname, "site-fixture.html"), "utf8");
  context = await chromium.launchPersistentContext(profile, {
    channel: "chromium", headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
    args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`,
      "--autoplay-policy=no-user-gesture-required"],
    viewport: { width: 1100, height: 720 }
  });
  context.setDefaultTimeout(6000);
  worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  extensionId = new URL(worker.url()).host;
  await context.route("https://www.youtube.com/**", route => route.fulfill({ status: 200, contentType: "text/html", body: youtubeFixture }));
  await context.route("https://remote-fixture.test/**", route => route.fulfill({ status: 200, contentType: "text/html", body: siteFixture }));
  context.on("page", page => page.on("pageerror", error => errors.push(error.message)));
  await fs.mkdir("test-results", { recursive: true });
  // Registration happens asynchronously when the worker starts.
  for (let i = 0; i < 40; i++) {
    const registered = await worker.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts()).length);
    if (registered) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
});
beforeEach(async () => {
  // Let the previous test's tab-close bookkeeping settle before resetting, otherwise a queued
  // handler can write the old session back after the removal.
  await new Promise(resolve => setTimeout(resolve, 120));
  await worker.evaluate(() => chrome.storage.session.remove("remote:browser-mode"));
  await worker.evaluate(settings => chrome.storage.local.set({ remoteSettings: settings }), R.cloneDefaults());
});
after(async () => { await context?.close(); });

const press = (page, key) => page.keyboard.press(key);
const hud = page => page.evaluate(() => {
  const host = document.querySelector("#youtube-remote-browser");
  return host ? { hidden: host.hidden, active: host.dataset.active, phase: host.dataset.phase,
    position: host.dataset.position, total: host.dataset.total, selected: host.dataset.selected } : null;
});
const waitHud = (page, active) => page.waitForFunction(active =>
  document.querySelector("#youtube-remote-browser")?.dataset.active === String(active), active);
const activeTabId = () => worker.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id);
const activeTabTitle = () => worker.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.title);
const mode = () => worker.evaluate(async () => (await chrome.storage.session.get("remote:browser-mode"))["remote:browser-mode"]);
// History traversal replaces the page's execution context often enough that in-page polling races
// with it; reading the URL from the driver is stable.
async function waitPath(page, pathname) {
  for (let i = 0; i < 120; i++) {
    if (new URL(page.url()).pathname === pathname) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`path never became ${pathname}: ${page.url()}`);
}
async function waitActiveTab(predicate) {
  for (let i = 0; i < 60; i++) {
    const id = await activeTabId();
    if (predicate(id)) return id;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error("the active tab did not change");
}
async function waitMode(predicate) {
  for (let i = 0; i < 60; i++) {
    const state = await mode();
    if (predicate(state || {})) return state;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error("browser mode did not reach the expected state");
}
// YouTube already spends the confirm key's double tap on the command panel, so entering there
// needs a third tap; every other site enters on a double tap.
async function enterBrowser(page) {
  const taps = page.url().startsWith("https://www.youtube.com/") ? 3 : 2;
  for (let i = 0; i < taps; i++) await press(page, "Enter");
  await waitHud(page, true);
}
async function youtubePage(url = "/") {
  const page = await context.newPage();
  await page.goto(`https://www.youtube.com${url}`);
  await page.waitForFunction(() => !!document.querySelector("#youtube-remote-status"));
  return page;
}
async function sitePage(url = "/") {
  const page = await context.newPage();
  await page.goto(`https://remote-fixture.test${url}`);
  await page.waitForFunction(() => !!document.querySelector("#heading"));
  return page;
}

test("triple tapping Enter on YouTube enters browser mode without touching the video selection", async () => {
  const page = await youtubePage("/");
  await page.waitForFunction(() => document.querySelector(".youtube-keyboard-selected")?.dataset.video === "v0");
  await enterBrowser(page);
  // The second tap opens the command panel; the third one closes it and takes over instead.
  assert.equal(await page.locator("#youtube-remote-sequences").isVisible(), false);
  assert.equal(await page.evaluate(() => document.querySelector("#youtube-remote-status").hidden), true);
  assert.equal((await hud(page)).phase, "direct");
  await press(page, "Escape");
  await waitHud(page, false);
  await page.waitForFunction(() => document.querySelector("#youtube-remote-status").hidden === false);
  assert.equal(await page.evaluate(() => document.querySelector(".youtube-keyboard-selected")?.dataset.video), "v0");
  await page.close();
});

test("a double Enter on YouTube still opens the command panel instead of the mode", async () => {
  const page = await youtubePage("/");
  await press(page, "Enter");
  await press(page, "Enter");
  await page.locator("#youtube-remote-sequences").waitFor({ state: "visible" });
  await page.waitForTimeout(150);
  assert.equal((await hud(page))?.active ?? "false", "false");
  await press(page, "Escape");
  await page.locator("#youtube-remote-sequences").waitFor({ state: "hidden" });
  await page.close();
});

test("a single Enter does not enter and a held key cannot count as a tap", async () => {
  const page = await sitePage("/");
  await press(page, "Enter");
  await page.waitForTimeout(500);
  assert.equal((await hud(page))?.active ?? "false", "false");
  await page.keyboard.down("Enter");
  await page.waitForTimeout(120);
  await page.keyboard.down("Enter");
  await page.keyboard.up("Enter");
  await page.waitForTimeout(120);
  assert.equal((await hud(page))?.active ?? "false", "false");
  await page.close();
});

test("arrows switch tabs inside the mode and wrap around the window", async () => {
  const first = await youtubePage("/");
  const second = await sitePage("/");
  const third = await sitePage("/one");
  await second.bringToFront();
  await enterBrowser(second);
  const start = await activeTabId();
  await press(second, "ArrowDown");
  const next = await waitActiveTab(id => id !== start);
  assert.equal(await activeTabTitle(), "页面一");

  await third.bringToFront();
  await press(third, "ArrowDown");
  // Browser-internal tabs are skipped, so the wrap lands on the first web tab.
  const ordered = await worker.evaluate(async () => (await chrome.tabs.query({}))
    .filter(tab => /^https?:/i.test(tab.url || "")).sort((a, b) => a.index - b.index).map(tab => tab.id));
  await waitActiveTab(id => id === ordered[0]);

  // The mode follows the window, not the tab that entered it.
  await first.bringToFront();
  await waitHud(first, true);
  await press(first, "Escape");
  await waitHud(first, false);
  assert.equal((await mode()).active, false);
  await Promise.all([first.close(), second.close(), third.close()]);
});

test("switching skips tabs that cannot run the controller", async () => {
  const page = await youtubePage("/");
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/options.html`);
  await page.bringToFront();
  await enterBrowser(page);
  assert.equal(Number((await hud(page)).total), 1);
  const before = await activeTabId();
  await press(page, "ArrowDown");
  await page.waitForTimeout(300);
  // The extension page cannot receive the mode, so the switch is skipped instead of stranded.
  assert.equal(await activeTabId(), before);
  assert.equal((await hud(page)).active, "true");
  await Promise.all([page.close(), options.close()]);
});

test("the mode can be entered again after it was exited", async () => {
  const page = await youtubePage("/");
  await enterBrowser(page);
  await press(page, "Escape");
  await waitHud(page, false);
  // A second session must not be rejected as stale by the revision of the first one.
  await enterBrowser(page);
  assert.equal((await hud(page)).active, "true");
  await press(page, "Escape");
  await waitHud(page, false);
  await page.waitForFunction(() => document.querySelector("#youtube-remote-status").hidden === false);
  await press(page, "ArrowDown");
  await page.waitForFunction(() => document.querySelector(".youtube-keyboard-selected")?.dataset.video === "v3");
  await page.close();
});

test("exiting on the active tab releases the tab that was left behind", async () => {
  const first = await youtubePage("/");
  const second = await youtubePage("/results?search_query=left-behind");
  await second.bringToFront();
  await enterBrowser(second);
  // The mode is window scoped, so the tab that comes to the front joins it.
  await first.bringToFront();
  await waitHud(first, true);
  await press(first, "Escape");
  await waitHud(first, false);
  // The background tab missed that exit, so activation must reset it without another key press.
  await second.bringToFront();
  await waitHud(second, false);
  await second.waitForFunction(() => document.querySelector("#youtube-remote-status").hidden === false);
  await press(second, "ArrowDown");
  await second.waitForFunction(() => document.querySelector(".youtube-keyboard-selected")?.dataset.video !== "v0");
  await Promise.all([first.close(), second.close()]);
});

test("Enter reloads the current tab and the mode survives the navigation", async () => {
  const page = await sitePage("/");
  await enterBrowser(page);
  await page.evaluate(() => { window.beforeReload = true; });
  await Promise.all([page.waitForEvent("load"), press(page, "Enter")]);
  assert.equal(await page.evaluate(() => window.beforeReload), undefined);
  await waitHud(page, true);
  assert.equal((await hud(page)).active, "true");
  await page.close();
});

test("left and right move through the current tab history", async () => {
  const page = await sitePage("/");
  await page.click('a[href="/one"]');
  await page.click('a[href="/two"]');
  assert.equal(new URL(page.url()).pathname, "/two");
  // A focused link keeps Enter's native activation, so page focus must leave it first.
  await page.evaluate(() => document.activeElement?.blur());
  await enterBrowser(page);
  await press(page, "ArrowLeft");
  await waitPath(page, "/one");
  await press(page, "ArrowRight");
  await waitPath(page, "/two");
  await press(page, "ArrowLeft");
  await waitPath(page, "/one");
  await press(page, "ArrowLeft");
  await waitPath(page, "/");
  await waitHud(page, true);
  await page.close();
});

test("a second double tap opens the title list and Escape walks back one level", async () => {
  const first = await youtubePage("/");
  const second = await sitePage("/");
  await second.bringToFront();
  await enterBrowser(second);
  await press(second, "Enter");
  await press(second, "Enter");
  await second.waitForFunction(() => document.querySelector("#youtube-remote-browser")?.dataset.phase === "titles");
  assert.ok(Number((await hud(second)).total) >= 2);
  await press(second, "ArrowDown");
  const selected = (await hud(second)).selected;
  assert.ok(selected);
  await press(second, "Enter");
  await waitMode(state => state.phase === "direct");
  assert.equal(String(await activeTabId()), selected);
  await second.bringToFront();
  await press(second, "Escape");
  await waitHud(second, false);
  await Promise.all([first.close(), second.close()]);
});

test("an open sequence panel keeps Enter for its own commands", async () => {
  const page = await youtubePage("/");
  await press(page, "Enter");
  await press(page, "Enter");
  await page.locator("#youtube-remote-sequences").waitFor({ state: "visible" });
  // Outside the double interval the third press belongs to the panel, not to the entry gesture.
  await page.waitForTimeout(500);
  await press(page, "Enter");
  await page.locator("#youtube-remote-sequences").waitFor({ state: "hidden" });
  await page.waitForTimeout(150);
  assert.equal((await hud(page))?.active ?? "false", "false");
  await page.close();
});

test("the entry binding is configurable and editors keep native keys", async () => {
  const page = await sitePage("/");
  const settings = R.cloneDefaults();
  settings.bindings.browser = "F9";
  await worker.evaluate(value => chrome.storage.local.set({ remoteSettings: value }), settings);
  await page.waitForTimeout(150);
  await press(page, "Enter");
  await press(page, "Enter");
  await page.waitForTimeout(150);
  assert.equal((await hud(page))?.active ?? "false", "false");
  await press(page, "F9");
  await press(page, "F9");
  await waitHud(page, true);
  await press(page, "Escape");
  await waitHud(page, false);

  await page.click("#text");
  await page.evaluate(() => { window.nativeEvents = []; });
  await press(page, "F9");
  await press(page, "F9");
  await page.waitForTimeout(150);
  assert.equal((await hud(page))?.active ?? "false", "false");
  assert.deepEqual(await page.evaluate(() => window.nativeEvents.slice(-2)), ["F9", "F9"]);
  await page.close();
});

test("no uncaught page errors", () => assert.deepEqual(errors, []));
