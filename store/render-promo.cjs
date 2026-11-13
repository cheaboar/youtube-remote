const { chromium } = require("playwright");
const path = require("node:path");

(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
    headless: true
  });
  const page = await browser.newPage({ viewport: { width: 1400, height: 560 }, deviceScaleFactor: 1 });
  const url = "file:///" + path.resolve(__dirname, "promo.html").split(path.sep).join("/");
  await page.goto(url);
  await page.waitForTimeout(400);
  await page.locator("#tile").screenshot({ path: path.join(__dirname, "promo-440x280.png") });
  await page.locator("#marquee").screenshot({ path: path.join(__dirname, "promo-1400x560.png") });
  await browser.close();
  console.log("done");
})();
