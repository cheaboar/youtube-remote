const { test, before, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("path");
const { chromium } = require("playwright");
const R = require("../../remote.js");

let context, worker;
const errors = [];
before(async () => {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), "youtube-pip-e2e-"));
  const fixture = await fs.readFile(path.join(__dirname, "fixture.html"), "utf8");
  context = await chromium.launchPersistentContext(profile, {
    channel: "chromium", headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
    args: [`--disable-extensions-except=${path.resolve(__dirname, "../..")}`, `--load-extension=${path.resolve(__dirname, "../..")}`, "--autoplay-policy=no-user-gesture-required"],
    viewport: { width: 1100, height: 720 }
  });
  context.setDefaultTimeout(6000);
  worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  await context.route("https://www.youtube.com/**", route => route.fulfill({ status: 200, contentType: "text/html", body: fixture }));
  context.on("page", page => page.on("pageerror", error => errors.push(error.message)));
});
beforeEach(async () => {
  await worker.evaluate(settings => chrome.storage.local.set({ remoteSettings: settings }), R.cloneDefaults());
});
after(async () => { await context?.close(); });

const press = (page, key) => page.keyboard.press(key);
const region = (page, value) => page.waitForFunction(value => document.querySelector("#youtube-remote-status")?.dataset.region === value, value);
const selected = (page, id) => page.waitForFunction(id => document.querySelector(".youtube-keyboard-selected")?.dataset.video === id, id);
const mode = page => page.locator("#youtube-remote-sequences").waitFor({ state: "visible" });
const noMode = page => page.locator("#youtube-remote-sequences").waitFor({ state: "hidden" });
const menuSelected = (page, action) => page.waitForFunction(action => document.querySelector("#youtube-remote-sequences")?.dataset.selected === action, action);
async function pageAt(url) {
  const page = await context.newPage();
  await page.goto(`https://www.youtube.com${url}`);
  await page.waitForFunction(() => !!document.querySelector("#youtube-remote-status"));
  return page;
}
async function enter(page) { await press(page, "Enter"); await press(page, "Enter"); await mode(page); }
const prefix = (page, count) => page.waitForFunction(count => document.querySelector("#youtube-remote-sequences")?.dataset.candidates === String(count), count);
async function choose(page, action) {
  const actions = await page.locator("#youtube-remote-sequences .row").evaluateAll(rows => rows.map(row => row.dataset.action));
  const current = await page.locator("#youtube-remote-sequences").getAttribute("data-selected");
  const distance = actions.indexOf(action) - actions.indexOf(current);
  assert.ok(actions.includes(action));
  for (let i = 0; i < Math.abs(distance); i++) await press(page, distance > 0 ? "ArrowDown" : "ArrowUp");
  await menuSelected(page, action);
}
async function fakePage(page, height = 2400) {
  await page.waitForFunction(() => document.querySelector("video")?.readyState >= 2);
  await page.evaluate(height => {
    // Content scripts run in an isolated world, so native PiP cannot be stubbed from the page.
    // Headless Chromium rejects native PiP; the player button is the extension's fallback path.
    window.pipClicks = 0;
    const button = document.createElement("button");
    button.className = "ytp-pip-button"; button.textContent = "画中画";
    button.onclick = () => { window.pipClicks++; };
    document.querySelector("#movie_player").append(button);
    const flexy = document.querySelector("ytd-watch-flexy");
    const spacer = document.createElement("div"); spacer.style.height = `${height}px`;
    const comments = document.createElement("ytd-comments"); comments.id = "comments";
    comments.style.cssText = "display:block;height:400px"; comments.textContent = "评论区";
    const tail = document.createElement("div"); tail.style.height = "1600px";
    flexy.append(spacer, comments, tail);
  }, height);
}

test("picture in picture scrolls to comments, restores playback and can jump to the page top", async () => {
  const page = await pageAt("/watch?v=p0"); await region(page, "player");
  await fakePage(page);
  await enter(page);
  for (const key of ["ArrowLeft", "ArrowRight", "ArrowRight"]) await press(page, key);
  await prefix(page, 4);
  await press(page, "ArrowLeft"); await noMode(page);
  await region(page, "comments");
  await page.waitForFunction(() => scrollY > 500 && window.pipClicks >= 1);

  const top = await page.evaluate(() => scrollY);
  await press(page, "ArrowDown");
  await page.waitForFunction(y => scrollY > y, top);
  const lower = await page.evaluate(() => scrollY);
  await press(page, "ArrowUp");
  await page.waitForFunction(y => scrollY < y, lower);

  await press(page, "Alt+Shift+r");
  await region(page, "player");
  await page.waitForFunction(() => scrollY === 0);

  await page.evaluate(() => window.scrollTo(0, 900));
  await page.waitForFunction(() => scrollY > 800);
  await enter(page);
  for (const key of ["ArrowLeft", "ArrowRight", "ArrowRight", "ArrowDown"]) await press(page, key);
  await noMode(page);
  await page.waitForFunction(() => scrollY === 0);
  assert.equal(await page.evaluate(() => document.querySelector("#youtube-remote-status")?.dataset.region), "player");

  await enter(page);
  for (const key of ["ArrowLeft", "ArrowRight", "ArrowRight", "ArrowLeft"]) await press(page, key);
  await noMode(page); await region(page, "comments");
  await press(page, "Escape");
  await region(page, "player");
  await page.waitForFunction(() => scrollY === 0 && window.pipClicks >= 2);
  await page.close();
});

test("picture in picture is limited to watch pages and falls back to the native player button", async () => {
  const list = await pageAt("/"); await selected(list, "v0");
  await enter(list); await choose(list, "pipComments"); await press(list, "Enter"); await noMode(list);
  assert.match(await list.locator("#youtube-remote-status [role='status']").textContent(), /仅在视频播放页/);
  await list.close();

  const page = await pageAt("/watch?v=p0"); await region(page, "player");
  await page.waitForFunction(() => document.querySelector("video")?.readyState >= 2);
  await page.evaluate(() => {
    window.pipFallback = 0;
    Object.defineProperty(document, "pictureInPictureElement", { configurable: true, get: () => null });
    HTMLVideoElement.prototype.requestPictureInPicture = () => Promise.reject(new Error("denied"));
    const button = document.createElement("button");
    button.className = "ytp-pip-button"; button.textContent = "画中画";
    button.onclick = () => { window.pipFallback++; };
    document.querySelector("#movie_player").append(button);
    const flexy = document.querySelector("ytd-watch-flexy");
    const spacer = document.createElement("div"); spacer.style.height = "1800px";
    const comments = document.createElement("ytd-comments"); comments.id = "comments";
    comments.style.cssText = "display:block;height:400px"; comments.textContent = "评论区";
    const tail = document.createElement("div"); tail.style.height = "1600px";
    flexy.append(spacer, comments, tail);
  });
  await enter(page); await choose(page, "pipComments"); await press(page, "Enter"); await noMode(page);
  await region(page, "comments");
  await page.waitForFunction(() => window.pipFallback === 1 && scrollY > 500);
  await page.close();
});

test("picture in picture pages have no uncaught errors", () => assert.deepEqual(errors, []));
