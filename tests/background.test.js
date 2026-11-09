const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const source = fs.readFileSync(require.resolve("../background.js"), "utf8");
function background() {
  const calls = [];
  let listener;
  vm.runInNewContext(source, { chrome: {
    runtime: { onMessage: { addListener: value => { listener = value; } } },
    tabs: { remove: async id => calls.push(["closeTab", id]), reload: async id => calls.push(["reload", id]),
      onRemoved: { addListener() {} } }
  } });
  return { calls, send: (command, sender) => new Promise(resolve => {
    const keepAlive = listener({ type: "remote:tab-command", command }, sender, resolve);
    if (!keepAlive) resolve(null);
  }) };
}
test("tab commands operate only on the sending YouTube top-frame tab", async () => {
  const worker = background();
  const sender = { tab: { id: 17 }, frameId: 0, url: "https://www.youtube.com/watch?v=test" };
  assert.equal((await worker.send("reload", sender)).ok, true);
  assert.equal((await worker.send("closeTab", sender)).ok, true);
  assert.deepEqual(worker.calls, [["reload", 17], ["closeTab", 17]]);
  await worker.send("closeTab", { ...sender, frameId: 1 });
  await worker.send("closeTab", { ...sender, url: "https://example.com/" });
  await worker.send("deleteEverything", sender);
  assert.equal(worker.calls.length, 2);
});
