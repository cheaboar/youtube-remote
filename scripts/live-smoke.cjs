// Optional network smoke test. Uses a fresh profile with the unpacked extension.
const { chromium } = require("playwright");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
(async () => {
  const root = path.resolve(__dirname, "..");
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), "youtube-remote-live-"));
  const context = await chromium.launchPersistentContext(profile, { channel: "chromium", headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`], viewport: { width: 1280, height: 800 } });
  const report = {};
  const page = await context.newPage();
  const selectedHref = () => page.locator('.youtube-keyboard-selected a[href*="/watch?"]').first().getAttribute('href');
  const movedFrom = href => page.waitForFunction(href => {
    const card = document.querySelector('.youtube-keyboard-selected');
    return card?.getBoundingClientRect().height > 0 && card.querySelector('a[href*="/watch?"]')?.getAttribute('href') !== href;
  }, href, { timeout: 5000 });
  try {
    await page.goto("https://www.youtube.com/results?search_query=nature+documentary", { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".youtube-keyboard-selected", { timeout: 25000 });
    report.initialSelection = await page.locator(".youtube-keyboard-selected").innerText();
    await page.keyboard.press("Alt+Shift+s");
    await page.waitForFunction(() => document.activeElement?.getAttribute("name") === "search_query");
    report.searchFocused = true;
    await page.keyboard.insertText("instrumental piano");
    await page.keyboard.press("Escape");
    report.cancelledSearch = await page.locator('input[name="search_query"]').inputValue() === "";
    await page.waitForTimeout(300);
    await page.keyboard.press("Alt+Shift+s");
    await page.waitForFunction(() => document.activeElement?.getAttribute("name") === "search_query");
    await page.keyboard.insertText("instrumental piano");
    await page.keyboard.press("Enter");
    await page.waitForURL(url => url.searchParams.get("search_query") === "instrumental piano");
    await page.waitForSelector(".youtube-keyboard-selected");
    report.submittedSearch = true;
    const resultHref = await selectedHref();
    await page.waitForTimeout(300);
    await page.keyboard.press("Enter");
    await page.waitForURL(url => url.pathname === "/watch");
    await page.waitForSelector("#movie_player");
    report.playPage = true;
    report.visibleDialogs = await page.locator('[role="dialog"]').evaluateAll(nodes => nodes.filter(e => e.getBoundingClientRect().width && e.getBoundingClientRect().height && getComputedStyle(e).visibility !== "hidden").map(e => e.getAttribute("aria-label") || e.tagName));
    await page.keyboard.press("Alt+Shift+y");
    await page.waitForSelector(".youtube-keyboard-selected", { timeout: 10000 });
    report.sidebar = await page.locator(".youtube-keyboard-selected").innerText();
    const sideHref = await selectedHref();
    await page.keyboard.press('ArrowDown'); await movedFrom(sideHref);
    report.sidebarMovement = true;
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    await page.keyboard.press("Escape");
    await page.waitForURL(url => url.pathname === "/results");
    await page.waitForSelector(".youtube-keyboard-selected");
    report.returnSelection = true;
    if (new URL(await selectedHref(), page.url()).searchParams.get('v') !== new URL(resultHref, page.url()).searchParams.get('v'))
      throw new Error('Back did not restore the original video');
    const restoredHref = await selectedHref();
    await page.keyboard.press('ArrowDown'); await movedFrom(restoredHref);
    report.returnMovement = true;
    await fs.mkdir(path.join(root, "test-results"), { recursive: true });
    await page.screenshot({ path: path.join(root, "test-results/live-search.png") });
  } catch (error) {
    report.error = error.message;
    report.failureState = await page.evaluate(() => ({ url: location.href, active: document.activeElement?.outerHTML.slice(0, 350),
      state: document.querySelector("#youtube-remote-status")?.shadowRoot?.textContent.slice(-250),
      cards: document.querySelectorAll("ytd-video-renderer,yt-lockup-view-model").length,
      selected: document.querySelectorAll(".youtube-keyboard-selected").length,
      sideRoots: [...document.querySelectorAll('ytd-watch-flexy,#secondary,#related,ytd-playlist-panel-renderer')].map(e => ({ tag: e.tagName, id: e.id,
        width: e.getBoundingClientRect().width, height: e.getBoundingClientRect().height, visible: e.checkVisibility?.({checkOpacity:true,checkVisibilityCSS:true}),
        cards: e.querySelectorAll('yt-lockup-view-model,ytd-compact-video-renderer,ytd-playlist-panel-video-renderer').length })) }));
    process.exitCode = 1;
  }
  finally { console.log(JSON.stringify(report, null, 2)); await context.close(); }
})();
