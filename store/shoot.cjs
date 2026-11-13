const { chromium } = require("playwright");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const out = path.join(__dirname, "screenshots");
const fixture = name => fs.readFile(path.join(__dirname, "fixtures", name), "utf8");

(async () => {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), "youtube-store-shots-"));
  const context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
    headless: true,
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`],
    viewport: { width: 1280, height: 800 }
  });
  const youtubeHtml = await fixture("youtube-home.html");
  const biliHtml = await fixture("bilibili-video.html");
  await context.route("https://www.youtube.com/**", route =>
    route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: youtubeHtml }));
  await context.route("https://www.bilibili.com/**", route =>
    route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: biliHtml }));

  const page = await context.newPage();

  try {
    await page.goto("https://www.youtube.com/", { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#youtube-remote-status", { timeout: 20000 });
    await page.waitForTimeout(1200);
    await page.keyboard.press("ArrowDown");
    await page.waitForSelector(".youtube-keyboard-selected", { timeout: 10000 });
    await page.waitForTimeout(700);
    await page.screenshot({ path: path.join(out, "01-youtube-home.png") });
    console.log("01 ok");
  } catch (error) { console.log("01 failed:", error.message); }

  try {
    await page.goto("https://www.bilibili.com/video/BV1demo", { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#bilibili-remote-status", { timeout: 15000 });
    await page.waitForTimeout(1200);
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await page.waitForSelector("#bilibili-remote-panel[data-open='1']", { timeout: 5000 });
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(out, "02-bilibili-panel.png") });
    console.log("02 ok");
  } catch (error) { console.log("02 failed:", error.message); }

  try {
    const workers = context.serviceWorkers();
    const worker = workers[0] || await context.waitForEvent("serviceworker", { timeout: 10000 });
    const id = new URL(worker.url()).host;
    const options = await context.newPage();
    await options.goto(`chrome-extension://${id}/options.html`, { waitUntil: "load" });
    await options.waitForTimeout(1500);
    await options.screenshot({ path: path.join(out, "03-options.png") });
    await options.evaluate(() => {
      const headings = [...document.querySelectorAll("h2,h3,section,div")];
      const target = headings.find(node => /B站|哔哩哔哩|优酷/.test(node.textContent || "") && node.id);
      if (target) target.scrollIntoView({ block: "start" });
      else window.scrollTo(0, document.body.scrollHeight * 0.55);
    });
    await options.waitForTimeout(600);
    await options.screenshot({ path: path.join(out, "04-options-sequences.png") });
    console.log("03/04 ok");
  } catch (error) { console.log("03 failed:", error.message); }

  await context.close();
})();
