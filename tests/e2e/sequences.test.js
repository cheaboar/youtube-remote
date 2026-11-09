const { test, before, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright");
const R = require("../../remote.js");
let context, worker, extensionId;
const errors = [];
before(async () => {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), "youtube-sequences-e2e-"));
  const fixture = await fs.readFile(path.join(__dirname, "fixture.html"), "utf8");
  context = await chromium.launchPersistentContext(profile, {
    channel: "chromium", headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
    args: [`--disable-extensions-except=${path.resolve(__dirname, "../..")}`, `--load-extension=${path.resolve(__dirname, "../..")}`, "--autoplay-policy=no-user-gesture-required"],
    viewport: { width: 1100, height: 720 }
  });
  context.setDefaultTimeout(6000);
  worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  extensionId = new URL(worker.url()).host;
  await context.route("https://www.youtube.com/**", route => route.fulfill({ status: 200, contentType: "text/html", body: fixture }));
  context.on("page", page => page.on("pageerror", error => errors.push(error.message)));
  await fs.mkdir("test-results", { recursive: true });
});
beforeEach(async () => {
  await worker.evaluate(settings => chrome.storage.local.set({ remoteSettings: settings }), R.cloneDefaults());
});
after(async () => { await context?.close(); });
const press = (page, key) => page.keyboard.press(key);
const selected = (page, id) => page.waitForFunction(id => document.querySelector('.youtube-keyboard-selected')?.dataset.video === id, id);
const region = (page, value) => page.waitForFunction(value => document.querySelector('#youtube-remote-status')?.dataset.region === value, value);
const mode = page => page.locator('#youtube-remote-sequences').waitFor({ state: 'visible' });
const noMode = page => page.locator('#youtube-remote-sequences').waitFor({ state: 'hidden' });
async function pageAt(url, confirm = 'Enter') {
  const page = await context.newPage(); await page.goto(`https://www.youtube.com${url}`);
  await page.waitForFunction(confirm => document.querySelector('#youtube-remote-status')?.dataset.confirm === confirm, confirm);
  return page;
}
async function enter(page, key = 'Enter') { await press(page, key); await press(page, key); await mode(page); }
const prefix = (page, count) => page.waitForFunction(count => document.querySelector('#youtube-remote-sequences')?.dataset.candidates === String(count), count);
const menuSelected = (page, action) => page.waitForFunction(action => document.querySelector('#youtube-remote-sequences')?.dataset.selected === action, action);
async function choose(page, action) {
  const actions = await page.locator('#youtube-remote-sequences .row').evaluateAll(rows => rows.map(row => row.dataset.action));
  const current = await page.locator('#youtube-remote-sequences').getAttribute('data-selected');
  const distance = actions.indexOf(action) - actions.indexOf(current);
  assert.ok(actions.includes(action));
  for (let i = 0; i < Math.abs(distance); i++) await press(page, distance > 0 ? 'ArrowDown' : 'ArrowUp');
  await menuSelected(page, action);
}

test("Return events from remotes enter the same sequence mode as Enter", async () => {
  const page = await pageAt('/'); await selected(page, 'v0');
  await page.evaluate(() => {
    for (let i = 0; i < 2; i++) {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Return', code: 'Return', bubbles: true, cancelable: true }));
      document.body.dispatchEvent(new KeyboardEvent('keyup', { key: 'Return', code: 'Return', bubbles: true, cancelable: true }));
    }
  });
  await mode(page);
  assert.equal(new URL(page.url()).pathname, '/');
  await page.close();
});

test("automatic search focus between two confirm presses does not reset the double tap", async () => {
  const page = await pageAt('/'); await selected(page, 'v0');
  await press(page, 'Enter');
  await page.locator('input[name="search_query"]').focus();
  await press(page, 'Enter');
  await mode(page);
  assert.equal(new URL(page.url()).pathname, '/');
  await page.close();
});

test("replacing a selected renderer between confirm presses does not reset the double tap", async () => {
  const page = await pageAt('/'); await selected(page, 'v0');
  await press(page, 'Enter');
  await page.evaluate(() => { document.querySelector('#grid').innerHTML += ''; });
  await page.waitForTimeout(90);
  await press(page, 'Enter');
  await mode(page);
  assert.equal(new URL(page.url()).pathname, '/');
  await page.close();
});

test("a pending single confirm cannot open a different video after the selected card changes", async () => {
  const page = await pageAt('/'); await selected(page, 'v0');
  await press(page, 'Enter');
  await page.evaluate(() => {
    const card = document.querySelector('.youtube-keyboard-selected');
    card.querySelector('a').href = '/watch?v=replaced';
    card.dataset.video = 'replaced';
  });
  await page.waitForTimeout(450);
  assert.equal(new URL(page.url()).pathname, '/');
  await page.close();
});

test("double confirm filters candidates without opening a video, and supports undo, errors and cancel", async () => {
  const page = await pageAt('/'); await selected(page, 'v0');
  await press(page, 'ArrowRight'); await selected(page, 'v1');
  await enter(page); await prefix(page, 12);
  assert.equal(new URL(page.url()).pathname, '/');
  await press(page, 'ArrowLeft'); await prefix(page, 8); await selected(page, 'v1');
  assert.equal(await page.locator('#youtube-remote-sequences .row').count(), 8);
  await page.screenshot({ path: 'test-results/sequences-filtered.png' });
  await press(page, 'Backspace'); await prefix(page, 12);
  await press(page, 'z'); await prefix(page, 12);
  assert.match(await page.locator('#youtube-remote-sequences [role="status"]').textContent(), /没有匹配，已重置/);
  await page.screenshot({ path: 'test-results/sequences-all.png' });
  await press(page, 'Escape'); await noMode(page); await selected(page, 'v1');
  await press(page, 'ArrowRight'); await selected(page, 'v2');
  assert.equal(await page.evaluate(() => window.nativeEvents.includes('Enter')), false);
  await page.close();
});

test("single confirm waits, other input cancels it, and holding confirm cannot enter the mode", async () => {
  const list = await pageAt('/'); await selected(list, 'v0');
  await press(list, 'Enter'); await press(list, 'ArrowRight');
  await selected(list, 'v1'); await list.waitForTimeout(450);
  assert.equal(new URL(list.url()).pathname, '/');
  await list.close();
  const page = await pageAt('/watch?v=p0'); await region(page, 'player');
  await page.waitForFunction(() => document.querySelector('video').readyState >= 2);
  const initiallyPaused = await page.evaluate(() => {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
    return document.querySelector('video').paused;
  });
  assert.equal(initiallyPaused, true);
  await page.waitForFunction(() => !document.querySelector('video').paused);
  await press(page, 'Alt+Shift+k'); await page.waitForFunction(() => document.querySelector('video').paused);
  await enter(page);
  assert.equal(await page.locator('video').evaluate(v => v.paused), true);
  await press(page, 'Escape'); await noMode(page);
  await page.keyboard.down('Enter'); await page.keyboard.down('Enter');
  await page.waitForFunction(() => !document.querySelector('video').paused);
  await page.keyboard.up('Enter'); await noMode(page);
  assert.equal(await page.evaluate(() => window.nativeEvents.includes('Enter')), false);
  await page.close();
});

test("mode directions do not seek, adjust volume or repeat; media, fullscreen and sidebar commands work", async () => {
  const page = await pageAt('/watch?v=p0'); await region(page, 'player');
  await page.waitForFunction(() => document.querySelector('video').readyState >= 2);
  await enter(page);
  await page.keyboard.down('ArrowRight'); await page.keyboard.down('ArrowRight');
  await prefix(page, 4); await page.keyboard.up('ArrowRight');
  assert.equal(await page.locator('video').evaluate(v => v.currentTime), 0);
  assert.equal(await page.locator('video').evaluate(v => v.volume), 1);
  await press(page, 'ArrowRight'); await noMode(page);
  await page.waitForFunction(() => !document.querySelector('video').paused);
  await enter(page); await press(page, 'ArrowRight'); await press(page, 'ArrowUp');
  await page.waitForFunction(() => !!document.fullscreenElement);
  await enter(page);
  assert.equal(await page.locator('#youtube-remote-sequences').evaluate(e => e.parentElement === document.fullscreenElement), true);
  await page.screenshot({ path: 'test-results/sequences-fullscreen.png' });
  await press(page, 'Escape'); await noMode(page);
  assert.equal(await page.evaluate(() => !!document.fullscreenElement), true);
  await enter(page); await press(page, 'ArrowRight'); await press(page, 'ArrowDown');
  await selected(page, 'r0');
  assert.equal(await page.evaluate(() => !!document.fullscreenElement), false);
  await enter(page); await press(page, 'ArrowUp'); await press(page, 'Escape');
  await noMode(page); await selected(page, 'r0');
  await press(page, 'ArrowDown'); await selected(page, 'r1');
  await page.close();
});

test("search text and selection survive cancel, and search, home and history sequences execute", async () => {
  const page = await pageAt('/results?search_query=initial'); await selected(page, 'v0');
  await enter(page); await press(page, 'ArrowLeft'); await press(page, 'ArrowLeft'); await region(page, 'search');
  await page.waitForFunction(() => document.activeElement?.name === 'search_query');
  await page.keyboard.insertText('蓝牙语音文字');
  await page.locator('input').evaluate(input => input.setSelectionRange(1, 3));
  await enter(page); await press(page, 'ArrowLeft'); await prefix(page, 8);
  await press(page, 'Escape'); await noMode(page);
  assert.equal(await page.locator('input').inputValue(), '蓝牙语音文字');
  assert.deepEqual(await page.locator('input').evaluate(input => [input === document.activeElement, input.selectionStart, input.selectionEnd]), [true, 1, 3]);
  await press(page, 'Enter');
  await page.waitForURL(url => url.searchParams.get('search_query') === '蓝牙语音文字');
  await selected(page, 'v0');
  await enter(page); await press(page, 'ArrowLeft'); await press(page, 'ArrowUp');
  await page.waitForURL('https://www.youtube.com/'); await selected(page, 'v0');
  await enter(page); await press(page, 'ArrowRight'); await press(page, 'ArrowLeft');
  await page.waitForURL(url => url.searchParams.get('search_query') === '蓝牙语音文字');
  await selected(page, 'v0');
  await page.close();
});

test("reload performs a real navigation and restores selection; close only removes its own tab", async () => {
  const other = await pageAt('/results?search_query=keep'); await selected(other, 'v0');
  const page = await pageAt('/results?search_query=reload'); await selected(page, 'v0');
  await press(page, 'ArrowDown'); await press(page, 'ArrowRight'); await selected(page, 'v4');
  await page.evaluate(() => { window.beforeReload = true; });
  await enter(page); await press(page, 'ArrowLeft');
  await press(page, 'ArrowRight');
  await Promise.all([page.waitForEvent('load'), press(page, 'ArrowLeft')]);
  assert.equal(await page.evaluate(() => window.beforeReload), undefined);
  assert.equal(new URL(page.url()).searchParams.get('search_query'), 'reload');
  await selected(page, 'v4');
  await enter(page); await press(page, 'ArrowLeft'); await press(page, 'ArrowRight');
  await Promise.all([page.waitForEvent('close'), press(page, 'ArrowRight')]);
  assert.equal(other.isClosed(), false);
  assert.equal(new URL(other.url()).searchParams.get('search_query'), 'keep');
  await other.close();
});

test("recorded sequences and remapped confirm/back work live, including when the status is hidden", async () => {
  const options = await context.newPage(); await options.goto(`chrome-extension://${extensionId}/options.html`);
  await options.getByRole('button', { name: '录制确认', exact: true }).click(); await press(options, 'F8');
  await options.getByRole('button', { name: '录制逐层返回', exact: true }).click(); await press(options, 'F9');
  await options.getByRole('button', { name: '录制复合键刷新当前页面', exact: true }).click();
  await press(options, 'ArrowLeft'); await press(options, 'ArrowUp');
  await options.getByRole('button', { name: '完成序列', exact: true }).click();
  await options.getByRole('button', { name: '保存设置', exact: true }).click();
  assert.match(await options.locator('#feedback').textContent(), /重复或前缀/);
  await options.getByRole('button', { name: '录制复合键刷新当前页面', exact: true }).click();
  await press(options, 'F6');
  assert.match(await options.locator('#feedback').textContent(), /开头/);
  await press(options, 'ArrowLeft'); await press(options, 'F6'); await press(options, 'F7'); await press(options, 'Backspace');
  await press(options, 'F8');
  assert.match(await options.locator('#feedback').textContent(), /确认键/);
  await press(options, 'F7');
  await options.getByRole('button', { name: '完成序列', exact: true }).click();
  await options.locator('#show-status').uncheck();
  await options.getByRole('button', { name: '保存设置', exact: true }).click();
  await options.waitForFunction(() => document.querySelector('#feedback').textContent.includes('设置已保存'));
  assert.match(await options.locator('#sequence-entry').textContent(), /双击 F8/);
  await options.screenshot({ path: 'test-results/sequence-settings.png', fullPage: true });
  const page = await pageAt('/', 'F8'); await selected(page, 'v0');
  assert.equal(await page.locator('#youtube-remote-status').isVisible(), false);
  await enter(page, 'F8'); await press(page, 'ArrowLeft'); await prefix(page, 8);
  await press(page, 'F9'); await noMode(page); await selected(page, 'v0');
  await enter(page, 'F8'); await press(page, 'ArrowLeft'); await press(page, 'F6'); await prefix(page, 1);
  await page.evaluate(() => { window.beforeReload = true; });
  await Promise.all([page.waitForEvent('load'), press(page, 'F7')]);
  assert.equal(await page.evaluate(() => window.beforeReload), undefined);
  await selected(page, 'v0');
  await enter(page, 'F8');
  const saved = await worker.evaluate(async () => (await chrome.storage.local.get('remoteSettings')).remoteSettings);
  saved.enabled = false;
  await worker.evaluate(settings => chrome.storage.local.set({ remoteSettings: settings }), saved);
  await noMode(page);
  await page.close(); await options.close();
});

test("composition, unrelated editors, focus loss and route changes cancel or bypass mode entry", async () => {
  const page = await pageAt('/'); await selected(page, 'v0');
  await press(page, 'Enter');
  await page.evaluate(() => document.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })));
  await page.waitForTimeout(450);
  assert.equal(new URL(page.url()).pathname, '/');
  await page.evaluate(() => document.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })));
  await page.evaluate(() => { const input = document.createElement('textarea'); document.body.prepend(input); input.focus(); });
  await press(page, 'Enter'); await press(page, 'Enter'); await noMode(page);
  assert.equal(await page.locator('textarea').inputValue(), '\n\n');
  await page.evaluate(() => document.activeElement.blur());
  await enter(page);
  await page.evaluate(() => window.dispatchEvent(new Event('blur'))); await noMode(page);
  await enter(page);
  await page.evaluate(() => window.navigate('/results?search_query=changed'));
  await noMode(page); await selected(page, 'v0');
  await page.evaluate(() => { const dialog = document.createElement('dialog'); dialog.textContent = 'Page dialog'; document.body.append(dialog); dialog.showModal(); });
  await press(page, 'Enter'); await press(page, 'Enter'); await noMode(page);
  await press(page, 'Escape'); await page.waitForFunction(() => !document.querySelector('dialog').open);
  await enter(page);
  await page.evaluate(() => document.querySelector('dialog').showModal());
  await press(page, 'Escape'); await noMode(page);
  await page.waitForFunction(() => !document.querySelector('dialog').open);
  await page.close();
});

test("menu arrows select grouped commands with a persistent blue glass highlight and Enter executes immediately", async () => {
  const page = await pageAt('/watch?v=p0'); await region(page, 'player');
  await page.waitForFunction(() => document.querySelector('video').readyState >= 2);
  await enter(page); await menuSelected(page, 'togglePlayback');
  assert.deepEqual(await page.locator('#youtube-remote-sequences .group-title').allTextContents(), ['常用', '播放器', '页面']);
  assert.equal(await page.locator('#youtube-remote-sequences .row').first().getAttribute('data-action'), 'togglePlayback');
  await press(page, 'ArrowUp'); await menuSelected(page, 'togglePlayback');
  const glass = await page.locator('#youtube-remote-sequences .selection-glass').elementHandle();
  await page.keyboard.down('ArrowDown'); await page.keyboard.down('ArrowDown'); await page.keyboard.up('ArrowDown');
  await menuSelected(page, 'search'); await prefix(page, 12);
  assert.equal(await glass.evaluate(element => element === element.getRootNode().querySelector('.selection-glass')), true);
  assert.equal(await page.locator('#youtube-remote-sequences [aria-selected="true"]').getAttribute('data-action'), 'search');
  await page.waitForTimeout(400);
  assert.equal(await page.locator('#youtube-remote-sequences .row.selected').evaluate(element => getComputedStyle(element).color), 'rgb(0, 89, 189)');
  assert.equal(await page.locator('#youtube-remote-sequences .selection-glass').evaluate(element => getComputedStyle(element).transitionDuration.includes('0.36s')), true);
  assert.equal(await page.locator('video').evaluate(video => video.volume), 1);
  await page.screenshot({ path: 'test-results/sequences-menu.png' });
  await press(page, 'Enter'); await noMode(page); await region(page, 'search');
  await page.waitForFunction(() => document.activeElement?.name === 'search_query');
  await page.close();
});

test("small and reduced-motion menus keep the selected command visible while navigating all groups", async () => {
  const page = await pageAt('/'); await selected(page, 'v0');
  await page.setViewportSize({ width: 380, height: 420 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await enter(page); await choose(page, 'closeTab');
  await press(page, 'ArrowDown'); await menuSelected(page, 'closeTab');
  assert.equal(await page.locator('#youtube-remote-sequences .selection-glass').evaluate(element => getComputedStyle(element).transitionDuration), '0s');
  assert.equal(await page.locator('#youtube-remote-sequences .row.selected').evaluate(row => {
    const list = row.closest('.rows'), box = row.getBoundingClientRect(), viewport = list.getBoundingClientRect();
    return box.top >= viewport.top && box.bottom <= viewport.bottom + 1 && list.scrollTop > 0;
  }), true);
  assert.equal(await page.locator('#youtube-remote-sequences .panel').evaluate(panel => {
    const box = panel.getBoundingClientRect(); return box.top >= 0 && box.bottom <= innerHeight && box.left >= 0 && box.right <= innerWidth;
  }), true);
  assert.equal(await page.locator('#youtube-remote-sequences .selection-glass').evaluate(glass => {
    const row = glass.parentElement.querySelector('.row.selected');
    return Math.abs(glass.getBoundingClientRect().top - row.getBoundingClientRect().top) < 1;
  }), true);
  await page.screenshot({ path: 'test-results/sequences-small.png' });
  await press(page, 'Escape'); await noMode(page); await selected(page, 'v0');
  await page.close();
});

test("Return and a remapped confirm both execute menu selections, including after filtering and undo", async () => {
  const settings = R.cloneDefaults(); settings.bindings.confirm = 'F8';
  await worker.evaluate(settings => chrome.storage.local.set({ remoteSettings: settings }), settings);
  const page = await pageAt('/watch?v=p0', 'F8'); await region(page, 'player');
  await enter(page, 'F8'); await press(page, 'ArrowLeft'); await press(page, 'ArrowDown'); await prefix(page, 4);
  await menuSelected(page, 'mute');
  await page.evaluate(() => {
    for (const type of ['keydown', 'keyup']) document.body.dispatchEvent(new KeyboardEvent(type, { key: 'Return', code: 'Return', bubbles: true, cancelable: true }));
  });
  await noMode(page); assert.equal(await page.locator('video').evaluate(video => video.muted), true);
  await enter(page, 'F8'); await choose(page, 'mute'); await press(page, 'F8'); await noMode(page);
  assert.equal(await page.locator('video').evaluate(video => video.muted), false);
  await enter(page, 'F8'); await press(page, 'ArrowLeft'); await press(page, 'Backspace');
  await press(page, 'ArrowDown'); await menuSelected(page, 'sidebar'); await prefix(page, 12);
  await press(page, 'Escape'); await noMode(page);
  await page.close();
});

test("player commands toggle mute, captions and theater, and open keyboard-operable native settings", async () => {
  const page = await pageAt('/watch?v=p0'); await region(page, 'player');
  await enter(page); await press(page, 'ArrowLeft'); await press(page, 'ArrowDown'); await press(page, 'ArrowLeft');
  await noMode(page); assert.equal(await page.locator('video').evaluate(video => video.muted), true);
  await enter(page); await choose(page, 'captions'); await press(page, 'Enter'); await noMode(page);
  assert.equal(await page.locator('.ytp-subtitles-button').getAttribute('aria-pressed'), 'true');
  await page.locator('.ytp-subtitles-button').evaluate(button => { button.parentElement.style.opacity = '0'; });
  await enter(page); await press(page, 'ArrowLeft'); await press(page, 'ArrowDown'); await press(page, 'ArrowRight');
  await noMode(page); assert.equal(await page.locator('.ytp-subtitles-button').getAttribute('aria-pressed'), 'false');
  await page.locator('.ytp-subtitles-button').evaluate(button => { button.parentElement.style.opacity = '1'; });
  await enter(page); await press(page, 'ArrowRight'); await press(page, 'ArrowUp');
  await page.waitForFunction(() => !!document.fullscreenElement);
  await enter(page); await choose(page, 'theater'); await press(page, 'Enter'); await noMode(page);
  await page.waitForFunction(() => !document.fullscreenElement && document.querySelector('ytd-watch-flexy').hasAttribute('theater'));
  await enter(page); await choose(page, 'theater'); await press(page, 'Enter');
  await page.waitForFunction(() => !document.querySelector('ytd-watch-flexy').hasAttribute('theater'));
  await enter(page); await press(page, 'ArrowLeft'); await press(page, 'ArrowDown'); await press(page, 'ArrowDown');
  await noMode(page); await page.waitForFunction(() => document.activeElement?.textContent === '播放速度');
  await press(page, 'ArrowDown'); await page.waitForFunction(() => document.activeElement?.textContent === '画质');
  await press(page, 'Enter'); await page.waitForFunction(() => window.settingActivated === '画质');
  await enter(page); await choose(page, 'playerSettings'); await press(page, 'Enter');
  await page.locator('.ytp-settings-menu').waitFor({ state: 'visible' });
  await press(page, 'Escape'); await page.locator('.ytp-settings-menu').waitFor({ state: 'hidden' });
  assert.equal(new URL(page.url()).pathname, '/watch');
  await page.close();
});

test("unavailable player features show feedback and leave list and player navigation usable", async () => {
  const page = await pageAt('/'); await selected(page, 'v0');
  await enter(page); await choose(page, 'mute'); await press(page, 'Enter'); await noMode(page);
  assert.match(await page.locator('#youtube-remote-status [role="status"]').textContent(), /请先打开视频播放页/);
  await press(page, 'ArrowRight'); await selected(page, 'v1');
  await page.goto('https://www.youtube.com/watch?v=p0&no-captions=1'); await region(page, 'player');
  await enter(page); await choose(page, 'captions'); await press(page, 'Enter'); await noMode(page);
  assert.match(await page.locator('#youtube-remote-status [role="status"]').textContent(), /没有可用字幕/);
  await enter(page); await choose(page, 'mute'); await press(page, 'Enter');
  await page.waitForFunction(() => document.querySelector('video').muted);
  await page.close();
});

test("commands with cleared or conflicting shortcut sequences remain executable from the menu", async () => {
  const settings = R.cloneDefaults(); settings.sequences.mute = [];
  await worker.evaluate(settings => chrome.storage.local.set({ remoteSettings: settings }), settings);
  const page = await pageAt('/watch?v=p0'); await region(page, 'player');
  await enter(page); await prefix(page, 12); await choose(page, 'mute');
  assert.match(await page.locator('#youtube-remote-sequences .row.selected').textContent(), /菜单选择/);
  await press(page, 'Enter'); await noMode(page);
  assert.equal(await page.locator('video').evaluate(video => video.muted), true);
  await page.close();
});

test("native player settings accept remapped remote navigation, confirm and back without triggering player doubles", async () => {
  const settings = R.cloneDefaults();
  settings.bindings.confirm = 'F8'; settings.bindings.back = 'F9'; settings.bindings.down = 'F7';
  await worker.evaluate(settings => chrome.storage.local.set({ remoteSettings: settings }), settings);
  const page = await pageAt('/watch?v=p0', 'F8'); await region(page, 'player');
  await enter(page, 'F8'); await choose(page, 'playerSettings'); await press(page, 'F8'); await noMode(page);
  await page.waitForFunction(() => document.activeElement?.textContent === '播放速度');
  await press(page, 'F7'); await page.waitForFunction(() => document.activeElement?.textContent === '画质');
  await press(page, 'F8'); await page.waitForFunction(() => window.settingActivated === '画质');
  await enter(page, 'F8'); await choose(page, 'playerSettings'); await press(page, 'Enter');
  await page.locator('.ytp-settings-menu').waitFor({ state: 'visible' });
  await press(page, 'F9'); await page.locator('.ytp-settings-menu').waitFor({ state: 'hidden' });
  assert.equal(new URL(page.url()).pathname, '/watch');
  await page.close();
});

test("sequence UI and extension pages have no uncaught errors", () => assert.deepEqual(errors, []));
