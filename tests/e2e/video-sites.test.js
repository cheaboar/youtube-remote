const { test, before, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright");

const root = path.resolve(__dirname, "../..");
const EXTENSION_FILES = ["background.js", "browser.js", "command-panel.js", "content.js", "content.css",
  "douyin-content.js", "douyin.js", "bilibili.js", "youku.js", "video-site-content.js", "navigation.js",
  "remote.js", "recovery.html", "recovery.js", "recovery.css", "youtube.js",
  "options.html", "options.css", "options.js", "popup.html", "popup.css", "popup.js", "manifest.json"];
let extensionDir, context, page;
const errors = [];

const biliCard = (id, text) => `<div class="bili-video-card"><a href="https://www.bilibili.com/video/${id}">${text}</a></div>`;
const biliHome = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
  *{box-sizing:border-box}body{margin:0;background:#f6f7f8;color:#18191c;font:14px sans-serif}
  header{height:64px;line-height:64px;padding:0 20px}
  .bili-feed{display:grid;grid-template-columns:repeat(3,300px);gap:20px;padding:20px}
  .bili-video-card{width:300px;height:200px;background:#e3e5e7;border:1px solid #c9ccd0}
  .bili-video-card a{display:flex;width:100%;height:100%;align-items:center;justify-content:center;color:#18191c}
</style></head><body><header>哔哩哔哩</header>
<div class="bili-feed">${[101, 202, 303, 404, 505, 606].map((id, index) => biliCard(`BV${id}`, String(index + 1))).join("")}</div>
</body></html>`;

const biliRail = (id, text) => `<div class="video-page-card-small"><a href="https://www.bilibili.com/video/${id}">${text}</a></div>`;
const biliVideo = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
  *{box-sizing:border-box}body{margin:0;background:#fff;color:#18191c;font:14px sans-serif}
  #bilibili-player{width:1000px;height:560px;background:#000}
  #bilibili-player video{display:block;width:100%;height:100%}
  .video-toolbar{display:flex;gap:8px;padding:16px}
  #commentapp{height:300px;margin:16px;background:#eef0f2}
  .recommend-list-v1{position:fixed;right:20px;top:100px;width:280px}
  .video-page-card-small{width:280px;height:90px;margin:0 0 10px;background:#e3e5e7}
  .video-page-card-small a{display:block;width:100%;height:100%;color:#18191c}
</style></head><body>
<div id="bilibili-player" class="bpx-player-container"><video muted></video>
  <button class="bpx-player-ctrl-web" onclick="window.clicks.web=(window.clicks.web||0)+1">网页全屏</button>
  <input class="bui-danmaku-switch-input" type="checkbox" checked>
</div>
<div class="video-toolbar">
  <button class="video-like">赞</button><button class="video-coin">币</button>
  <button class="video-fav">藏</button><button class="video-share-wrap">享</button>
</div>
<div id="commentapp">评论</div>
<div style="height:1800px"></div>
<div class="recommend-list-v1">${biliRail("BV777", "右侧 1")}${biliRail("BV888", "右侧 2")}${biliRail("BV999", "右侧 3")}</div>
<script>
  window.clicks = { like: 0, coin: 0, fav: 0, share: 0 };
  const controls = { "video-like": "like", "video-coin": "coin", "video-fav": "fav", "video-share-wrap": "share" };
  addEventListener("click", event => {
    const control = event.target.closest?.(".video-like,.video-coin,.video-fav,.video-share-wrap");
    const key = control && controls[control.classList[0]];
    if (key) window.clicks[key] += 1;
  });
</script>
</body></html>`;

const youkuCard = (id, text) => `<div class="yk_card_item"><a href="https://v.youku.com/video?vid=${id}">${text}</a></div>`;
const youkuHome = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
  *{box-sizing:border-box}body{margin:0;background:#fff;color:#111;font:14px sans-serif}
  header{height:64px;line-height:64px;padding:0 20px}
  .module_container{display:flex;gap:20px;padding:16px 10px;overflow:hidden}
  .yk_card_item{flex:none;width:300px;height:180px;background:#eceff2;border:1px solid #d6dade}
  .yk_card_item a{display:flex;width:100%;height:100%;align-items:center;justify-content:center;color:#111}
</style></head><body><header>优酷</header>
<div class="module_container">${youkuCard(11, "1")}${youkuCard(22, "2")}${youkuCard(33, "3")}${youkuCard(44, "4")}</div>
<div class="module_container" style="padding-top:0">${youkuCard(55, "5")}${youkuCard(66, "6")}${youkuCard(77, "7")}</div>
</body></html>`;

const youkuRail = (id, text) => `<a class="new-pic-text-item" style="display:block;width:280px;height:100px;margin:0 0 10px;background:#e6e9ec" href="https://v.youku.com/video?vid=${id}">${text}</a>`;
const youkuVideo = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
  *{box-sizing:border-box}body{margin:0;background:#fff;color:#111;font:14px sans-serif}
  .player-container{width:1000px;height:560px;background:#000}
  .player-container video{display:block;width:100%;height:100%}
  .side{position:fixed;right:20px;top:100px;width:300px}
</style></head><body>
<div class="player-container"><video muted></video>
  <i class="kui-webfullscreen-icon-0" style="display:inline-block;width:30px;height:20px" onclick="window.clicks.web=(window.clicks.web||0)+1">网页全屏</i>
</div>
<div class="anthology"><div class="box-anthology-item active">第 1 集</div><div class="box-anthology-item" onclick="window.clicks.next=(window.clicks.next||0)+1">第 2 集</div></div>
<div style="height:2400px"></div>
<div class="side">${youkuRail(777, "右侧 1")}${youkuRail(888, "右侧 2")}${youkuRail(555, "当前视频")}</div>
<script>window.clicks = { web: 0, next: 0 };</script>
</body></html>`;

// The browser-mode entry needs the optional all-sites grant on non-YouTube origins. Headless
// Chromium cannot show the consent prompt, so the suite loads a temporary copy whose manifest
// already grants both web schemes; the content-script entries are unchanged.
async function buildExtension() {
  extensionDir = await fs.mkdtemp(path.join(os.tmpdir(), "youtube-video-sites-ext-"));
  for (const file of EXTENSION_FILES) await fs.copyFile(path.join(root, file), path.join(extensionDir, file));
  await fs.cp(path.join(root, "icons"), path.join(extensionDir, "icons"), { recursive: true });
  const manifest = JSON.parse(await fs.readFile(path.join(root, "manifest.json"), "utf8"));
  manifest.host_permissions = ["http://*/*", "https://*/*"];
  delete manifest.optional_host_permissions;
  await fs.writeFile(path.join(extensionDir, "manifest.json"), JSON.stringify(manifest, null, 2));
}

before(async () => {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), "youtube-video-sites-e2e-"));
  await buildExtension();
  context = await chromium.launchPersistentContext(profile, {
    channel: "chromium", headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
    args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`],
    viewport: { width: 1100, height: 800 }
  });
  context.setDefaultTimeout(8000);
  await context.route("https://www.bilibili.com/**", route => {
    const url = new URL(route.request().url());
    const body = url.pathname.startsWith("/video/") ? biliVideo : biliHome;
    return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body });
  });
  await context.route("https://www.youku.com/**", route =>
    route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: youkuHome }));
  await context.route("https://v.youku.com/**", route =>
    route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: youkuVideo }));
  context.on("page", target => target.on("pageerror", error => errors.push(`${target.url()}: ${error.message}`)));
  page = await context.newPage();
});
beforeEach(async () => {
  await page.goto("https://www.bilibili.com/");
  await page.evaluate(() => sessionStorage.clear());
  await page.reload();
  await page.waitForFunction(() => !!document.querySelector("#bilibili-remote-status"));
});
after(async () => { await context?.close(); });

const biliSelected = () => page.evaluate(() =>
  document.querySelector(".bilibili-keyboard-selected a")?.textContent || "");
const youkuSelected = () => page.evaluate(() =>
  document.querySelector(".youku-keyboard-selected a")?.textContent || "");

test("arrow keys move through the Bilibili feed grid", async () => {
  await page.waitForFunction(() =>
    document.querySelector("#bilibili-remote-status")?.dataset.region === "list");
  await page.keyboard.press("ArrowDown");
  await page.waitForFunction(() => !!document.querySelector(".bilibili-keyboard-selected"));
  assert.equal(await biliSelected(), "1");

  await page.keyboard.press("ArrowRight");
  assert.equal(await biliSelected(), "2");
  await page.keyboard.press("ArrowDown");
  assert.equal(await biliSelected(), "5");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowUp");
  assert.equal(await biliSelected(), "1");
});

test("Enter opens a Bilibili video and going back restores the selection", async () => {
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowDown");
  assert.equal(await biliSelected(), "5");

  await page.keyboard.press("Enter");
  await page.waitForURL("https://www.bilibili.com/video/BV505", { timeout: 4000 });
  await page.waitForFunction(() =>
    document.querySelector("#bilibili-remote-status")?.dataset.region === "player");

  await page.keyboard.press("Escape");
  await page.waitForURL("https://www.bilibili.com/", { timeout: 4000 });
  await page.waitForFunction(() => !!document.querySelector(".bilibili-keyboard-selected"));
  assert.equal(await biliSelected(), "5");
});

test("Bilibili player volume, right rail and single confirm stay distinct", async () => {
  await page.goto("https://www.bilibili.com/video/BV101");
  await page.waitForFunction(() =>
    document.querySelector("#bilibili-remote-status")?.dataset.region === "player");

  await page.evaluate(() => { document.querySelector("video").volume = 0.5; });
  await page.keyboard.press("ArrowUp");
  await page.waitForFunction(() => document.querySelector("video").volume > 0.55);
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(600);
  await page.waitForFunction(() => document.querySelector("video").volume <= 0.55);

  // A quick second ↓ opens the rail without waiting for the volume change.
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.waitForFunction(() =>
    document.querySelector("#bilibili-remote-status")?.dataset.rail === "1");
  assert.equal(await page.evaluate(() => window.scrollY), 0);
  assert.equal(await page.evaluate(() =>
    document.querySelector(".bilibili-keyboard-selected a")?.getAttribute("href")),
    "https://www.bilibili.com/video/BV777");

  await page.keyboard.press("ArrowDown");
  assert.equal(await page.evaluate(() =>
    document.querySelector(".bilibili-keyboard-selected a")?.getAttribute("href")),
    "https://www.bilibili.com/video/BV888");
  await page.keyboard.press("Escape");
  assert.equal(await page.evaluate(() =>
    document.querySelector("#bilibili-remote-status")?.dataset.rail), "0");
  assert.equal(page.url(), "https://www.bilibili.com/video/BV101");

  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await page.waitForURL("https://www.bilibili.com/video/BV777", { timeout: 4000 });
});

async function openPanel(id) {
  await page.goto(`https://www.bilibili.com/video/${id}`);
  await page.waitForFunction(() =>
    document.querySelector("#bilibili-remote-status")?.dataset.region === "player");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() =>
    document.querySelector("#bilibili-remote-panel")?.dataset.open === "1");
}
const panelState = () => page.evaluate(() => {
  const node = document.querySelector("#bilibili-remote-panel");
  return node && { open: node.dataset.open, selected: node.dataset.selected,
    prefix: node.dataset.prefix || "", candidates: Number(node.dataset.candidates),
    total: Number(node.dataset.total), hidden: node.hidden };
});

test("double Enter opens the Bilibili playback panel with only live controls", async () => {
  await openPanel("BV101");
  const state = await panelState();
  assert.equal(state.selected, "togglePlayback");
  assert.equal(state.total, 19);
  assert.equal(await page.evaluate(() =>
    document.querySelector("#bilibili-remote-status").hidden), true);
  assert.equal(await page.evaluate(() =>
    document.querySelector("#youtube-remote-browser")?.hidden ?? true), true);

  const groups = await page.evaluate(() =>
    [...document.querySelector("#bilibili-remote-panel").shadowRoot.querySelectorAll("[data-group]")]
      .map(node => node.dataset.group));
  assert.deepEqual(groups, ["playback", "interact", "pick", "nav"]);

  await page.keyboard.press("ArrowDown");
  assert.equal((await panelState()).selected, "seekBackward");
  await page.keyboard.press("Escape");
  await page.waitForFunction(() =>
    document.querySelector("#bilibili-remote-panel")?.dataset.open === "0");
});

test("Bilibili panel executes a sequence and filters by prefix", async () => {
  await openPanel("BV101");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await page.waitForFunction(() => window.clicks?.like === 1);
  assert.equal(await page.evaluate(() =>
    document.querySelector("#bilibili-remote-panel").hidden), true);

  await openPanel("BV101");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowUp");
  assert.deepEqual(await panelState().then(s => [s.prefix, s.candidates]),
    ["ArrowRight,ArrowUp", 4]);
  await page.keyboard.press("Backspace");
  assert.equal((await panelState()).prefix, "ArrowRight");
  await page.keyboard.press("Escape");
});

test("Bilibili two-key sequence mutes the player without touching account controls", async () => {
  await openPanel("BV101");
  await page.evaluate(() => { document.querySelector("video").muted = false; });
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowDown");
  await page.waitForFunction(() => document.querySelector("video").muted === true);
  assert.equal(await page.evaluate(() => window.clicks.like + window.clicks.coin +
    window.clicks.fav + window.clicks.share), 0);
});

test("Bilibili panel toggles danmaku and web fullscreen", async () => {
  await openPanel("BV101");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowLeft");
  await page.waitForFunction(() =>
    document.querySelector(".bui-danmaku-switch-input")?.checked === false);

  await openPanel("BV101");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowRight");
  await page.waitForFunction(() => window.clicks?.web === 1);
});

test("the Bilibili player needs a triple confirm before browser mode", async () => {
  await page.goto("https://www.bilibili.com/video/BV101");
  await page.waitForFunction(() =>
    document.querySelector("#bilibili-remote-status")?.dataset.region === "player");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() =>
    document.querySelector("#bilibili-remote-panel")?.dataset.open === "1");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() =>
    document.querySelector("#youtube-remote-browser") && !document.querySelector("#youtube-remote-browser").hidden);
  await page.keyboard.press("Escape");
  await page.waitForFunction(() =>
    document.querySelector("#youtube-remote-browser")?.hidden === true);
});

test("Youku carousels only select cards that are fully on screen", async () => {
  await page.goto("https://www.youku.com/ku/webhome");
  await page.waitForFunction(() => !!document.querySelector("#youku-remote-status"));
  assert.equal(await page.evaluate(() =>
    document.querySelector("#youku-remote-status").dataset.region), "list");

  await page.keyboard.press("ArrowDown");
  await page.waitForFunction(() => !!document.querySelector(".youku-keyboard-selected"));
  assert.equal(await youkuSelected(), "1");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  assert.equal(await youkuSelected(), "3");
  // The fourth card is clipped by the carousel, so it is not selectable.
  await page.keyboard.press("ArrowRight");
  assert.equal(await youkuSelected(), "3");
  assert.equal(await page.evaluate(() => window.scrollX), 0);
  assert.equal(await page.evaluate(() => document.querySelector(".module_container").scrollLeft), 0);

  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  assert.equal(await youkuSelected(), "1");
  await page.keyboard.press("ArrowDown");
  assert.equal(await youkuSelected(), "5");
});

test("Youku player uses the shared rail gesture and a panel without missing controls", async () => {
  await page.goto("https://v.youku.com/video?vid=555");
  await page.waitForFunction(() =>
    document.querySelector("#youku-remote-status")?.dataset.region === "player");

  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.waitForFunction(() =>
    document.querySelector("#youku-remote-status")?.dataset.rail === "1");
  assert.equal(await page.evaluate(() =>
    document.querySelector(".youku-keyboard-selected")?.getAttribute("href")),
    "https://v.youku.com/video?vid=777");

  await page.keyboard.press("Escape");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() =>
    document.querySelector("#youku-remote-panel")?.dataset.open === "1");
  const state = await page.evaluate(() => {
    const node = document.querySelector("#youku-remote-panel");
    const groups = [...node.shadowRoot.querySelectorAll("[data-group]")].map(item => item.dataset.group);
    return { total: Number(node.dataset.total), groups };
  });
  assert.equal(state.total, 14);
  assert.deepEqual(state.groups, ["playback", "pick", "nav"]);

  await page.evaluate(() => { document.querySelector("video").muted = false; });
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowDown");
  await page.waitForFunction(() => document.querySelector("video").muted === true);
  assert.equal(page.url(), "https://v.youku.com/video?vid=555");
});

test("Youku panel opens the next episode and web fullscreen", async () => {
  await page.goto("https://v.youku.com/video?vid=555");
  await page.waitForFunction(() =>
    document.querySelector("#youku-remote-status")?.dataset.region === "player");

  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() =>
    document.querySelector("#youku-remote-panel")?.dataset.open === "1");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowRight");
  await page.waitForFunction(() => window.clicks?.next === 1);

  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() =>
    document.querySelector("#youku-remote-panel")?.dataset.open === "1");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowRight");
  await page.waitForFunction(() => window.clicks?.web === 1);
});

test("no page errors from the Bilibili or Youku controllers", () => {
  assert.deepEqual(errors, []);
});
