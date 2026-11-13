const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright");
let context, extensionId;
const errors = [];
before(async () => {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), "youtube-system-map-e2e-"));
  context = await chromium.launchPersistentContext(profile, {
    channel: "chromium", headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
    args: [`--disable-extensions-except=${path.resolve(__dirname, "../..")}`, `--load-extension=${path.resolve(__dirname, "../..")}`],
    viewport: { width: 1100, height: 900 }
  });
  context.setDefaultTimeout(6000);
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  extensionId = new URL(worker.url()).host;
  context.on("page", page => page.on("pageerror", error => errors.push(error.message)));
});
after(async () => { await context?.close(); });

async function optionsPage() {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  await page.evaluate(() => chrome.storage.local.remove("remoteSystemMap"));
  await page.reload();
  await page.waitForFunction(() => document.querySelector("#system-feedback").textContent.includes("已加载系统快捷键映射"));
  return page;
}

test("Windows software mappings can be recorded, saved and exported", async () => {
  const page = await optionsPage();
  assert.match(await page.locator("#system-profiles").textContent(), /还没有软件配置/);

  await page.getByRole("button", { name: "添加软件配置" }).click();
  await page.getByLabel("名称", { exact: true }).fill("PotPlayer");
  await page.getByLabel("进程名", { exact: true }).fill("PotPlayerMini64.exe");
  await page.getByLabel("窗口标题包含（可选）", { exact: true }).fill("影片");

  await page.getByRole("button", { name: "录制第 1 行的遥控按键" }).click();
  await page.keyboard.press("ArrowLeft");
  await page.waitForFunction(() =>
    document.querySelector('[aria-label="录制第 1 行的遥控按键"]').textContent === "←");

  await page.getByRole("button", { name: "录制第 1 行的目标快捷键" }).click();
  await page.keyboard.press("Control+Shift+KeyK");
  await page.waitForFunction(() =>
    document.querySelector('[aria-label="第 1 行的目标快捷键"]').value === "Ctrl+Shift+KeyK");

  await page.getByRole("button", { name: "保存映射" }).click();
  await page.waitForFunction(() =>
    document.querySelector("#system-feedback").textContent.includes("映射已保存"));
  const saved = await page.evaluate(() => chrome.storage.local.get("remoteSystemMap"));
  assert.equal(saved.remoteSystemMap.profiles.length, 1);
  assert.equal(saved.remoteSystemMap.profiles[0].name, "PotPlayer");
  assert.equal(saved.remoteSystemMap.profiles[0].process, "PotPlayerMini64.exe");
  assert.equal(saved.remoteSystemMap.profiles[0].title, "影片");
  assert.deepEqual(saved.remoteSystemMap.profiles[0].bindings.map(({ source, target }) => ({ source, target })),
    [{ source: "ArrowLeft", target: "Ctrl+Shift+KeyK" }]);

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "下载 remote-keys.json" }).click()
  ]);
  assert.equal(download.suggestedFilename(), "remote-keys.json");
  const config = JSON.parse(await fs.readFile(await download.path(), "utf8"));
  assert.equal(config.version, 1);
  assert.equal(config.profiles.length, 1);
  assert.deepEqual(config.profiles[0].bindings, [{ source: "ArrowLeft", target: "Ctrl+Shift+KeyK" }]);

  await page.reload();
  await page.waitForFunction(() => document.querySelector("#system-feedback").textContent.includes("已加载系统快捷键映射"));
  assert.equal(await page.getByLabel("进程名", { exact: true }).inputValue(), "PotPlayerMini64.exe");
  assert.equal(await page.locator('[aria-label="录制第 1 行的遥控按键"]').textContent(), "←");
  assert.equal(await page.locator('[aria-label="第 1 行的目标快捷键"]').inputValue(), "Ctrl+Shift+KeyK");

  // Invalid targets are rejected before storage or the exported file can change.
  await page.locator('[aria-label="第 1 行的目标快捷键"]').fill("Nope");
  await page.getByRole("button", { name: "保存映射" }).click();
  await page.waitForFunction(() =>
    document.querySelector("#system-feedback").textContent.includes("目标快捷键"));
  const unchanged = await page.evaluate(() => chrome.storage.local.get("remoteSystemMap"));
  assert.equal(unchanged.remoteSystemMap.profiles[0].bindings[0].target, "Ctrl+Shift+KeyK");
  await page.close();
});

test("a global profile is allowed once and duplicate sources are rejected", async () => {
  const page = await optionsPage();
  await page.getByRole("button", { name: "添加软件配置" }).click();
  await page.getByRole("button", { name: "添加软件配置" }).click();
  await page.getByRole("button", { name: "保存映射" }).click();
  await page.waitForFunction(() =>
    document.querySelector("#system-feedback").textContent.includes("只能有一个全局配置"));
  await page.getByLabel("进程名", { exact: true }).first().fill("vlc.exe");
  await page.getByLabel("进程名", { exact: true }).nth(1).fill("vlc.exe");
  // Same source on two rows of one profile is rejected; the first row was already recorded.
  const first = page.locator(".system-profile").first();
  await first.getByRole("button", { name: "添加按键映射" }).click();
  await first.getByRole("button", { name: "录制第 1 行的遥控按键" }).click();
  await page.keyboard.press("ArrowUp");
  await first.getByRole("button", { name: "录制第 2 行的遥控按键" }).click();
  await page.keyboard.press("ArrowUp");
  await first.getByRole("button", { name: "录制第 1 行的目标快捷键" }).click();
  await page.keyboard.press("KeyA");
  await first.getByRole("button", { name: "录制第 2 行的目标快捷键" }).click();
  await page.keyboard.press("KeyB");
  await page.getByRole("button", { name: "保存映射" }).click();
  await page.waitForFunction(() =>
    document.querySelector("#system-feedback").textContent.includes("遥控按键重复"));
  await page.close();
});

test("the Douyin preset creates one editable profile and exports it", async () => {
  const page = await optionsPage();
  await page.getByRole("button", { name: "添加抖音电脑版" }).click();
  await page.waitForFunction(() =>
    document.querySelector("#system-feedback").textContent.includes("已添加抖音电脑版预设"));
  const card = page.locator(".system-profile");
  assert.equal(await card.count(), 1);
  assert.equal(await page.getByLabel("名称", { exact: true }).inputValue(), "抖音电脑版");
  assert.equal(await page.getByLabel("进程名", { exact: true }).inputValue(), "douyin.exe");
  assert.deepEqual(
    await card.locator('button[aria-label^="录制第"][aria-label$="行的遥控按键"]').evaluateAll(nodes => nodes.map(node => node.textContent)),
    ["Enter", "Home", "Page Up", "Page Down"]);
  assert.deepEqual(
    await card.locator('input[aria-label$="行的目标快捷键"]').evaluateAll(nodes => nodes.map(node => node.value)),
    ["Space", "KeyZ", "ArrowUp", "ArrowDown"]);

  // The preset is only added once; clicking again points at the existing profile.
  await page.getByRole("button", { name: "添加抖音电脑版" }).click();
  await page.waitForFunction(() =>
    document.querySelector("#system-feedback").textContent.includes("已有抖音电脑版配置"));
  assert.equal(await card.count(), 1);

  // Targets stay editable for versions whose in-app shortcut settings differ.
  await card.locator('input[aria-label="第 2 行的目标快捷键"]').fill("KeyL");
  await page.getByRole("button", { name: "保存映射" }).click();
  await page.waitForFunction(() =>
    document.querySelector("#system-feedback").textContent.includes("映射已保存"));
  const saved = await page.evaluate(() => chrome.storage.local.get("remoteSystemMap"));
  assert.equal(saved.remoteSystemMap.profiles.length, 1);
  assert.equal(saved.remoteSystemMap.profiles[0].process, "douyin.exe");
  assert.deepEqual(saved.remoteSystemMap.profiles[0].bindings.map(({ source, target }) => ({ source, target })), [
    { source: "Enter", target: "Space" },
    { source: "Home", target: "KeyL" },
    { source: "PageUp", target: "ArrowUp" },
    { source: "PageDown", target: "ArrowDown" }
  ]);

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "下载 remote-keys.json" }).click()
  ]);
  const config = JSON.parse(await fs.readFile(await download.path(), "utf8"));
  assert.equal(config.profiles.length, 1);
  assert.equal(config.profiles[0].name, "抖音电脑版");
  assert.deepEqual(config.profiles[0].bindings[1], { source: "Home", target: "KeyL" });
  await page.close();
});

test("system mapping options produce no uncaught errors", async () => assert.deepEqual(errors, []));
