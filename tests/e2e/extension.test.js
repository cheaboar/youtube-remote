const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright");
let context, extensionId, profile, fixture;
const errors = [];
before(async () => {
  profile = await fs.mkdtemp(path.join(os.tmpdir(), "youtube-remote-e2e-"));
  fixture = await fs.readFile(path.join(__dirname, "fixture.html"), "utf8");
  context = await chromium.launchPersistentContext(profile, {
    channel: "chromium", headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
    args: [`--disable-extensions-except=${path.resolve(__dirname, "../..")}`, `--load-extension=${path.resolve(__dirname, "../..")}`, "--autoplay-policy=no-user-gesture-required"],
    viewport: { width: 1100, height: 720 }
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  extensionId = new URL(worker.url()).host;
  await context.route("https://www.youtube.com/**", route => route.fulfill({ status: 200, contentType: "text/html", body: fixture }));
  context.on("page", page => page.on("pageerror", error => errors.push(error.message)));
});
after(async () => { await context?.close(); /* Keep the isolated profile for failed-test diagnosis; OS temp cleanup owns it. */ });
const region = (page, value) => page.waitForFunction(value => document.querySelector("#youtube-remote-status")?.dataset.region === value, value);
const selected = (page, id) => page.waitForFunction(id => document.querySelector(".youtube-keyboard-selected")?.dataset.video === id, id);
async function pageAt(url) { const page = await context.newPage(); await page.goto(`https://www.youtube.com${url}`); await page.waitForSelector("#youtube-remote-status"); return page; }
const press = (page, key) => page.keyboard.press(key);

test("installed extension restores a selection after playback/back despite stale link focus", async () => {
  const page = await pageAt("/"); await selected(page, "v0");
  await page.locator('[data-video="v4"] a').focus();
  await press(page, "ArrowRight"); await selected(page, "v1");
  await press(page, "Enter"); await region(page, "player");
  assert.match(page.url(), /v=v1/);
  await press(page, "Escape"); await selected(page, "v1");
  await press(page, "ArrowRight"); await selected(page, "v2");
  await page.close();
});

test("home shortcut exits fullscreen, returns home and preserves the previous result selection", async () => {
  const page = await pageAt("/results?search_query=home-test"); await selected(page, "v0");
  await press(page, "ArrowRight"); await selected(page, "v1");
  await press(page, "Enter"); await region(page, "player");
  await press(page, "Alt+Shift+f"); await page.waitForFunction(() => !!document.fullscreenElement);
  await press(page, "Alt+Shift+h");
  await page.waitForURL('https://www.youtube.com/'); await selected(page, "v0");
  assert.equal(await page.evaluate(() => !!document.fullscreenElement), false);
  await press(page, "Escape"); await region(page, "player");
  await page.waitForTimeout(270); await press(page, "Escape"); await selected(page, "v1");
  assert.equal(new URL(page.url()).searchParams.get('search_query'), 'home-test');
  await press(page, "Alt+Shift+s"); await region(page, "search");
  await page.keyboard.insertText('未提交的语音文字');
  await press(page, "Alt+Shift+h");
  await page.waitForURL('https://www.youtube.com/'); await selected(page, "v0");
  await page.close();
});

test("sidebar outside secondary loads late, navigates continuously and backs to player", async () => {
  const page = await pageAt("/watch?v=p0&list=mix&delay=1"); await region(page, "player");
  await page.locator("#play-control").focus();
  await press(page, "Alt+Shift+y"); await selected(page, "p0");
  await press(page, "ArrowDown"); await press(page, "ArrowDown"); await selected(page, "p2");
  await press(page, "ArrowUp"); await selected(page, "p1");
  await press(page, "Escape"); await region(page, "player");
  await press(page, "ArrowDown"); await press(page, "ArrowDown"); await selected(page, "p0");
  await page.close();
});

test("voice-style text can be cancelled or submitted, and search results can be revisited", async () => {
  const page = await pageAt("/"); await selected(page, "v0");
  await press(page, "ArrowRight"); await selected(page, "v1");
  await press(page, "Alt+Shift+s"); await region(page, "search");
  await page.waitForFunction(() => document.activeElement?.name === "search_query");
  await page.keyboard.insertText("音乐演唱会");
  await press(page, "Escape"); await selected(page, "v1");
  assert.equal(await page.locator("input").inputValue(), "");
  await page.waitForTimeout(270);
  await press(page, "Alt+Shift+s"); await region(page, "search");
  await page.keyboard.insertText("自然纪录片");
  await press(page, "Enter"); await region(page, "list"); await selected(page, "v0");
  assert.match(page.url(), /search_query=/);
  await page.waitForTimeout(270);
  await press(page, "ArrowRight"); await press(page, "Enter"); await region(page, "player");
  await press(page, "Escape"); await selected(page, "v1");
  await page.close();
});

test("composition does not prematurely submit and unrelated inputs retain their keys", async () => {
  const page = await pageAt("/"); await selected(page, "v0");
  await press(page, "Alt+Shift+s"); await region(page, "search");
  await page.locator("input").fill("中文候选");
  await page.locator("input").evaluate(input => {
    input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", isComposing: true, bubbles: true }));
    input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
  });
  assert.equal(new URL(page.url()).pathname, "/");
  await page.waitForTimeout(90); await press(page, "Enter"); await region(page, "list");
  await page.evaluate(() => { const comment = document.createElement("textarea"); comment.id = "comment"; document.body.prepend(comment); comment.focus(); });
  await press(page, "ArrowRight"); assert.equal(await page.evaluate(() => document.activeElement.id), "comment");
  await page.close();
});

test("fullscreen, playback and search/side transitions use actual video controls", async () => {
  const page = await pageAt("/watch?v=p0"); await region(page, "player");
  await page.waitForFunction(() => document.querySelector("video")?.readyState >= 2);
  await press(page, "Enter"); await page.waitForFunction(() => !document.querySelector("video").paused);
  await press(page, "Alt+Shift+k"); await page.waitForFunction(() => document.querySelector("video").paused);
  await press(page, "ArrowRight"); assert.ok(await page.locator("video").evaluate(v => v.currentTime >= 5));
  await press(page, "Alt+Shift+f"); await page.waitForFunction(() => !!document.fullscreenElement);
  await press(page, "Alt+Shift+y"); await selected(page, "r0");
  assert.equal(await page.evaluate(() => !!document.fullscreenElement), false);
  await press(page, "Escape"); await region(page, "player");
  await page.waitForTimeout(270); await press(page, "Alt+Shift+f"); await page.waitForFunction(() => !!document.fullscreenElement);
  await press(page, "Alt+Shift+s"); await region(page, "search");
  assert.equal(await page.evaluate(() => !!document.fullscreenElement), false);
  await page.close();
});

test("bottom navigation loads more cards and allows continued selection", async () => {
  const page = await pageAt("/"); await selected(page, "v0");
  for (let i = 0; i < 6; i++) await press(page, "ArrowDown");
  await page.waitForFunction(() => document.querySelectorAll("ytd-rich-item-renderer").length > 6);
  await press(page, "ArrowDown");
  assert.ok(await page.locator(".youtube-keyboard-selected").count());
  await page.close();
});

test("full-page navigation restores tab-scoped selections independently", async () => {
  const first = await pageAt("/"); await selected(first, "v0");
  await press(first, "ArrowRight"); await selected(first, "v1");
  const second = await pageAt("/"); await selected(second, "v0");
  await press(second, "ArrowDown"); await selected(second, "v3");
  await first.goto("https://www.youtube.com/watch?v=v1"); await region(first, "player");
  await press(first, "Escape"); await selected(first, "v1");
  await selected(second, "v3");
  await press(first, "ArrowRight"); await selected(first, "v2");
  await first.close(); await second.close();
});

test("new user intent cancels delayed sidebar selection", async () => {
  const page = await pageAt("/watch?v=p0&delay=1"); await region(page, "player");
  await press(page, "Alt+Shift+y"); await region(page, "sidebar");
  await press(page, "Alt+Shift+s"); await region(page, "search");
  await page.waitForTimeout(750);
  assert.equal(await page.evaluate(() => document.activeElement.name), "search_query");
  assert.equal(await page.locator(".youtube-keyboard-selected").count(), 0);
  await page.close();
});

test("YouTube auto-focus and replacement renderers cannot strand list navigation", async () => {
  const page = await pageAt("/"); await selected(page, "v0");
  await press(page, "ArrowRight"); await selected(page, "v1");
  await page.evaluate(() => { document.querySelector('#grid').innerHTML += ''; });
  await selected(page, "v1");
  await page.locator('input[name="search_query"]').focus();
  await press(page, "ArrowRight"); await selected(page, "v2");
  await page.locator('input[name="search_query"]').click(); await region(page, "search");
  await page.keyboard.insertText("manual search"); await press(page, "Escape"); await selected(page, "v2");
  await page.close();
});

test("back waits for results while YouTube keeps the old watch DOM cached", async () => {
  const page = await pageAt("/results?search_query=music"); await selected(page, "v0");
  await press(page, "ArrowRight"); await selected(page, "v1");
  await page.evaluate(() => {
    window.cachedResults = document.querySelector('#grid').cloneNode(true);
    window.cachedResults.querySelectorAll('.youtube-keyboard-selected').forEach(e => e.classList.remove('youtube-keyboard-selected'));
  });
  await press(page, "Enter"); await region(page, "player");
  await page.waitForSelector('yt-lockup-view-model');
  await page.evaluate(() => {
    const card = document.querySelector('yt-lockup-view-model');
    card.dataset.video = 'v1'; card.querySelector('a').href = '/watch?v=v1';
    window.render = () => setTimeout(() => {
      document.querySelector('ytd-watch-flexy').style.display = 'none';
      document.querySelector('#app').append(window.cachedResults);
      document.dispatchEvent(new Event('yt-navigate-finish'));
    }, 180);
  });
  await press(page, "Escape"); await region(page, "list");
  await page.waitForSelector('#grid');
  await page.waitForFunction(() => {
    const selected = document.querySelector('.youtube-keyboard-selected');
    return selected?.dataset.video === 'v1' && !!selected.closest('#grid') && selected.getBoundingClientRect().height > 0;
  }, null, { timeout: 2500 });
  await press(page, "ArrowRight"); await selected(page, "v2");
  await page.close();
});

test("empty results remain searchable and delayed cards recover after the initial timeout", async () => {
  const page = await pageAt("/results?empty=1"); await region(page, "list");
  await page.waitForFunction(() => document.querySelector('#youtube-remote-status')?.shadowRoot.textContent.includes('节目尚未加载'));
  assert.equal(await page.locator('.youtube-keyboard-selected').count(), 0);
  await page.evaluate(() => document.querySelector('#grid').innerHTML = '<ytd-rich-item-renderer data-video="late"><a href="/watch?v=late">迟到的节目</a></ytd-rich-item-renderer>');
  await selected(page, 'late');
  await press(page, 'Alt+Shift+s'); await region(page, 'search');
  await press(page, 'Enter');
  assert.equal(new URL(page.url()).searchParams.get('empty'), '1');
  await page.keyboard.insertText('重新搜索'); await page.waitForTimeout(270); await press(page, 'Enter');
  await selected(page, 'v0');
  await page.close();
});

test("an in-player error does not block sidebar but a page dialog retains Escape", async () => {
  const page = await pageAt("/watch?v=p0"); await region(page, "player");
  await page.evaluate(() => {
    const error = document.createElement('yt-player-interstitial-renderer'); error.setAttribute('role', 'dialog');
    error.textContent = 'Player sign-in notice'; document.querySelector('#movie_player').append(error);
  });
  await press(page, "Alt+Shift+y"); await selected(page, "r0");
  await page.evaluate(() => {
    const dialog = document.createElement('dialog'); dialog.textContent = 'Page modal'; document.body.append(dialog); dialog.showModal();
  });
  const url = page.url(); await press(page, "Escape");
  assert.equal(page.url(), url);
  await page.waitForFunction(() => !document.querySelector('dialog').open);
  await page.close();
});

test("entering a collapsed playlist expands it before selecting a video", async () => {
  const page = await pageAt("/watch?v=p0&list=mix"); await page.waitForSelector('ytd-playlist-panel-video-renderer');
  await page.evaluate(() => {
    const panel = document.querySelector('ytd-playlist-panel-renderer');
    panel.innerHTML = '<div id="trailing-button"><button>展开</button></div><div id="entries" hidden>' + panel.innerHTML + '</div>';
    panel.setAttribute('collapsed', '');
    panel.querySelector('button').addEventListener('click', () => { panel.removeAttribute('collapsed'); panel.querySelector('#entries').hidden = false; });
  });
  await press(page, 'Alt+Shift+y'); await selected(page, 'p0');
  assert.equal(await page.locator('ytd-playlist-panel-renderer').getAttribute('collapsed'), null);
  await page.close();
});

test("settings recording, conflict detection, live remapping and redacted diagnostics", async () => {
  const page = await pageAt("/"); await selected(page, "v0");
  const options = await context.newPage(); await options.goto(`chrome-extension://${extensionId}/options.html`);
  await options.getByRole("button", { name: "录制搜索", exact: true }).click(); await press(options, "Enter");
  await options.getByRole("button", { name: "保存设置" }).click();
  assert.match(await options.locator("#feedback").textContent(), /同一个按键/);
  await options.getByRole("button", { name: "录制搜索", exact: true }).click(); await press(options, "F8");
  await options.getByRole("button", { name: "保存设置" }).click();
  await options.waitForFunction(() => document.querySelector("#feedback").textContent.includes("设置已保存"));
  await options.getByRole("button", { name: "开始诊断 5 分钟" }).click();
  await page.bringToFront(); await press(page, "F8"); await region(page, "search");
  await page.keyboard.type("privatewords"); await page.keyboard.insertText("隐私语音文字");
  await options.bringToFront(); await options.waitForFunction(() => document.querySelector("#events").textContent.includes("F8"));
  const text = await options.locator("#events").textContent();
  assert.ok(!text.includes("privatewords") && !text.includes("隐私语音文字"));
  assert.ok(text.includes("<文字输入>"));
  await options.getByRole("button", { name: "停止诊断" }).click();
  await options.locator("#enabled").uncheck();
  await options.getByRole("button", { name: "保存设置" }).click();
  await page.bringToFront(); await page.evaluate(() => document.activeElement.blur());
  await press(page, "ArrowDown");
  assert.equal(await page.locator(".youtube-keyboard-selected").count(), 0);
  assert.ok(await page.evaluate(() => window.nativeEvents.includes("ArrowDown")));
  await options.getByRole("button", { name: "恢复默认" }).click();
  await options.screenshot({ path: "test-results/options.png", fullPage: true });
  const popup = await context.newPage(); await popup.setViewportSize({ width: 348, height: 600 });
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.waitForFunction(() => document.querySelector('#shortcuts').textContent.includes('Alt+Shift+S'));
  assert.match(await popup.locator('#shortcuts').textContent(), /Alt\+Shift\+H/);
  assert.equal(await popup.evaluate(() => document.documentElement.scrollWidth), 348);
  assert.ok(await popup.evaluate(() => document.documentElement.scrollHeight <= 600));
  await popup.screenshot({ path: "test-results/popup.png" });
  await page.goto('https://www.youtube.com/results?search_query=popup-home'); await selected(page, 'v0');
  await page.bringToFront();
  await Promise.all([
    page.waitForURL('https://www.youtube.com/'),
    popup.getByRole('button', { name: '首页', exact: true }).evaluate(button => button.click())
  ]);
  await selected(page, 'v0');
  if (!popup.isClosed()) await popup.close();
  await page.close(); await options.close();
});

test("no uncaught page/extension UI errors", () => assert.deepEqual(errors, []));
