const { test, before, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright");
const R = require("../../remote.js");

let context, worker, extensionId, profile, extensionDir, youtubeFixture, siteFixture;
// One pixel PNG, used as the body of every fixture favicon.
const PIXEL = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const errors = [];
const root = path.resolve(__dirname, "../..");
const EXTENSION_FILES = ["background.js", "browser.js", "command-panel.js", "content.js", "content.css", "douyin-content.js", "douyin.js",
  "bilibili.js", "youku.js", "video-site-content.js", "google.js", "google-content.js",
  "navigation.js", "remote.js", "recovery.html", "recovery.js", "recovery.css", "youtube.js",
  "options.html", "options.css", "options.js", "popup.html", "popup.css", "popup.js", "manifest.json"];

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

// The HUD lives in a closed shadow root, so the suite rebuilds the extension with an open one.
// That is the only modification to production scripts; it lets tests inspect rendered menu rows.
async function openHudShadowRoot() {
  const file = path.join(extensionDir, "browser.js");
  const source = await fs.readFile(file, "utf8");
  const target = 'hud.attachShadow({ mode: "closed" })';
  assert.ok(source.includes(target));
  await fs.writeFile(file, source.replace(target, 'hud.attachShadow({ mode: "open" })'));
}

before(async () => {
  profile = await fs.mkdtemp(path.join(os.tmpdir(), "youtube-browser-e2e-"));
  await buildExtension();
  await openHudShadowRoot();
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
  // Only documents get the fixture. Subresource requests (for example a YouTube script that a
  // tab may still fetch) must not receive HTML, or the parse errors would hide real page errors.
  const fixtureRoute = body => route => {
    const type = route.request().resourceType();
    if (type === "document") return route.fulfill({ status: 200, contentType: "text/html", body });
    // Site icons are real image documents in production. A blanket 404 here would be cached for
    // the tab's own favicon fetch and would turn every favicon assertion into a fallback check.
    if (type === "image" || /\.(ico|png|svg)$/i.test(new URL(route.request().url()).pathname)) {
      return route.fulfill({ status: 200, contentType: "image/png", body: PIXEL });
    }
    return route.fulfill({ status: 404, contentType: "text/plain", body: "" });
  };
  await context.route("https://www.youtube.com/**", fixtureRoute(youtubeFixture));
  await context.route("https://remote-fixture.test/**", fixtureRoute(siteFixture));
  context.on("page", page => page.on("pageerror", error => errors.push(`${page.url()}: ${error.message}`)));
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
    position: host.dataset.position, total: host.dataset.total, selected: host.dataset.selected,
    page: host.dataset.page, close: host.dataset.close, action: host.dataset.action,
    closeArmed: host.dataset.closeArmed,
    group: host.dataset.group, item: host.dataset.item, focusIndex: host.dataset.focusIndex, focusTotal: host.dataset.focusTotal,
    icons: host.dataset.icons } : null;
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
// Navigate using the same six controls as a remote, waiting for each state update.
async function openActions(page) {
  await page.waitForFunction(() => document.querySelector("#youtube-remote-browser")?.dataset.phase === "direct");
  await press(page, "Enter");
  await page.waitForFunction(() => document.querySelector("#youtube-remote-browser")?.dataset.phase === "titles");
  // Opening and activation are distinct gestures.
  await page.waitForTimeout(450);
}
// The panel opens on the tabs group; step right through the remaining groups until one matches.
async function selectGroup(page, group) {
  for (let i = 0; i < 4 && (await hud(page)).group !== group; i++) {
    const before = (await hud(page)).group;
    await press(page, "ArrowRight");
    await page.waitForFunction(value => document.querySelector("#youtube-remote-browser")?.dataset.group !== value, before);
  }
  assert.equal((await hud(page)).group, group);
}
async function selectAction(page, action) {
  if ((await hud(page)).phase !== "titles") await openActions(page);
  const group = ["reload", "close", "scrollTop", "scrollBottom"].includes(action) ? "page" : "common";
  await selectGroup(page, group);
  for (let i = 0; i < 20 && (await hud(page)).item !== action; i++) {
    const before = (await hud(page)).item;
    await press(page, "ArrowDown");
    await page.waitForFunction(value => document.querySelector("#youtube-remote-browser")?.dataset.item !== value, before);
  }
  assert.equal((await hud(page)).item, action);
}
async function chooseAction(page, action) {
  await selectAction(page, action);
  await press(page, "Enter");
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

test("the tabs list shows three rows, centers the selected tab and blurs the edges", async () => {
  const pages = [];
  for (let i = 0; i < 7; i++) pages.push(await sitePage(`/tab-${i}`));
  const page = pages[0];
  await page.bringToFront();
  await enterBrowser(page);
  await openActions(page);
  // The panel opens on the tab wheel, with the tab that entered the mode selected.
  assert.equal((await hud(page)).group, "tabs");
  const tabsWindow = () => page.evaluate(() => {
    const host = document.querySelector("#youtube-remote-browser");
    const list = host?.shadowRoot?.querySelector(".rows");
    if (!list) return null;
    const box = list.getBoundingClientRect();
    const rows = [...list.children];
    const selected = rows.find(row => row.classList.contains("selected"));
    const selectedBox = selected?.getBoundingClientRect();
    return {
      count: rows.length, height: box.height, center: box.top + box.height / 2,
      rowHeight: selectedBox?.height || 0,
      selectedCenter: selectedBox ? selectedBox.top + selectedBox.height / 2 : null,
      scrollTop: list.scrollTop, overflowing: list.classList.contains("overflowing"),
      blurred: rows.filter(row => row.style.filter.includes("blur")).length
    };
  });
  let view = await tabsWindow();
  assert.equal(view.count, 7);
  assert.equal(view.overflowing, true);
  // Three full rows plus the two peeking halves.
  assert.ok(view.height >= view.rowHeight * 3 && view.height < view.rowHeight * 4);
  // The ends clamp like any list; once inside, the selected tab sits in the middle.
  await press(page, "ArrowDown");
  await press(page, "ArrowDown");
  await page.waitForFunction(() => {
    const list = document.querySelector("#youtube-remote-browser")?.shadowRoot?.querySelector(".rows");
    return list && list.scrollTop > 0;
  });
  view = await tabsWindow();
  assert.ok(Math.abs(view.selectedCenter - view.center) <= 2, `${view.selectedCenter} vs ${view.center}`);
  assert.ok(view.blurred > 0);
  const firstScroll = view.scrollTop;
  await press(page, "ArrowDown");
  await page.waitForFunction(top => {
    const list = document.querySelector("#youtube-remote-browser")?.shadowRoot?.querySelector(".rows");
    return list && list.scrollTop > top;
  }, firstScroll);
  view = await tabsWindow();
  assert.ok(Math.abs(view.selectedCenter - view.center) <= 2, `${view.selectedCenter} vs ${view.center}`);
  await page.screenshot({ path: "test-results/browser-tabs.png" });
  await Promise.all(pages.map(item => item.close()));
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

test("a tab left behind by an older extension context is repaired when it is activated", async () => {
  const page = await sitePage("/");
  const neighbor = await sitePage("/neighbor");
  await page.bringToFront();
  await page.evaluate(() => { window.keptAcrossRepair = true; });
  const tabId = await activeTabId();
  // An extension update or reload invalidates the page's controller while leaving its listeners in
  // place. dispose() reproduces that state: nothing answers the background any more, and the page
  // must not be refreshed to recover.
  await worker.evaluate(async tabId => {
    await chrome.scripting.executeScript({ target: { tabId },
      func: () => globalThis.__remoteBrowserController?.dispose?.() });
  }, tabId);
  await page.waitForFunction(() => !document.querySelector("#youtube-remote-browser"));
  await neighbor.bringToFront();
  await page.bringToFront();
  let repaired = false;
  for (let i = 0; i < 60 && !repaired; i++) {
    repaired = await worker.evaluate(async tabId => {
      try {
        const reply = await chrome.tabs.sendMessage(tabId, { type: "remote:browser-ping" }, { frameId: 0 });
        return reply?.ok === true;
      } catch (_) { return false; }
    }, tabId);
    if (!repaired) await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(repaired, true);
  assert.equal(await page.evaluate(() => window.keptAcrossRepair), true);
  await enterBrowser(page);
  assert.equal((await hud(page)).active, "true");
  await Promise.all([page.close(), neighbor.close()]);
});

test("single confirm opens the menu without reloading; reload is explicit", async () => {
  const page = await sitePage("/");
  await enterBrowser(page);
  await page.evaluate(() => { window.beforeReload = true; });
  await openActions(page);
  assert.equal(await page.evaluate(() => window.beforeReload), true);
  assert.equal((await hud(page)).group, "tabs");
  await selectAction(page, "reload");
  await Promise.all([page.waitForEvent("load"), press(page, "Enter")]);
  assert.equal(await page.evaluate(() => window.beforeReload), undefined);
  await waitHud(page, true);
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

test("history back to a blank page keeps the remote on a controllable tab", async () => {
  const neighbor = await sitePage("/one");
  // A tab opened by the browser starts on about:blank, which stays in its history.
  const page = await context.newPage();
  await page.goto("https://remote-fixture.test/");
  await page.waitForFunction(() => !!document.querySelector("#heading"));
  await page.bringToFront();
  const pageTabId = await worker.evaluate(async () => {
    const tab = (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
    return tab?.id ?? null;
  });
  await enterBrowser(page);
  // Back leaves this tab on about:blank, where no content script can run.
  await press(page, "ArrowLeft");
  await page.waitForURL(/^about:/).catch(() => {});
  // The mode must move to the neighbour instead of going dead.
  await waitHud(neighbor, true);
  assert.equal((await hud(neighbor)).active, "true");
  assert.equal((await hud(neighbor)).phase, "direct");
  assert.equal(String(await activeTabId()) !== String(pageTabId), true);
  await press(neighbor, "Escape");
  await waitHud(neighbor, false);
  await Promise.all([neighbor.close(), page.close()]);
});

test("entry double tap opens the menu without activating, and Escape returns", async () => {
  const page = await sitePage("/");
  await enterBrowser(page);
  await press(page, "Enter");
  await press(page, "Enter");
  await page.waitForTimeout(500);
  assert.equal((await hud(page)).phase, "titles");
  assert.equal((await hud(page)).group, "tabs");
  await press(page, "Escape");
  await page.waitForFunction(() => document.querySelector("#youtube-remote-browser")?.dataset.phase === "direct");
  await press(page, "Escape");
  await waitHud(page, false);
  await page.close();
});

test("a human-paced third tap enters even though the panel is already open", async () => {
  const page = await youtubePage("/");
  await press(page, "Enter");
  await press(page, "Enter");
  await page.locator("#youtube-remote-sequences").waitFor({ state: "visible" });
  // The second tap opens the panel; by the time the user sees it and presses again, the double
  // interval has passed. That last press still completes the three-tap entry.
  await page.waitForTimeout(600);
  await press(page, "Enter");
  await waitHud(page, true);
  assert.equal(await page.locator("#youtube-remote-sequences").isVisible(), false);
  await press(page, "Escape");
  await waitHud(page, false);
  await page.close();
});

test("an open sequence panel keeps Enter for its own commands once the entry window passed", async () => {
  const page = await youtubePage("/");
  await press(page, "Enter");
  await press(page, "Enter");
  await page.locator("#youtube-remote-sequences").waitFor({ state: "visible" });
  // Past the entry window the press belongs to the panel, not to the entry gesture.
  await page.waitForTimeout(1500);
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

test("the action list enters focus mode and arrows traverse focusables with wrap", async () => {
  const page = await sitePage("/");
  await page.evaluate(() => document.activeElement?.blur());
  await enterBrowser(page);
  await chooseAction(page, "focus");
  await page.waitForFunction(() => document.querySelector("#youtube-remote-browser")?.dataset.page === "focus");
  assert.equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), "页面一");
  assert.ok(Number((await hud(page)).focusTotal) >= 8);
  await press(page, "ArrowDown");
  assert.equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), "页面二");
  await press(page, "ArrowUp");
  await press(page, "ArrowUp");
  // Wrapping backwards from the first nav link lands on the last focusable element.
  assert.equal(await page.evaluate(() => document.activeElement?.id), "scrollbox");
  await press(page, "ArrowDown");
  assert.equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), "页面一");
  await press(page, "Escape");
  await page.waitForFunction(() => document.querySelector("#youtube-remote-browser")?.dataset.page === "");
  assert.equal((await hud(page)).active, "true");
  await page.close();
});

test("Enter activates the focused control from the focus mode", async () => {
  const page = await sitePage("/");
  await page.evaluate(() => document.activeElement?.blur());
  await enterBrowser(page);
  await page.focus("#action-one");
  await chooseAction(page, "focus");
  await page.waitForFunction(() => document.querySelector("#youtube-remote-browser")?.dataset.page === "focus");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "action-one");
  await press(page, "Enter");
  assert.equal(await page.evaluate(() => window.actionClicks), 1);
  assert.equal((await hud(page)).active, "true");
  assert.equal((await hud(page)).page, "focus");
  await press(page, "Escape");
  await page.close();
});

test("the action list focuses the first editor and keeps typing native", async () => {
  const page = await sitePage("/");
  await page.evaluate(() => document.activeElement?.blur());
  await enterBrowser(page);
  await chooseAction(page, "input");
  await page.waitForFunction(() => document.querySelector("#youtube-remote-browser")?.dataset.page === "inputPick");
  await press(page, "Enter");
  await page.waitForFunction(() => document.querySelector("#youtube-remote-browser")?.dataset.page === "input");
  const selection = await page.evaluate(() => {
    const input = document.querySelector("#text");
    return { id: document.activeElement?.id, start: input.selectionStart, end: input.selectionEnd,
      length: input.value.length };
  });
  // The read-only field is skipped; the first editable field is selected for voice input.
  assert.equal(selection.id, "text");
  assert.equal(selection.start, 0);
  assert.equal(selection.end, selection.length);
  await page.keyboard.type("abc");
  assert.equal(await page.evaluate(() => document.querySelector("#text").value), "abc");
  await press(page, "Backspace");
  assert.equal(await page.evaluate(() => document.querySelector("#text").value), "ab");
  assert.equal((await hud(page)).close, "");
  assert.equal((await hud(page)).page, "input");
  await press(page, "Escape");
  await page.waitForFunction(() => document.querySelector("#youtube-remote-browser")?.dataset.page === "inputPick");
  assert.equal(await page.evaluate(() => document.querySelector("#text").value), "ab");
  assert.equal((await hud(page)).active, "true");
  await page.close();
});

test("Enter on a focused text field enters text entry", async () => {
  const page = await sitePage("/");
  await page.evaluate(() => document.activeElement?.blur());
  await enterBrowser(page);
  await page.focus("#text");
  await chooseAction(page, "focus");
  await page.waitForFunction(() => document.querySelector("#youtube-remote-browser")?.dataset.page === "focus");
  await press(page, "Enter");
  await page.waitForFunction(() => document.querySelector("#youtube-remote-browser")?.dataset.page === "input");
  await page.keyboard.type("你好");
  assert.equal(await page.evaluate(() => document.querySelector("#text").value), "你好");
  await press(page, "Escape");
  await page.close();
});

test("the action list closes the tab only after a second confirmation", async () => {
  const neighbor = await sitePage("/one");
  const page = await sitePage("/");
  await page.evaluate(() => document.activeElement?.blur());
  await enterBrowser(page);
  await selectAction(page, "close");
  await press(page, "Enter");
  await page.waitForFunction(() => document.querySelector("#youtube-remote-browser")?.dataset.closeArmed === "true");
  assert.equal(page.isClosed(), false);
  // The armed state does not expire on its own; only moving the selection or confirming clears it.
  await page.waitForTimeout(600);
  assert.equal(page.isClosed(), false);
  const closed = page.waitForEvent("close");
  await press(page, "Enter");
  await closed;
  assert.equal(page.isClosed(), true);
  // The window keeps the mode and the remaining tab takes over the HUD.
  await neighbor.bringToFront();
  await waitHud(neighbor, true);
  await press(neighbor, "Escape");
  await waitHud(neighbor, false);
  await neighbor.close();
});

test("moving the selection cancels the armed close", async () => {
  const page = await sitePage("/");
  await page.evaluate(() => document.activeElement?.blur());
  await enterBrowser(page);
  await selectAction(page, "close");
  await press(page, "Enter");
  await page.waitForFunction(() => document.querySelector("#youtube-remote-browser")?.dataset.closeArmed === "true");
  await press(page, "ArrowUp");
  await page.waitForFunction(() =>
    document.querySelector("#youtube-remote-browser")?.dataset.closeArmed === "" &&
    document.querySelector("#youtube-remote-browser")?.dataset.action === "reload");
  assert.equal(page.isClosed(), false);
  assert.equal((await hud(page)).active, "true");
  // Esc leaves the list first; the next one exits the mode.
  await press(page, "Escape");
  await page.waitForFunction(() => document.querySelector("#youtube-remote-browser")?.dataset.phase === "direct");
  await press(page, "Escape");
  await waitHud(page, false);
  await page.close();
});

test("recorded shortcuts still work when the remote has extra buttons", async () => {
  const page = await sitePage("/");
  const settings = R.cloneDefaults();
  settings.bindings.focusMode = "Tab";
  settings.bindings.focusInput = "Alt+Shift+KeyI";
  settings.bindings.browserClose = "Backspace";
  await worker.evaluate(value => chrome.storage.local.set({ remoteSettings: value }), settings);
  await page.waitForTimeout(150);
  await page.evaluate(() => document.activeElement?.blur());
  await enterBrowser(page); // Enter is still the entry binding
  await press(page, "Tab");
  await page.waitForFunction(() => document.querySelector("#youtube-remote-browser")?.dataset.page === "focus");
  await press(page, "Escape");
  await page.waitForFunction(() => document.querySelector("#youtube-remote-browser")?.dataset.page === "");
  await press(page, "Alt+Shift+I");
  await page.waitForFunction(() => document.querySelector("#youtube-remote-browser")?.dataset.page === "input");
  await press(page, "Escape");
  await page.waitForFunction(() => document.querySelector("#youtube-remote-browser")?.dataset.page === "inputPick");
  await press(page, "Escape");
  await page.waitForFunction(() => document.querySelector("#youtube-remote-browser")?.dataset.phase === "titles");
  await press(page, "Escape");
  await page.waitForFunction(() => document.querySelector("#youtube-remote-browser")?.dataset.phase === "direct");
  // The editor keeps real focus after leaving input mode; a text field always keeps Backspace native.
  await page.evaluate(() => document.activeElement?.blur());
  await press(page, "Backspace");
  await page.waitForFunction(() => document.querySelector("#youtube-remote-browser")?.dataset.close === "pending");
  await press(page, "a");
  await page.waitForFunction(() => document.querySelector("#youtube-remote-browser")?.dataset.close === "");
  assert.equal((await hud(page)).active, "true");
  await press(page, "Escape");
  await waitHud(page, false);
  await page.close();
});

test("input picker traverses editors and preserves native editing across back", async () => {
  const page = await sitePage("/");
  await enterBrowser(page);
  await chooseAction(page, "input");
  await page.waitForFunction(() => document.querySelector("#youtube-remote-browser")?.dataset.page === "inputPick");
  assert.equal(await page.evaluate(() => document.activeElement.id), "text");
  await press(page, "ArrowDown");
  assert.equal(await page.evaluate(() => document.activeElement.id), "notes");
  await press(page, "Enter");
  await page.keyboard.type("hello");
  await press(page, "Enter");
  await page.keyboard.type("world");
  await press(page, "ArrowLeft");
  await press(page, "Backspace");
  assert.equal(await page.evaluate(() => document.querySelector("#notes").value), "hello\nword");
  await press(page, "Escape");
  assert.equal((await hud(page)).page, "inputPick");
  await press(page, "Escape");
  await page.waitForFunction(() => document.querySelector("#youtube-remote-browser")?.dataset.phase === "titles");
  await press(page, "Escape");
  await page.waitForFunction(() => document.querySelector("#youtube-remote-browser")?.dataset.phase === "direct");
  await page.close();
});

test("scroll mode targets focused scrolling ancestor and has layered exits", async () => {
  const page = await sitePage("/");
  await enterBrowser(page);
  await page.focus("#scrollbox");
  await chooseAction(page, "scroll");
  await page.waitForFunction(() => document.querySelector("#youtube-remote-browser")?.dataset.page === "scroll");
  await press(page, "ArrowDown");
  assert.ok(await page.evaluate(() => document.querySelector("#scrollbox").scrollTop) > 0);
  await page.waitForTimeout(100);
  await press(page, "ArrowRight");
  assert.ok(await page.evaluate(() => document.querySelector("#scrollbox").scrollLeft) > 0);
  await press(page, "Enter");
  await page.waitForFunction(() => document.querySelector("#youtube-remote-browser")?.dataset.phase === "titles");
  await press(page, "Escape");
  await page.waitForFunction(() => document.querySelector("#youtube-remote-browser")?.dataset.phase === "direct");
  await page.close();
});

test("browser-only bindings stay native on YouTube while the mode is inactive", async () => {
  const page = await youtubePage("/");
  const settings = R.cloneDefaults();
  settings.bindings.focusMode = "Tab";
  settings.bindings.focusInput = "Alt+Shift+KeyI";
  settings.bindings.browserClose = "Backspace";
  await worker.evaluate(value => chrome.storage.local.set({ remoteSettings: value }), settings);
  await page.waitForTimeout(150);
  await page.evaluate(() => { window.nativeEvents = []; document.activeElement?.blur(); });
  await press(page, "Tab");
  await press(page, "Backspace");
  await press(page, "Alt+Shift+I");
  const events = await page.evaluate(() => window.nativeEvents);
  assert.ok(events.includes("Tab"), JSON.stringify(events));
  assert.ok(events.includes("Backspace"), JSON.stringify(events));
  assert.ok(events.includes("I"), JSON.stringify(events));
  assert.equal((await hud(page))?.active ?? "false", "false");
  await page.close();
});

test("last controlled tab hands off to recovery and reopens its closed URL", async () => {
  const page = await sitePage("/two");
  await enterBrowser(page);
  await chooseAction(page, "close");
  await page.waitForFunction(() => document.querySelector("#youtube-remote-browser")?.dataset.closeArmed === "true");
  const created = context.waitForEvent("page");
  const closed = page.waitForEvent("close");
  await press(page, "Enter");
  const recovery = await created;
  await recovery.waitForURL(/recovery\.html/);
  await closed;
  await recovery.waitForFunction(() => document.body.dataset.ready === "true" && document.body.dataset.group === "common");
  for (let i = 0; i < 5; i++) {
    const previous = await recovery.evaluate(() => document.body.dataset.selected);
    await press(recovery, "ArrowDown");
    await recovery.waitForFunction(value => document.body.dataset.selected !== value, previous);
  }
  assert.equal(await recovery.evaluate(() => document.body.dataset.selected), "restore");
  const reopened = context.waitForEvent("page");
  await press(recovery, "Enter");
  const restored = await reopened;
  await restored.waitForURL("https://remote-fixture.test/two");
  await waitHud(restored, true);
  await press(restored, "Escape");
  await waitHud(restored, false);
  await Promise.all([restored.close(), recovery.close()]);
});

test("returning to blank with no other web tab opens a usable recovery page", async () => {
  const page = await sitePage("/");
  await enterBrowser(page);
  const created = context.waitForEvent("page");
  await press(page, "ArrowLeft");
  await page.waitForURL("about:blank");
  const recovery = await created;
  await recovery.waitForURL(/recovery\.html/);
  await recovery.waitForFunction(() => document.body.dataset.ready === "true" && document.body.dataset.group === "common");
  await press(recovery, "ArrowRight");
  await recovery.waitForFunction(() => document.body.dataset.group === "sites");
  assert.equal(await recovery.evaluate(() => document.body.dataset.selected), "youtube");
  const opened = context.waitForEvent("page");
  await press(recovery, "Enter");
  const youtube = await opened;
  await youtube.waitForURL("https://www.youtube.com/");
  await waitHud(youtube, true);
  await press(youtube, "Escape");
  await waitHud(youtube, false);
  await Promise.all([youtube.close(), recovery.close(), page.close()]);
});

test("the sites menu shows a page icon, and falls back to a letter when it cannot load", async () => {
  // Saved sites carry real icon URLs, as recorded by "收藏当前网页". Both are served here.
  await worker.evaluate(() => chrome.storage.local.set({ remoteFavorites: [
    { id: "alpha", title: "Alpha", url: "https://remote-fixture.test/one", icon: "https://remote-fixture.test/alpha.png" },
    { id: "beta", title: "Beta", url: "https://remote-fixture.test/two", icon: "https://remote-fixture.test/beta.png" }] }));
  const page = await sitePage("/");
  await enterBrowser(page);
  await openActions(page);
  await selectGroup(page, "sites");
  assert.equal((await hud(page)).icons, "3");
  const rows = page.locator("#youtube-remote-browser .row");
  assert.equal(await rows.locator(".fav-icon").count(), 3);
  const labels = await rows.evaluateAll(nodes => nodes.map(node => node.textContent));
  assert.ok(labels.some(text => text.includes("Alpha")) && labels.some(text => text.includes("Beta")));
  // YouTube's icon is a cross-origin URL the fixture cannot serve, so it stays on its letter badge;
  // both saved sites resolve their icon and show it over the letter.
  await page.waitForFunction(() => {
    const host = document.querySelector("#youtube-remote-browser");
    const images = [...host.shadowRoot.querySelectorAll(".fav-icon img")];
    return images.length === 2 && images.every(img => img.complete && img.naturalWidth > 0);
  });
  const badges = await rows.locator(".fav-icon").evaluateAll(nodes => nodes.map(node => ({
    width: node.getBoundingClientRect().width, letter: node.textContent.trim(),
    src: node.querySelector("img")?.getAttribute("src") || "" })));
  assert.deepEqual(badges.map(entry => entry.width), [20, 20, 20]);
  assert.deepEqual(badges.map(entry => entry.letter), ["Y", "A", "B"]);
  assert.deepEqual(badges.slice(1).map(entry => entry.src),
    ["https://remote-fixture.test/alpha.png", "https://remote-fixture.test/beta.png"]);
  await page.close();
  // A saved icon that fails to load is dropped, leaving the letter rather than a broken image.
  await context.route("https://remote-fixture.test/broken.png", route => route.fulfill({ status: 404, contentType: "text/plain", body: "" }));
  await worker.evaluate(() => chrome.storage.local.set({ remoteFavorites: [
    { id: "gone", title: "缺失图标", url: "https://remote-fixture.test/three",
      icon: "https://remote-fixture.test/broken.png" }] }));
  const second = await sitePage("/");
  await enterBrowser(second);
  await openActions(second);
  await selectGroup(second, "sites");
  await second.waitForFunction(() => {
    const host = document.querySelector("#youtube-remote-browser");
    const badge = [...host.shadowRoot.querySelectorAll(".fav-icon")].at(-1);
    return !!badge && badge.querySelectorAll("img").length === 0;
  });
  const fallback = await second.evaluate(() => {
    const host = document.querySelector("#youtube-remote-browser");
    const badge = [...host.shadowRoot.querySelectorAll(".fav-icon")].at(-1);
    return { images: badge.querySelectorAll("img").length, letter: badge.textContent.trim(),
      width: badge.getBoundingClientRect().width };
  });
  assert.deepEqual(fallback, { images: 0, letter: "缺", width: 20 });
  await second.close();
});

test("the open tabs list shows a loaded page icon and reserves no space when there is none", async () => {
  await context.route("https://remote-fixture.test/with-icon", route => route.fulfill({ status: 200, contentType: "text/html",
    body: siteFixture.replace("<head>", '<head><link rel="icon" type="image/png" href="/tab-icon.png">') }));
  const withIcon = await context.newPage();
  await withIcon.goto("https://remote-fixture.test/with-icon");
  await withIcon.waitForFunction(() => !!document.querySelector("#heading"));
  await worker.evaluate(async () => {
    for (let i = 0; i < 100; i++) {
      const tab = (await chrome.tabs.query({ url: "https://remote-fixture.test/with-icon" }))[0];
      if (tab?.favIconUrl) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  });
  const plain = await sitePage("/plain");
  await enterBrowser(plain);
  await openActions(plain);
  // The panel opens on the tab list itself.
  assert.equal((await hud(plain)).group, "tabs");
  const rows = plain.locator("#youtube-remote-browser .row");
  await plain.waitForFunction(() => document.querySelector("#youtube-remote-browser").shadowRoot.querySelectorAll(".row").length >= 2);
  const state = await plain.evaluate(() => {
    const host = document.querySelector("#youtube-remote-browser");
    return [...host.shadowRoot.querySelectorAll(".row")].map(row => ({
      badges: row.querySelectorAll(".fav-icon").length,
      visible: [...row.querySelectorAll(".fav-icon")].every(badge => getComputedStyle(badge).display !== "none"),
      letter: [...row.querySelectorAll(".fav-icon")].some(badge => badge.textContent.trim() !== ""),
      src: row.querySelector(".fav-icon img")?.getAttribute("src") || "",
      firstChildIsLabel: row.firstElementChild?.firstElementChild === null || row.firstElementChild?.tagName === "SPAN" }));
  });
  assert.equal(await rows.count(), 2);
  const iconRow = state.find(row => row.src.endsWith("/tab-icon.png"));
  const noIconRows = state.filter(row => !row.src);
  assert.ok(iconRow, JSON.stringify(state));
  assert.equal(iconRow.badges, 1);
  assert.equal(iconRow.visible, true);
  assert.equal(iconRow.letter, false);
  assert.equal(noIconRows.length, 1);
  // No icon means no badge element at all, so no letter and no reserved space.
  assert.equal(noIconRows[0].badges, 0);
  await Promise.all([plain.close(), withIcon.close()]);
});

test("favorite settings save persists and rejects a stale edit", async () => {
  await worker.evaluate(() => chrome.storage.local.remove("remoteFavorites"));
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  await page.locator("#favorite-add").click();
  await page.locator(".favorite-row input").nth(0).fill("常用测试");
  await page.locator(".favorite-row input").nth(1).fill("https://remote-fixture.test/two");
  await page.locator("#favorite-save").click();
  await page.waitForFunction(() => document.querySelector("#favorite-feedback").textContent.includes("已保存"));
  const saved = await worker.evaluate(async () => (await chrome.storage.local.get("remoteFavorites")).remoteFavorites);
  assert.equal(saved[0].title, "常用测试");
  await page.locator(".favorite-row input").nth(0).fill("未保存修改");
  await worker.evaluate(async () => {
    const saved = (await chrome.storage.local.get("remoteFavorites")).remoteFavorites;
    saved[0].title = "外部修改";
    await chrome.storage.local.set({ remoteFavorites: saved });
  });
  await page.locator("#favorite-save").click();
  await page.waitForFunction(() => document.querySelector("#favorite-feedback").textContent.includes("重新加载"));
  assert.equal(await worker.evaluate(async () => (await chrome.storage.local.get("remoteFavorites")).remoteFavorites[0].title), "外部修改");
  await page.close();
});

test("no uncaught page errors", () => assert.deepEqual(errors, []));
