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
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), "youtube-shorts-e2e-"));
  const fixture = await fs.readFile(path.join(__dirname, "shorts-fixture.html"), "utf8");
  const root = path.resolve(__dirname, "../..");
  context = await chromium.launchPersistentContext(profile, {
    channel: "chromium", headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`],
    viewport: { width: 1000, height: 720 }
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
const hint = (page) => page.locator("#youtube-remote-status [role='status']").textContent();
async function doublePress(page, key) {
  await press(page, key);
  await page.waitForTimeout(120);
  await press(page, key);
}
async function pageAt(url = "/shorts/fixture") {
  const page = await context.newPage(); await page.goto("https://www.youtube.com" + url);
  await page.waitForSelector("#youtube-remote-status"); await region(page, "player"); return page;
}

test("Shorts hint lists the comments, close and like doubles", async () => {
  const page = await pageAt();
  const text = await hint(page);
  assert.match(text, /双击 → 展开评论/);
  assert.match(text, /双击 ← 关闭评论/);
  assert.match(text, /双击 ↑ 点赞/);
  await page.close();
});

test("double → opens and focuses comments, ↑↓ scroll, double ← closes", async () => {
  const page = await pageAt();
  await doublePress(page, "ArrowRight");
  await region(page, "shortsComments");
  // Neither tap reaches YouTube's own seek handler.
  assert.equal(await page.evaluate(() => window.nativeEvents.includes("ArrowRight")), false);
  assert.equal(await page.evaluate(() => document.activeElement === document.querySelector("#contents")), true);
  assert.equal(await page.evaluate(() => document.querySelector("#contents").getAttribute("tabindex")), "-1");
  assert.match(await hint(page), /双击 ← 关闭评论 · ↑↓ 翻看评论/);
  const start = await page.evaluate(() => document.querySelector("#contents").scrollTop);
  await press(page, "ArrowDown");
  await page.waitForFunction(start => document.querySelector("#contents").scrollTop > start, start);
  const down = await page.evaluate(() => document.querySelector("#contents").scrollTop);
  await press(page, "ArrowUp");
  await page.waitForFunction(down => document.querySelector("#contents").scrollTop < down, down);
  assert.equal(await page.evaluate(() => document.querySelector("#contents").scrollTop), start);
  await doublePress(page, "ArrowLeft");
  await region(page, "player");
  assert.equal(await page.evaluate(() => window.nativeEvents.includes("ArrowLeft")), false);
  await page.waitForFunction(() =>
    document.querySelector("ytd-engagement-panel-section-list-renderer").getAttribute("visibility") === "ENGAGEMENT_PANEL_VISIBILITY_HIDDEN");
  await page.waitForFunction(() =>
    document.querySelector("#youtube-remote-status").shadowRoot.textContent.includes("双击 → 展开评论"));
  assert.match(await hint(page), /双击 → 展开评论/);
  // Keys without a Shorts double still go straight to YouTube.
  await press(page, "ArrowDown");
  assert.equal(await page.evaluate(() => window.nativeEvents.includes("ArrowDown")), true);
  await page.close();
});

test("double ↑ likes without switching, single ↑ replays the native navigation after the interval", async () => {
  const page = await pageAt();
  await page.evaluate(() => { window.navClicks.up = 0; });
  await doublePress(page, "ArrowUp");
  await page.waitForFunction(() => document.querySelector("like-button-view-model button").getAttribute("aria-pressed") === "true");
  assert.equal(await page.evaluate(() => window.navClicks.up), 0);
  await page.waitForTimeout(600);
  assert.equal(await page.evaluate(() => window.navClicks.up), 0);
  assert.match(await hint(page), /已点赞/);
  await page.evaluate(() => { window.navClicks.up = 0; });
  await press(page, "ArrowUp");
  await page.waitForTimeout(150);
  assert.equal(await page.evaluate(() => window.navClicks.up), 0);
  await page.waitForFunction(() => window.navClicks.up === 1);
  // The held arrow is swallowed so it cannot reach YouTube's own handler.
  assert.equal(await page.evaluate(() => window.nativeEvents.includes("ArrowUp")), false);
  await page.close();
});

test("Shorts comments keys produce no uncaught extension errors", async () => assert.deepEqual(errors, []));
