const { test, before, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright");
const R = require("../../remote.js");
let context, worker;
const errors = [];
before(async () => {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), "youtube-guide-e2e-"));
  const fixture = await fs.readFile(path.join(__dirname, "fixture.html"), "utf8");
  const root = path.resolve(__dirname, "../..");
  context = await chromium.launchPersistentContext(profile, {
    channel: "chromium", headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`],
    viewport: { width: 1100, height: 720 }
  });
  context.setDefaultTimeout(6000);
  worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  await context.route("https://www.youtube.com/**", route => route.fulfill({ status: 200, contentType: "text/html", body: fixture }));
  context.on("page", page => page.on("pageerror", error => errors.push(error.message)));
  await fs.mkdir("test-results", { recursive: true });
});
beforeEach(async () => {
  await worker.evaluate(settings => chrome.storage.local.set({ remoteSettings: settings }), R.cloneDefaults());
});
after(async () => { await context?.close(); });
const press = (page, key) => page.keyboard.press(key);
const region = (page, value) => page.waitForFunction(value => document.querySelector("#youtube-remote-status")?.dataset.region === value, value);
const selected = (page, id) => page.waitForFunction(id => document.querySelector(".youtube-keyboard-selected")?.dataset.video === id, id);
const guide = (page, id) => page.waitForFunction(id => document.querySelector(".youtube-keyboard-selected")?.dataset.guide === id, id);
async function pageAt(url = "/") {
  const page = await context.newPage(); await page.goto("https://www.youtube.com" + url);
  await page.waitForSelector("#youtube-remote-status"); return page;
}
async function mode(page) {
  await press(page, "Enter"); await press(page, "Enter");
  await page.locator("#youtube-remote-sequences").waitFor({ state: "visible" });
}

test("home left boundary enters the guide, arrows select navigation, and Right restores the selected video", async () => {
  const page = await pageAt(); await selected(page, "v0");
  await press(page, "ArrowDown"); await selected(page, "v3");
  await press(page, "ArrowLeft"); await region(page, "guide"); await guide(page, "home");
  await press(page, "ArrowUp"); await guide(page, "home");
  await press(page, "ArrowDown"); await guide(page, "shorts");
  await press(page, "ArrowDown"); await guide(page, "subscriptions");
  await page.screenshot({ path: "test-results/left-guide.png" });
  await press(page, "ArrowRight"); await region(page, "list"); await selected(page, "v3");
  await press(page, "ArrowRight"); await selected(page, "v4");
  await page.close();
});

test("guide activation, history back and reload restore the guide and its original video selection", async () => {
  const page = await pageAt(); await selected(page, "v0");
  await press(page, "ArrowRight"); await selected(page, "v1");
  await press(page, "Alt+Shift+g"); await guide(page, "home");
  await press(page, "ArrowDown"); await press(page, "ArrowDown"); await guide(page, "subscriptions");
  await press(page, "Enter"); await page.waitForURL("https://www.youtube.com/feed/subscriptions");
  await region(page, "list"); await selected(page, "v0");
  await press(page, "Escape"); await page.waitForURL("https://www.youtube.com/");
  await region(page, "guide"); await guide(page, "subscriptions");
  await page.reload(); await region(page, "guide"); await guide(page, "subscriptions");
  await press(page, "ArrowRight"); await region(page, "list"); await selected(page, "v1");
  await page.close();
});

test("guide selections survive renderer replacement, cancelled search and cancelled sequence mode", async () => {
  const page = await pageAt(); await selected(page, "v0");
  await press(page, "Alt+Shift+g");
  for (let i = 0; i < 3; i++) await press(page, "ArrowDown");
  await guide(page, "history");
  await page.locator("ytd-guide-renderer").evaluate(element => { element.innerHTML += ""; });
  await guide(page, "history");
  await press(page, "Alt+Shift+s"); await region(page, "search");
  await page.keyboard.insertText("语音搜索");
  await press(page, "Escape"); await region(page, "guide"); await guide(page, "history");
  await mode(page); await press(page, "ArrowDown"); await press(page, "Escape");
  await guide(page, "history");
  await press(page, "ArrowDown"); await guide(page, "playlists");
  await press(page, "Escape"); await region(page, "list"); await selected(page, "v0");
  await page.close();
});

test("mini guides and scrollable expanded guides support continuous selection without skipping items", async () => {
  const page = await pageAt("/?mini-guide=1"); await selected(page, "v0");
  await press(page, "ArrowLeft"); await guide(page, "home");
  for (let i = 0; i < 5; i++) await press(page, "ArrowDown");
  await guide(page, "history");
  assert.equal(await page.locator(".youtube-keyboard-selected").evaluate(element => element.tagName), "YTD-MINI-GUIDE-ENTRY-RENDERER");
  await press(page, "ArrowRight"); await selected(page, "v0");
  await page.goto("https://www.youtube.com/"); await selected(page, "v0");
  await page.locator("#guide-shell").evaluate(element => { element.style.maxHeight = "160px"; });
  await press(page, "ArrowLeft");
  for (let i = 0; i < 8; i++) await press(page, "ArrowDown");
  await guide(page, "music");
  assert.equal(await page.locator(".youtube-keyboard-selected").evaluate(element => {
    const box = element.getBoundingClientRect(), parent = document.querySelector("#guide-shell").getBoundingClientRect();
    return box.top >= parent.top && box.bottom <= parent.bottom + 1 && document.querySelector("#guide-shell").scrollTop > 0;
  }), true);
  await page.close();
});

test("collapsed drawer opens for guide selection and closes when returning to the list", async () => {
  const page = await pageAt("/?collapsed-guide=1"); await selected(page, "v0");
  await press(page, "Alt+Shift+g"); await region(page, "guide"); await guide(page, "home");
  await press(page, "ArrowDown"); await guide(page, "shorts");
  await press(page, "Escape"); await region(page, "list"); await selected(page, "v0");
  assert.equal(await page.locator("tp-yt-app-drawer").isVisible(), false);
  assert.equal(new URL(page.url()).pathname, "/");
  await page.close();
});

test("delayed or missing guides can be cancelled without hijacking later list navigation", async () => {
  const page = await pageAt("/?guide-delay=1"); await selected(page, "v0");
  await press(page, "Alt+Shift+g"); await region(page, "guide");
  await press(page, "ArrowRight"); await selected(page, "v0");
  await page.waitForTimeout(750); await region(page, "list"); await selected(page, "v0");
  await press(page, "ArrowRight"); await selected(page, "v1");
  await page.goto("https://www.youtube.com/?no-guide=1"); await selected(page, "v0");
  await press(page, "Alt+Shift+g"); await region(page, "guide");
  await press(page, "Escape"); await region(page, "list"); await selected(page, "v0");
  await press(page, "ArrowRight"); await selected(page, "v1");
  await page.close();
});

test("the guide sequence works from fullscreen and a remapped guide shortcut works live", async () => {
  const page = await pageAt("/watch?v=p0"); await region(page, "player");
  await press(page, "Alt+Shift+f"); await page.waitForFunction(() => !!document.fullscreenElement);
  await mode(page);
  for (const key of ["ArrowLeft", "ArrowRight", "ArrowUp"]) await press(page, key);
  await region(page, "guide"); await guide(page, "home");
  assert.equal(await page.evaluate(() => !!document.fullscreenElement), false);
  await press(page, "Escape"); await region(page, "player");
  const settings = R.cloneDefaults(); settings.bindings.guide = "F6";
  await worker.evaluate(settings => chrome.storage.local.set({ remoteSettings: settings }), settings);
  await press(page, "F6"); await region(page, "guide"); await guide(page, "home");
  await press(page, "ArrowRight"); await region(page, "player");
  await page.close();
});

test("Shorts keeps native video arrows while the left guide supports remote selection and return", async () => {
  const page = await pageAt(); await selected(page, "v0");
  await press(page, "ArrowLeft"); await guide(page, "home");
  await press(page, "ArrowDown"); await guide(page, "shorts");
  await press(page, "Enter"); await page.waitForURL("https://www.youtube.com/shorts/fixture");
  await region(page, "player");
  await press(page, "ArrowDown");
  assert.ok(await page.evaluate(() => window.nativeEvents.includes("ArrowDown")));
  await press(page, "Alt+Shift+g"); await guide(page, "shorts");
  await press(page, "ArrowDown"); await guide(page, "subscriptions");
  await press(page, "ArrowDown"); await guide(page, "history");
  await press(page, "ArrowRight"); await region(page, "player");
  await page.close();
});

test("guide navigation produces no uncaught extension errors", () => assert.deepEqual(errors, []));
