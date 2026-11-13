const { test, before, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright");
const R = require("../../remote.js");

let context, worker, extensionDir, profile;
const errors = [];
const root = path.resolve(__dirname, "../..");
const EXTENSION_FILES = ["background.js", "browser.js", "command-panel.js", "content.js", "content.css",
  "douyin-content.js", "douyin.js", "bilibili.js", "youku.js", "video-site-content.js", "navigation.js",
  "google.js", "google-content.js", "remote.js", "recovery.html", "recovery.js", "recovery.css", "youtube.js",
  "options.html", "options.css", "options.js", "popup.html", "popup.css", "popup.js", "manifest.json"];

const result = (href, text) =>
  `<div class="MjjYud"><a href="/url?q=${encodeURIComponent(href)}&amp;sa=U"><h3>${text}</h3></a></div>`;
// The organic column only: `#rso` holds the results and `#search` wraps the column. Ads sit
// outside `#rso`, and Google's own links inside it are filtered by the adapter. The second page
// carries a `pnprev` link so page turns can be verified in both directions.
const pageBody = (results, { next = "", previous = "" } = {}) => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>搜索</title><style>
  *{box-sizing:border-box}body{margin:0;background:#fff;color:#202124;font:14px/1.5 sans-serif}
  form{padding:16px 24px}textarea{width:420px;height:40px;font:inherit}
  #search{padding:0 24px 0 180px}
  #rso{width:640px}
  .MjjYud{width:640px;height:120px;margin:0 0 12px;border:1px solid #dadce0}
  .MjjYud a{display:block;padding:16px;color:#1a0dab;text-decoration:none}
  #other{width:640px;height:120px;margin:24px 0;border:1px solid #dadce0}
  #foot{padding:24px;font-size:18px}
  #foot a{margin-right:16px;color:#1a0dab}
  #pnprev[hidden]{display:none}
</style></head><body>
<form action="/search"><textarea name="q"></textarea></form>
<div id="search"><div id="rso">
${results.map(([href, text]) => result(href, text)).join("\n")}
</div>
<div id="other"><a href="https://www.google.com/preferences"><h3>搜索设置</h3></a></div></div>
<div id="foot">${previous ? `<a id="pnprev" href="${previous}">上一页</a>` : `<a id="pnprev" hidden href="#">上一页</a>`}${
  next ? `<a id="pnnext" href="${next}">下一页</a>` : ""}</div>
</body></html>`;
const firstPage = pageBody([
  ["https://example.test/one", "结果一"],
  ["https://example.test/two", "结果二"],
  ["https://example.test/three", "结果三"]], { next: "/search?q=test&start=10" });
const secondPage = pageBody([
  ["https://example.test/four", "结果四"],
  ["https://example.test/five", "结果五"]], { previous: "/search?q=test" });

const plain = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>远程遥控测试页</title></head>
<body><h1 id="heading">远程遥控测试页</h1><a href="/one">页面一</a><button id="action-one">操作一</button></body></html>`;

async function buildExtension() {
  extensionDir = await fs.mkdtemp(path.join(os.tmpdir(), "youtube-google-ext-"));
  for (const file of EXTENSION_FILES) await fs.copyFile(path.join(root, file), path.join(extensionDir, file));
  await fs.cp(path.join(root, "icons"), path.join(extensionDir, "icons"), { recursive: true });
  const manifest = JSON.parse(await fs.readFile(path.join(root, "manifest.json"), "utf8"));
  manifest.host_permissions = ["http://*/*", "https://*/*"];
  delete manifest.optional_host_permissions;
  await fs.writeFile(path.join(extensionDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  // The HUD lives in a closed shadow root; opening it lets the tests read the search box.
  const browser = path.join(extensionDir, "browser.js");
  const source = await fs.readFile(browser, "utf8");
  const target = 'hud.attachShadow({ mode: "closed" })';
  assert.ok(source.includes(target));
  await fs.writeFile(browser, source.replace(target, 'hud.attachShadow({ mode: "open" })'));
}

before(async () => {
  profile = await fs.mkdtemp(path.join(os.tmpdir(), "youtube-google-e2e-"));
  await buildExtension();
  context = await chromium.launchPersistentContext(profile, {
    channel: "chromium", headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
    args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`],
    viewport: { width: 1100, height: 720 }
  });
  context.setDefaultTimeout(6000);
  worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  const route = body => (route, request) => request.resourceType() === "document"
    ? route.fulfill({ status: 200, contentType: "text/html", body })
    : route.fulfill({ status: 404, contentType: "text/plain", body: "" });
  await context.route("https://www.google.com/search*", route => {
    if (route.request().resourceType() !== "document")
      return route.fulfill({ status: 404, contentType: "text/plain", body: "" });
    const url = new URL(route.request().url());
    const body = url.searchParams.get("start") === "10" ? secondPage : firstPage;
    return route.fulfill({ status: 200, contentType: "text/html", body });
  });
  await context.route("https://remote-fixture.test/**", route(plain));
  await context.route("https://example.test/**", route("<!doctype html><title>结果</title><h1>结果</h1>"));
  context.on("page", page => page.on("pageerror", error => errors.push(`${page.url()}: ${error.message}`)));
});
beforeEach(async () => {
  await new Promise(resolve => setTimeout(resolve, 120));
  await worker.evaluate(() => chrome.storage.session.remove("remote:browser-mode"));
  await worker.evaluate(settings => chrome.storage.local.set({ remoteSettings: settings }), R.cloneDefaults());
});
after(async () => { await context?.close(); });

const press = (page, key) => page.keyboard.press(key);
const googleHud = page => page.evaluate(() => {
  const host = document.querySelector("#google-remote-status");
  return host ? { hidden: host.hidden, results: host.dataset.results, selected: host.dataset.selected } : null;
});
const browserHud = page => page.evaluate(() => {
  const host = document.querySelector("#youtube-remote-browser");
  return host ? { hidden: host.hidden, active: host.dataset.active, phase: host.dataset.phase,
    group: host.dataset.group, item: host.dataset.item, page: host.dataset.page } : null;
});
const selectedText = page => page.evaluate(() =>
  document.querySelector(".google-keyboard-selected h3")?.textContent || "");
async function googlePage(query = "test") {
  const page = await context.newPage();
  await page.goto(`https://www.google.com/search?q=${encodeURIComponent(query)}`);
  await page.waitForFunction(() => document.querySelector("#google-remote-status")?.dataset.results === "3");
  return page;
}
async function sitePage() {
  const page = await context.newPage();
  await page.goto("https://remote-fixture.test/");
  await page.waitForFunction(() => !!document.querySelector("#heading"));
  return page;
}
// Enter the mode on a plain page (a double tap), open the menu and move to the search item.
async function openSearchBox(page) {
  await page.evaluate(() => document.activeElement?.blur());
  await press(page, "Enter");
  await press(page, "Enter");
  await page.waitForFunction(() => document.querySelector("#youtube-remote-browser")?.dataset.active === "true");
  await press(page, "Enter");
  await page.waitForFunction(() => document.querySelector("#youtube-remote-browser")?.dataset.phase === "titles");
  for (let i = 0; i < 20 && (await browserHud(page)).item !== "googleSearch"; i++) {
    const before = (await browserHud(page)).item;
    await press(page, "ArrowDown");
    await page.waitForFunction(value => document.querySelector("#youtube-remote-browser")?.dataset.item !== value, before);
  }
  assert.equal((await browserHud(page)).item, "googleSearch");
  // Opening and activation are distinct gestures.
  await page.waitForTimeout(450);
  await press(page, "Enter");
  await page.waitForFunction(() => document.querySelector("#youtube-remote-browser")?.dataset.page === "search");
}

// A double tap of → is the filter gesture. Playwright sends both taps inside the interval.
async function startFilter(page) {
  await press(page, "ArrowRight");
  await press(page, "ArrowRight");
  await page.waitForFunction(() => document.querySelector("#google-remote-status")?.dataset.selected === "1");
}

test("a double tap of right starts filtering and arrows move through the organic results", async () => {
  const page = await googlePage();
  // Without the gesture the arrows keep Google's native scrolling.
  await press(page, "ArrowDown");
  assert.equal(await page.evaluate(() => document.querySelector(".google-keyboard-selected")), null);
  await startFilter(page);
  assert.equal(await selectedText(page), "结果一");
  await press(page, "ArrowDown");
  await page.waitForFunction(() => document.querySelector("#google-remote-status")?.dataset.selected === "2");
  assert.equal(await selectedText(page), "结果二");
  await press(page, "ArrowDown");
  await press(page, "ArrowDown");
  // Clamped at the last result, never wrapping into Google's own links.
  assert.equal((await googleHud(page)).selected, "3");
  assert.equal(await selectedText(page), "结果三");
  await press(page, "ArrowUp");
  assert.equal((await googleHud(page)).selected, "2");
  assert.equal(await selectedText(page), "结果二");
  await page.close();
});

test("a single right tap neither scrolls the page nor starts filtering", async () => {
  const page = await googlePage();
  await press(page, "ArrowRight");
  await page.waitForTimeout(600);
  assert.equal((await googleHud(page)).selected, "");
  assert.equal(await page.evaluate(() => scrollX), 0);
  await page.close();
});

test("left and right turn the result pages while the filter stays armed", async () => {
  const page = await googlePage();
  await startFilter(page);
  await press(page, "ArrowDown");
  assert.equal(await selectedText(page), "结果二");
  // → turns to the next page and starts on its first result.
  await Promise.all([page.waitForURL(/start=10/), press(page, "ArrowRight")]);
  await page.waitForFunction(() => document.querySelector("#google-remote-status")?.dataset.results === "2" &&
    document.querySelector("#google-remote-status")?.dataset.selected === "1");
  assert.equal(await selectedText(page), "结果四");
  await press(page, "ArrowDown");
  assert.equal(await selectedText(page), "结果五");
  // ← turns back to the first page.
  await Promise.all([page.waitForURL(url => !url.search.includes("start=")), press(page, "ArrowLeft")]);
  await page.waitForFunction(() => document.querySelector("#google-remote-status")?.dataset.results === "3" &&
    document.querySelector("#google-remote-status")?.dataset.selected === "1");
  assert.equal(await selectedText(page), "结果一");
  await page.close();
});

test("paging past the last or first page stays put and reports it", async () => {
  const page = await googlePage();
  await startFilter(page);
  await Promise.all([page.waitForURL(/start=10/), press(page, "ArrowRight")]);
  await page.waitForFunction(() => document.querySelector("#google-remote-status")?.dataset.results === "2");
  // The second page has no next link, so the key is consumed without navigating.
  await press(page, "ArrowRight");
  await page.waitForTimeout(500);
  assert.match(page.url(), /start=10/);
  await Promise.all([page.waitForURL(url => !url.search.includes("start=")), press(page, "ArrowLeft")]);
  await page.waitForFunction(() => document.querySelector("#google-remote-status")?.dataset.results === "3");
  await press(page, "ArrowLeft");
  await page.waitForTimeout(500);
  assert.ok(!page.url().includes("start="));
  await page.close();
});

test("a single confirm opens the selected result after the double-tap window", async () => {
  const page = await googlePage();
  await startFilter(page);
  await press(page, "ArrowDown");
  assert.equal(await selectedText(page), "结果二");
  await Promise.all([page.waitForURL("https://example.test/two"), press(page, "Enter")]);
  await page.close();
});

test("a quick second confirm opens immediately and the browser entry cancels the first", async () => {
  const page = await googlePage();
  await startFilter(page);
  await Promise.all([page.waitForURL("https://example.test/one"), press(page, "Enter"), press(page, "Enter")]);
  await page.close();

  const other = await googlePage();
  await startFilter(other);
  // The first press of the browser entry must not also open the result.
  await press(other, "Enter");
  await press(other, "Enter");
  await other.waitForFunction(() => document.querySelector("#youtube-remote-browser")?.dataset.active === "true");
  await other.waitForTimeout(600);
  assert.equal(new URL(other.url()).hostname, "www.google.com");
  await press(other, "Escape");
  await other.waitForFunction(() => document.querySelector("#youtube-remote-browser")?.dataset.active === "false");
  await other.close();
});

test("Esc ends filtering and leaves the rest of the page untouched", async () => {
  const page = await googlePage();
  await startFilter(page);
  await press(page, "Escape");
  await page.waitForFunction(() => document.querySelector("#google-remote-status")?.dataset.selected === "");
  assert.equal(await page.evaluate(() => document.querySelector(".google-keyboard-selected")), null);
  // Nothing is selected, so Esc belongs to Google again and never navigates on its own.
  await press(page, "Escape");
  await page.waitForTimeout(500);
  assert.equal(new URL(page.url()).hostname, "www.google.com");
  assert.equal(new URL(page.url()).pathname, "/search");
  // After leaving, a single → is native again instead of a new gesture.
  await press(page, "ArrowRight");
  await page.waitForTimeout(600);
  assert.equal((await googleHud(page)).selected, "");
  await page.close();
});

test("the search shortcut focuses Google's own box and leaves typing native", async () => {
  const page = await googlePage();
  await press(page, "Alt+Shift+S");
  await page.waitForFunction(() => document.activeElement?.name === "q");
  await page.keyboard.type("远程");
  assert.equal(await page.evaluate(() => document.querySelector('textarea[name="q"]').value), "远程");
  await page.close();
});

test("browser mode's Google search box turns typed keywords into a search in this tab", async () => {
  const page = await sitePage();
  await openSearchBox(page);
  const field = page.locator("#youtube-remote-browser input[name='google-search']");
  await field.waitFor({ state: "visible" });
  await page.keyboard.type("hello world");
  await page.waitForFunction(() => document.querySelector("#youtube-remote-browser")?.dataset.query === "hello world");
  await Promise.all([page.waitForURL("https://www.google.com/search?q=hello%20world"), press(page, "Enter")]);
  assert.equal(new URL(page.url()).searchParams.get("q"), "hello world");
  await page.close();
});

test("Esc leaves the search box back at the menu instead of the mode", async () => {
  const page = await sitePage();
  await openSearchBox(page);
  await page.keyboard.type("abc");
  await press(page, "Escape");
  await page.waitForFunction(() => document.querySelector("#youtube-remote-browser")?.dataset.phase === "titles");
  assert.equal((await browserHud(page)).active, "true");
  await press(page, "Escape");
  await page.waitForFunction(() => document.querySelector("#youtube-remote-browser")?.dataset.phase === "direct");
  await page.close();
});

test("an empty query never navigates away", async () => {
  const page = await sitePage();
  await openSearchBox(page);
  await press(page, "Enter");
  await page.waitForTimeout(500);
  assert.equal(new URL(page.url()).hostname, "remote-fixture.test");
  await press(page, "Escape");
  await page.close();
});
