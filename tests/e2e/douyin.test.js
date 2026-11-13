const { test, before, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright");

const root = path.resolve(__dirname, "../..");
const errors = [];
let context, page;

const card = (id, text) => `<div class="discover-video-card-item" data-aweme-id="${id}">` +
  `<div class="jingxuanVideoCard" href="//www.douyin.com/video/${id}">${text}</div></div>`;
// Douyin's left rail: its entries are the only links that carry `from_nav`.
const navEntry = (label, path) => `<div class="tab-${label}"><a class="ALink-a" href="//www.douyin.com${path}?from_nav=1">${label}</a></div>`;
const nav = `<div data-e2e="douyin-navigation"><div class="nav-scroll">${
  [["精选", "/jingxuan"], ["推荐", "/?recommend=1"], ["关注", "/follow"], ["朋友", "/friend"],
    ["我的", "/user/self"], ["直播", "/vs"]].map(([label, path]) => navEntry(label, path)).join("")}
  <a class="ALink-a" href="//beian.miit.gov.cn/">京ICP备16016397号-3</a>
</div></div>`;
const grid = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
  *{box-sizing:border-box}body{margin:0;background:#161823;color:#fff;font:14px sans-serif}
  header{height:56px;line-height:56px;padding:0 20px}
  [data-e2e="douyin-navigation"]{position:fixed;left:0;top:56px;width:160px;height:700px;overflow-y:auto;background:#1b1d26}
  .nav-scroll{padding:8px}
  .nav-scroll a{display:block;height:40px;line-height:40px;padding-left:12px;color:#fff;text-decoration:none}
  .feed{display:grid;grid-template-columns:repeat(3,300px);gap:20px;padding:20px 20px 20px 180px}
  .discover-video-card-item{width:300px;height:200px;background:#333;border:1px solid #555}
  .jingxuanVideoCard{width:100%;height:100%;display:flex;align-items:center;justify-content:center;cursor:pointer}
  .hero{position:fixed;left:20px;bottom:20px;width:760px;height:420px;background:#222;pointer-events:none}
</style></head><body><header>抖音精选</header>${nav}
<div class="jingxuanFeedList"><div class="jingxuan-scroll-element"><div class="feed">
${[111, 222, 333, 444, 555, 666].map((id, index) => card(id, String(index + 1))).join("")}
</div></div></div>
<video class="hero" muted></video></body></html>`;

const rail = (id, text) => `<li><a href="//www.douyin.com/video/${id}">${text}</a></li>`;
const video = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
  body{margin:0;background:#000;color:#fff}video{display:block;width:1100px;height:560px;background:#222}
  .route-scroll-container{height:800px;overflow-y:auto}
  .controls{position:fixed;left:20px;top:20px;display:flex;gap:6px;z-index:2}
  [data-e2e="related-video"]{position:fixed;top:100px;right:20px;width:240px;background:#111}
  [data-e2e="related-video"] ul{list-style:none;margin:0;padding:0}
  [data-e2e="related-video"] li{width:240px;height:90px;margin:0 0 10px;background:#333}
  [data-e2e="related-video"] a{display:block;width:100%;height:100%;color:#fff}
  [data-e2e="douyin-navigation"]{position:fixed;left:0;top:0;width:160px;height:700px;overflow-y:auto;background:#1b1d26}
  .nav-scroll a{display:block;height:40px;line-height:40px;padding-left:12px;color:#fff;text-decoration:none}
</style></head><body><div class="route-scroll-container"><video></video><div style="height:2400px"></div>
<div data-e2e="comment-list" style="height:200px">评论列表</div></div>
<div class="controls">
  <button data-e2e="video-player-digg">赞</button><button data-e2e="video-player-collect">藏</button>
  <button data-e2e="video-player-share">享</button><button data-e2e="feed-comment-icon">评</button>
  <button data-e2e="xgplayer-page-full-screen">页全屏</button>
  <button data-e2e="video-switch-prev-arrow">上一条</button><button data-e2e="video-switch-next-arrow">下一条</button>
  <span data-e2e="user-info"><button type="button">关注</button></span>
</div>
<div data-e2e="related-video"><ul>${rail(555, "当前视频")}${rail(777, "右侧 1")}${rail(888, "右侧 2")}</ul></div>
${nav}
<script>
  // Mimic Douyin: its own ↓ shortcut switches to the next video. The extension must claim
  // the key first, so neither single paging nor the double-tap rail gesture can trigger this.
  addEventListener("keydown", event => {
    if (event.key === "ArrowDown" && !event.defaultPrevented) location.assign("https://www.douyin.com/video/999");
  });
  window.clicks = { digg: 0, collect: 0, share: 0, comment: 0, pageFullscreen: 0, follow: 0, prev: 0, next: 0 };
  const keys = { "video-player-digg": "digg", "video-player-collect": "collect", "video-player-share": "share",
    "feed-comment-icon": "comment", "xgplayer-page-full-screen": "pageFullscreen",
    "video-switch-prev-arrow": "prev", "video-switch-next-arrow": "next" };
  addEventListener("click", event => {
    const control = event.target.closest?.("[data-e2e]");
    const key = control && keys[control.dataset.e2e];
    if (key) window.clicks[key] += 1;
  });
  document.querySelector('[data-e2e="user-info"] button')
    .addEventListener("click", () => { window.clicks.follow += 1; });
</script>
</body></html>`;

before(async () => {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), "youtube-douyin-e2e-"));
  context = await chromium.launchPersistentContext(profile, {
    channel: "chromium", headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`],
    viewport: { width: 1100, height: 800 }
  });
  context.setDefaultTimeout(8000);
  await context.route("https://www.douyin.com/jingxuan*", route =>
    route.fulfill({ status: 200, contentType: "text/html", body: grid }));
  await context.route("https://www.douyin.com/follow*", route =>
    route.fulfill({ status: 200, contentType: "text/html", body: grid }));
  await context.route("https://www.douyin.com/video/*", route =>
    route.fulfill({ status: 200, contentType: "text/html", body: video }));
  context.on("page", target => target.on("pageerror", error => errors.push(`${target.url()}: ${error.message}`)));
  page = await context.newPage();
});
beforeEach(async () => {
  await page.goto("https://www.douyin.com/jingxuan");
  await page.evaluate(() => sessionStorage.clear());
  await page.reload();
  await page.waitForFunction(() => !!document.querySelector("#douyin-remote-status"));
});
after(async () => { await context?.close(); });

const selectedText = () => page.evaluate(() =>
  document.querySelector(".douyin-keyboard-selected .jingxuanVideoCard")?.textContent || "");

test("arrow keys move the selection through the Douyin jingxuan grid", async () => {
  // A large autoplaying preview must not turn the grid into player mode.
  await page.waitForFunction(() =>
    document.querySelector("#douyin-remote-status")?.dataset.region === "list");
  const volume = await page.evaluate(() => document.querySelector(".hero").volume);
  await page.keyboard.press("ArrowDown");
  await page.waitForFunction(() => !!document.querySelector(".douyin-keyboard-selected"));
  assert.equal(await selectedText(), "1");
  assert.equal(await page.evaluate(() => document.querySelector(".hero").volume), volume);

  await page.keyboard.press("ArrowRight");
  assert.equal(await selectedText(), "2");

  await page.keyboard.press("ArrowDown");
  assert.equal(await selectedText(), "5");

  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowUp");
  assert.equal(await selectedText(), "1");
});

test("Enter opens the selected video and going back restores the selection", async () => {  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowDown");
  assert.equal(await selectedText(), "5");

  await page.keyboard.press("Enter");
  await page.waitForURL("https://www.douyin.com/video/555", { timeout: 4000 });
  await page.waitForFunction(() =>
    document.querySelector("#douyin-remote-status")?.dataset.region === "player");

  // A single ↓ pages the video page's own scroll container; it never changes the volume.
  const scrollTop = () => page.evaluate(() => document.querySelector(".route-scroll-container").scrollTop);
  const volume = await page.evaluate(() => document.querySelector("video").volume);
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(600);
  assert.ok(await scrollTop() > 0);
  assert.equal(await page.evaluate(() => document.querySelector("video").volume), volume);
  assert.equal(page.url(), "https://www.douyin.com/video/555");
  await page.keyboard.press("ArrowUp");
  assert.equal(await scrollTop(), 0);

  await page.keyboard.press("Escape");
  await page.waitForURL("https://www.douyin.com/jingxuan", { timeout: 4000 });
  await page.waitForFunction(() => !!document.querySelector(".douyin-keyboard-selected"));
  assert.equal(await selectedText(), "5");
});

test("double down selects right-rail cards and Enter opens the chosen one", async () => {  await page.goto("https://www.douyin.com/video/555");
  await page.waitForFunction(() =>
    document.querySelector("#douyin-remote-status")?.dataset.region === "player");

  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.waitForFunction(() => document.querySelector("#douyin-remote-status")?.dataset.rail === "1");
  const selectedHref = () => page.evaluate(() =>
    document.querySelector(".douyin-keyboard-selected a")?.getAttribute("href"));
  // The double tap enters the rail without paging the page or switching the playing video.
  assert.equal(await page.evaluate(() => document.querySelector(".route-scroll-container").scrollTop), 0);
  assert.equal(page.url(), "https://www.douyin.com/video/555");
  // The rail's copy of the current video is skipped.
  assert.equal(await selectedHref(), "//www.douyin.com/video/777");

  await page.keyboard.press("Escape");
  assert.equal(await page.evaluate(() =>
    document.querySelector("#douyin-remote-status")?.dataset.rail), "0");
  assert.equal(page.url(), "https://www.douyin.com/video/555");

  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  assert.equal(await selectedHref(), "//www.douyin.com/video/888");

  await page.keyboard.press("Enter");
  await page.waitForURL("https://www.douyin.com/video/888", { timeout: 4000 });
});

const navLabel = () => page.evaluate(() =>
  document.querySelector(".douyin-keyboard-selected")?.textContent?.trim() || "");
const navOpen = () => page.waitForFunction(() =>
  document.querySelector("#douyin-remote-status")?.dataset.nav === "1");

// Walk ← until the left navigation takes over. The grid starts on whatever card was restored,
// so the number of steps depends on the column the selection sits in.
async function enterNavKeys() {
  if (!(await page.evaluate(() => !!document.querySelector(".douyin-keyboard-selected"))))
    await page.keyboard.press("ArrowDown");
  for (let step = 0; step < 4; step += 1) {
    if (await page.evaluate(() => document.querySelector("#douyin-remote-status")?.dataset.nav === "1")) return;
    await page.keyboard.press("ArrowLeft");
    await page.waitForTimeout(180);
  }
  await navOpen();
}

test("left at the row edge enters the left navigation and Right returns to the video", async () => {
  await enterNavKeys();
  // The current page's entry (精选) is the starting point, and the footer links stay out.
  assert.equal(await navLabel(), "精选");
  assert.equal(await page.evaluate(() => document.querySelectorAll(".douyin-keyboard-selected").length), 1);

  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  assert.equal(await navLabel(), "关注");
  await page.keyboard.press("ArrowUp");
  assert.equal(await navLabel(), "推荐");

  // → hands the selection back to the video that was current before entering the rail.
  await page.keyboard.press("ArrowRight");
  await page.waitForFunction(() =>
    document.querySelector("#douyin-remote-status")?.dataset.nav === "0");
  assert.ok(await selectedText());
  assert.equal(page.url(), "https://www.douyin.com/jingxuan");
});

test("Enter opens a navigation entry and Esc returns to the videos", async () => {
  await enterNavKeys();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  assert.equal(await navLabel(), "关注");

  await page.keyboard.press("Enter");
  await page.waitForURL("https://www.douyin.com/follow*", { timeout: 4000 });

  // Back on the grid, ← reopens the rail on the entry picked last time.
  await page.waitForFunction(() =>
    document.querySelector("#douyin-remote-status")?.dataset.region === "list");
  await page.waitForFunction(() => !!document.querySelector(".douyin-keyboard-selected"));
  await enterNavKeys();
  assert.equal(await navLabel(), "关注");

  await page.keyboard.press("Escape");
  await page.waitForFunction(() =>
    document.querySelector("#douyin-remote-status")?.dataset.nav === "0");
  assert.equal(page.url(), "https://www.douyin.com/follow?from_nav=1");
});

test("the guide key and panel entry open the left navigation on the video page", async () => {
  await page.goto("https://www.douyin.com/video/555");
  await page.waitForFunction(() =>
    document.querySelector("#douyin-remote-status")?.dataset.region === "player");

  await page.keyboard.press("Alt+Shift+g");
  await navOpen();
  assert.equal(await navLabel(), "精选");
  // While the rail owns the keys a second ↓ is just another move, not the rail gesture.
  await page.keyboard.press("ArrowDown");
  assert.equal(await navLabel(), "推荐");
  await page.keyboard.press("Escape");
  await page.waitForFunction(() =>
    document.querySelector("#douyin-remote-status")?.dataset.nav === "0");
  assert.equal(page.url(), "https://www.douyin.com/video/555");

  await openCommandPanel();
  await selectPanelAction("guide");
  await page.keyboard.press("Enter");
  await navOpen();
  // The entry picked last time (推荐) is remembered across the two openings.
  assert.equal(await navLabel(), "推荐");
  await page.keyboard.press("Escape");
  await page.waitForFunction(() =>
    document.querySelector("#douyin-remote-status")?.dataset.nav === "0");
});

async function openCommandPanel() {
  await page.goto("https://www.douyin.com/video/555");
  await page.waitForFunction(() =>
    document.querySelector("#douyin-remote-status")?.dataset.region === "player");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() =>
    document.querySelector("#douyin-remote-panel")?.dataset.open === "1");
}

async function selectPanelAction(action) {
  for (let index = 0; index < 40; index += 1) {
    const current = await page.evaluate(() =>
      document.querySelector("#douyin-remote-panel")?.dataset.selected);
    if (current === action) return;
    await page.keyboard.press("ArrowDown");
  }
  throw new Error(`panel action ${action} was not listed`);
}

test("double Enter opens the playback command panel without entering browser mode", async () => {
  await openCommandPanel();
  const state = await page.evaluate(() => ({
    selected: document.querySelector("#douyin-remote-panel").dataset.selected,
    candidates: Number(document.querySelector("#douyin-remote-panel").dataset.candidates),
    hudHidden: document.querySelector("#douyin-remote-status").hidden,
    browserHidden: document.querySelector("#youtube-remote-browser")?.hidden ?? true
  }));
  assert.equal(state.selected, "togglePlayback");
  assert.ok(state.candidates >= 15, `expected the full command catalog, got ${state.candidates}`);
  // The status HUD yields to the panel; the double tap must not open browser mode.
  assert.equal(state.hudHidden, true);
  assert.equal(state.browserHidden, true);

  await page.keyboard.press("ArrowDown");
  assert.equal(await page.evaluate(() =>
    document.querySelector("#douyin-remote-panel").dataset.selected), "seekBackward");
  assert.equal(page.url(), "https://www.douyin.com/video/555");

  await page.keyboard.press("Escape");
  await page.waitForFunction(() =>
    document.querySelector("#douyin-remote-panel")?.dataset.open === "0");
  assert.equal(await page.evaluate(() =>
    document.querySelector("#douyin-remote-panel").hidden), true);
});

test("the command panel executes the selected playback-page control", async () => {
  await openCommandPanel();
  await selectPanelAction("like");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => window.clicks?.digg === 1);
  assert.equal(await page.evaluate(() => document.querySelector("#douyin-remote-panel").hidden), true);
  assert.equal(page.url(), "https://www.douyin.com/video/555");
});

test("the command panel can mute the player and execute paging", async () => {
  await openCommandPanel();
  await selectPanelAction("mute");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector("video").muted === true);
  assert.equal(page.url(), "https://www.douyin.com/video/555");

  const scrollTop = () => page.evaluate(() =>
    document.querySelector(".route-scroll-container").scrollTop);
  assert.equal(await scrollTop(), 0);
  // Reopen in place: the page must not reload between panel commands.
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() =>
    document.querySelector("#douyin-remote-panel")?.dataset.open === "1");
  await selectPanelAction("pageDown");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() =>
    document.querySelector(".route-scroll-container").scrollTop > 0);
});

const panelState = () => page.evaluate(() => {
  const node = document.querySelector("#douyin-remote-panel");
  return node && {
    open: node.dataset.open, selected: node.dataset.selected,
    prefix: node.dataset.prefix || "", candidates: Number(node.dataset.candidates),
    total: Number(node.dataset.total), hidden: node.hidden
  };
});

test("left/right sequences filter the panel by prefix and an exact match executes", async () => {
  await openCommandPanel();
  const opened = await panelState();
  assert.equal(opened.total, 21);
  assert.equal(opened.candidates, 21);

  // → narrows the list to the ten right-starting commands without moving the selection.
  await page.keyboard.press("ArrowRight");
  await page.waitForFunction(() =>
    document.querySelector("#douyin-remote-panel").dataset.prefix === "ArrowRight");
  const right = await panelState();
  assert.equal(right.candidates, 10);
  assert.equal(right.selected, "togglePlayback");

  // A second key keeps filtering (↑ does not move the list while a prefix is active).
  await page.keyboard.press("ArrowUp");
  await page.waitForFunction(() =>
    document.querySelector("#douyin-remote-panel").dataset.prefix === "ArrowRight,ArrowUp");
  const up = await panelState();
  assert.equal(up.candidates, 4);
  // The filtered-out selection falls to the first matching row (网页全屏 precedes 全屏 in the panel).
  assert.equal(up.selected, "pageFullscreen");

  // → ↑ ↑ is the exact sequence for like; it runs immediately and closes the panel.
  await page.keyboard.press("ArrowUp");
  await page.waitForFunction(() => window.clicks?.digg === 1);
  assert.equal(await page.evaluate(() =>
    document.querySelector("#douyin-remote-panel").hidden), true);
  assert.equal(page.url(), "https://www.douyin.com/video/555");
});

test("Backspace steps back through the sequence filter and ↑↓ resumes navigation", async () => {
  await openCommandPanel();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowDown");
  await page.waitForFunction(() =>
    document.querySelector("#douyin-remote-panel").dataset.prefix === "ArrowRight,ArrowDown");
  const branch = await panelState();
  assert.equal(branch.candidates, 4);
  assert.equal(branch.selected, "prevVideo");

  await page.keyboard.press("Backspace");
  await page.waitForFunction(() =>
    document.querySelector("#douyin-remote-panel").dataset.prefix === "ArrowRight");
  assert.equal((await panelState()).candidates, 10);
  // With a prefix still active, ↓ extends the sequence again instead of moving the list.
  await page.keyboard.press("ArrowDown");
  await page.waitForFunction(() =>
    document.querySelector("#douyin-remote-panel").dataset.prefix === "ArrowRight,ArrowDown");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");
  await page.waitForFunction(() =>
    document.querySelector("#douyin-remote-panel").dataset.prefix === "");
  assert.equal((await panelState()).candidates, 21);
  // Fully cleared: ↑↓ move the selection again.
  const before = (await panelState()).selected;
  await page.keyboard.press("ArrowDown");
  const after = (await panelState()).selected;
  assert.notEqual(after, before);

  await page.keyboard.press("Escape");
  await page.waitForFunction(() =>
    document.querySelector("#douyin-remote-panel")?.dataset.open === "0");
});

test("a two-key sequence runs directly and an unmatched key resets the filter", async () => {
  await openCommandPanel();
  await page.keyboard.press("ArrowLeft");
  assert.equal((await panelState()).prefix, "ArrowLeft");
  await page.keyboard.press("ArrowDown");
  await page.waitForFunction(() => document.querySelector("video").muted === true);
  assert.equal(await page.evaluate(() =>
    document.querySelector("#douyin-remote-panel").hidden), true);

  await openCommandPanel();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("z");
  await page.waitForFunction(() =>
    document.querySelector("#douyin-remote-panel").dataset.prefix === "");
  const reset = await panelState();
  assert.equal(reset.candidates, 21);
  assert.equal(reset.hidden, false);
  await page.keyboard.press("Escape");
});

test("no page errors from the Douyin controller", () => {
  assert.deepEqual(errors, []);
});
