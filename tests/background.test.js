const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const source = fs.readFileSync(require.resolve("../background.js"), "utf8");

const clone = value => JSON.parse(JSON.stringify(value));
function createWorker({ permission = true, tabs: initial = null } = {}) {
  const calls = [];
  const listeners = {};
  const store = new Map();
  const registered = new Map();
  const on = name => ({ addListener: fn => { (listeners[name] = listeners[name] || []).push(fn); } });
  let tabs = clone(initial || [
    { id: 1, index: 0, active: true, windowId: 7, title: "YouTube", url: "https://www.youtube.com/" },
    { id: 2, index: 1, active: false, windowId: 7, title: "Example", url: "https://example.com/" },
    { id: 3, index: 2, active: false, windowId: 7, title: "Docs", url: "https://docs.example.com/" }
  ]);
  let granted = permission;
  const history = {};
  const chrome = {
    runtime: { id: "extension",
      onMessage: on("message"), onInstalled: on("installed"), onStartup: on("startup"),
      getURL: path => `chrome-extension://extension/${path}` },
    storage: { session: {
      get: async key => {
        const result = {};
        if (key === null || key === undefined) for (const [name, value] of store) result[name] = clone(value);
        else if (store.has(key)) result[key] = clone(store.get(key));
        return result;
      },
      set: async values => { for (const [name, value] of Object.entries(values)) store.set(name, clone(value)); },
      remove: async key => { store.delete(key); }
    } },
    tabs: {
      query: async filter => tabs.filter(tab => filter?.windowId === undefined || tab.windowId === filter.windowId)
        .filter(tab => filter?.active === undefined || tab.active === filter.active).map(clone),
      update: async (id, props) => {
        const tab = tabs.find(item => item.id === id);
        if (!tab) throw new Error("No tab");
        if (props.active) {
          for (const item of tabs) if (item.windowId === tab.windowId) item.active = item.id === id;
          calls.push(["activate", id]);
        }
        return clone(tab);
      },
      reload: async id => { calls.push(["reload", id]); },
      remove: async id => {
        calls.push(["remove", id]);
        const removed = tabs.find(tab => tab.id === id);
        tabs = tabs.filter(tab => tab.id !== id);
        if (removed?.active) { const next = tabs.find(tab => tab.windowId === removed.windowId); if (next) next.active = true; }
      },
      goBack: async id => {
        if (!history[id]?.back) throw new Error("Cannot go back");
        calls.push(["back", id]);
      },
      goForward: async id => {
        if (!history[id]?.forward) throw new Error("Cannot go forward");
        calls.push(["forward", id]);
      },
      sendMessage: async (id, message) => { calls.push(["message", id, message]); },
      onActivated: on("tabs.onActivated"), onCreated: on("tabs.onCreated"), onMoved: on("tabs.onMoved"),
      onAttached: on("tabs.onAttached"), onDetached: on("tabs.onDetached"), onReplaced: on("tabs.onReplaced"),
      onUpdated: on("tabs.onUpdated"), onRemoved: on("tabs.onRemoved")
    },
    windows: { onRemoved: on("windows.onRemoved") },
    permissions: {
      contains: async () => granted,
      onAdded: on("permissions.onAdded"), onRemoved: on("permissions.onRemoved")
    },
    scripting: {
      getRegisteredContentScripts: async ({ ids } = {}) =>
        [...registered.values()].filter(script => !ids || ids.includes(script.id)),
      registerContentScripts: async scripts => { for (const script of scripts) registered.set(script.id, script); },
      unregisterContentScripts: async ({ ids } = {}) => {
        for (const id of ids || [...registered.keys()]) registered.delete(id);
      },
      executeScript: async ({ target }) => { calls.push(["inject", target.tabId]); }
    }
  };
  vm.runInNewContext(source, { chrome, setTimeout, clearTimeout });
  const message = listeners.message[0];
  return {
    calls, store, registered, tabs: () => tabs,
    setPermission: value => { granted = value; },
    setHistory: (id, value) => { history[id] = value; },
    removeTab: id => { tabs = tabs.filter(tab => tab.id !== id); },
    activateTab: id => chrome.tabs.update(id, { active: true }),
    tick: () => new Promise(resolve => setTimeout(resolve, 30)),
    send: (payload, sender) => new Promise(resolve => {
      const keep = message(payload, sender, resolve);
      if (!keep) resolve(null);
    }),
    emit: async (name, ...args) => {
      for (const listener of listeners[name] || []) listener(...args);
      await new Promise(resolve => setTimeout(resolve, 20));
    },
    messagesTo: id => calls.filter(call => call[0] === "message" && call[1] === id)
  };
}
const youtube = (id = 1, windowId = 7) => ({ id: "extension", tab: { id, windowId }, frameId: 0, url: "https://www.youtube.com/" });
const site = (id = 2, windowId = 7) => ({ id: "extension", tab: { id, windowId }, frameId: 0, url: "https://example.com/" });
const extPage = () => ({ id: "extension", url: "chrome-extension://extension/options.html" });

test("tab commands operate only on the sending YouTube top-frame tab", async () => {
  const worker = createWorker();
  const sender = { tab: { id: 17 }, frameId: 0, url: "https://www.youtube.com/watch?v=test" };
  assert.equal((await worker.send({ type: "remote:tab-command", command: "reload" }, sender)).ok, true);
  assert.equal((await worker.send({ type: "remote:tab-command", command: "closeTab" }, sender)).ok, true);
  assert.deepEqual(worker.calls.filter(call => call[0] !== "message"), [["reload", 17], ["remove", 17]]);
  await worker.send({ type: "remote:tab-command", command: "closeTab" }, { ...sender, frameId: 1 });
  await worker.send({ type: "remote:tab-command", command: "closeTab" }, { ...sender, url: "https://example.com/" });
  await worker.send({ type: "remote:tab-command", command: "deleteEverything" }, sender);
  assert.equal(worker.calls.filter(call => call[0] === "remove").length, 1);
});

test("browser mode enters from the active tab and lists the window", async () => {
  const worker = createWorker();
  const entered = await worker.send({ type: "remote:browser-enter" }, youtube());
  assert.equal(entered.ok, true);
  assert.equal(entered.state.active, true);
  assert.deepEqual(entered.state.tabs.map(tab => tab.id), [1, 2, 3]);
  assert.equal(entered.state.position, 1);
  assert.equal(entered.state.total, 3);
  assert.equal(entered.state.phase, "direct");
  assert.equal(worker.messagesTo(1).length > 0, true);
});

test("tab switching and the title list skip tabs that cannot run the controller", async () => {
  const worker = createWorker({ tabs: [
    { id: 1, index: 0, active: true, windowId: 7, title: "YouTube", url: "https://www.youtube.com/" },
    { id: 4, index: 1, active: false, windowId: 7, title: "Settings", url: "chrome://settings/" },
    { id: 5, index: 2, active: false, windowId: 7, title: "Web Store", url: "https://chromewebstore.google.com/" },
    { id: 2, index: 3, active: false, windowId: 7, title: "Feed", url: "https://www.youtube.com/feed" }
  ] });
  const entered = await worker.send({ type: "remote:browser-enter" }, youtube());
  assert.deepEqual(entered.state.tabs.map(tab => tab.id), [1, 2]);
  assert.equal(entered.state.total, 2);
  const next = await worker.send({ type: "remote:browser-input", sessionId: entered.state.sessionId, input: "nextTab", requestId: "s1" }, youtube());
  assert.equal(next.state.activeTabId, 2);
  assert.deepEqual(worker.calls.filter(call => call[0] === "activate"), [["activate", 2]]);

  // Without the optional grant only the YouTube tabs remain reachable.
  const gated = createWorker({ permission: false, tabs: [
    { id: 1, index: 0, active: true, windowId: 7, title: "YouTube", url: "https://www.youtube.com/" },
    { id: 2, index: 1, active: false, windowId: 7, title: "Docs", url: "https://example.com/" }
  ] });
  const only = await gated.send({ type: "remote:browser-enter" }, youtube());
  assert.deepEqual(only.state.tabs.map(tab => tab.id), [1]);
  const stay = await gated.send({ type: "remote:browser-input", sessionId: only.state.sessionId, input: "nextTab", requestId: "s2" }, youtube());
  assert.equal(stay.state.activeTabId, 1);
  assert.equal(gated.calls.filter(call => call[0] === "activate").length, 0);
});

test("re-entering after an exit keeps revisions monotonic", async () => {
  const worker = createWorker();
  const first = await worker.send({ type: "remote:browser-enter" }, youtube());
  const exited = await worker.send({ type: "remote:browser-exit" }, youtube());
  assert.equal(exited.state.active, false);
  assert.ok(exited.state.revision > first.state.revision);
  // A second session must not restart the counter, or controllers drop its state as stale.
  const second = await worker.send({ type: "remote:browser-enter" }, youtube());
  assert.equal(second.state.active, true);
  assert.ok(second.state.revision > exited.state.revision);
  assert.notEqual(second.state.sessionId, first.state.sessionId);
});

test("direct controls switch tabs, reload the current tab and exit with Escape", async () => {
  const worker = createWorker();
  const entered = await worker.send({ type: "remote:browser-enter" }, youtube());
  const sessionId = entered.state.sessionId;

  const next = await worker.send({ type: "remote:browser-input", sessionId, input: "nextTab", requestId: "r1" }, youtube());
  assert.equal(next.ok, true);
  assert.equal(next.state.activeTabId, 2);
  assert.deepEqual(worker.calls.filter(call => call[0] === "activate"), [["activate", 2]]);

  // Input is accepted only from the tab that is currently active.
  const stale = await worker.send({ type: "remote:browser-input", sessionId, input: "nextTab", requestId: "r2" }, youtube());
  assert.equal(stale.ok, false);
  assert.equal(stale.error.code, "NOT_ACTIVE_TAB");

  const wrapped = await worker.send({ type: "remote:browser-input", sessionId, input: "nextTab", requestId: "r3" }, site());
  assert.equal(wrapped.state.activeTabId, 3);
  const looped = await worker.send({ type: "remote:browser-input", sessionId, input: "nextTab", requestId: "r4" }, site(3));
  assert.equal(looped.state.activeTabId, 1);
  const previous = await worker.send({ type: "remote:browser-input", sessionId, input: "previousTab", requestId: "r5" }, youtube());
  assert.equal(previous.state.activeTabId, 3);

  const reload = await worker.send({ type: "remote:browser-input", sessionId, input: "reload", requestId: "r6" }, site(3));
  assert.equal(reload.ok, true);
  assert.deepEqual(worker.calls.filter(call => call[0] === "reload"), [["reload", 3]]);

  const exited = await worker.send({ type: "remote:browser-input", sessionId, input: "escape", requestId: "r7" }, site(3));
  assert.equal(exited.state.active, false);
});

test("history navigation reports missing history without ending the mode", async () => {
  const worker = createWorker();
  const entered = await worker.send({ type: "remote:browser-enter" }, youtube());
  const sessionId = entered.state.sessionId;
  const denied = await worker.send({ type: "remote:browser-input", sessionId, input: "back", requestId: "b1" }, youtube());
  assert.equal(denied.error.code, "NO_HISTORY");
  worker.setHistory(1, { back: true, forward: true });
  const back = await worker.send({ type: "remote:browser-input", sessionId, input: "back", requestId: "b2" }, youtube());
  assert.equal(back.ok, true);
  const forward = await worker.send({ type: "remote:browser-input", sessionId, input: "forward", requestId: "b3" }, youtube());
  assert.equal(forward.ok, true);
  assert.deepEqual(worker.calls.filter(call => ["back", "forward"].includes(call[0])), [["back", 1], ["forward", 1]]);
  assert.equal((await worker.send({ type: "remote:browser-state" }, extPage())).state.active, true);
});

test("duplicate and replayed commands are ignored", async () => {
  const worker = createWorker();
  const entered = await worker.send({ type: "remote:browser-enter" }, youtube());
  const sessionId = entered.state.sessionId;
  await worker.send({ type: "remote:browser-input", sessionId, input: "reload", requestId: "dup" }, youtube());
  await worker.send({ type: "remote:browser-input", sessionId, input: "reload", requestId: "dup" }, youtube());
  assert.equal(worker.calls.filter(call => call[0] === "reload").length, 1);
  await worker.send({ type: "remote:browser-input", sessionId, input: "reload", requestId: "second" }, youtube());
  assert.equal(worker.calls.filter(call => call[0] === "reload").length, 2);
  const stale = await worker.send({ type: "remote:browser-input", sessionId: "old-session", input: "reload", requestId: "x" }, youtube());
  assert.equal(stale.error.code, "STALE_SESSION");
});

test("title selection only moves the highlight and activation validates the tab", async () => {
  const worker = createWorker();
  const entered = await worker.send({ type: "remote:browser-enter" }, youtube());
  const sessionId = entered.state.sessionId;
  const opened = await worker.send({ type: "remote:browser-input", sessionId, input: "openTitles", requestId: "t1" }, youtube());
  assert.equal(opened.state.phase, "titles");
  assert.equal(opened.state.selectedTabId, 1);
  const moved = await worker.send({ type: "remote:browser-input", sessionId, input: "selectionNext", requestId: "t2" }, youtube());
  assert.equal(moved.state.selectedTabId, 2);
  assert.equal(moved.state.activeTabId, 1);
  assert.equal(worker.calls.filter(call => call[0] === "activate").length, 0);
  const activated = await worker.send({ type: "remote:browser-input", sessionId, input: "activateSelected", expectedTabId: 2, requestId: "t3" }, youtube());
  assert.equal(activated.state.phase, "direct");
  assert.equal(activated.state.activeTabId, 2);
  const back = await worker.send({ type: "remote:browser-input", sessionId, input: "openTitles", requestId: "t4" }, site());
  assert.equal(back.state.phase, "titles");
  const closed = await worker.send({ type: "remote:browser-input", sessionId, input: "escape", requestId: "t5" }, site());
  assert.equal(closed.state.phase, "direct");
  assert.equal(closed.state.active, true);
});

test("browser commands require authorization and stay inside the owning window", async () => {
  const worker = createWorker({ permission: false });
  const denied = await worker.send({ type: "remote:browser-enter" }, site());
  assert.equal(denied.ok, false);
  assert.equal(denied.error.code, "NOT_AUTHORIZED");

  const entered = await worker.send({ type: "remote:browser-enter" }, youtube());
  const crossWindow = await worker.send({ type: "remote:browser-input", sessionId: entered.state.sessionId, input: "nextTab" },
    { tab: { id: 9, windowId: 8 }, frameId: 0, url: "https://www.youtube.com/" });
  assert.equal(crossWindow.error.code, "STALE_SESSION");
  const other = await worker.send({ type: "remote:browser-state" }, site(9, 8));
  assert.equal(other.state.active, false);
  const spoofed = await worker.send({ type: "remote:browser-enter" }, { tab: { id: 1, windowId: 7 }, frameId: 0, url: "chrome://settings" });
  assert.equal(spoofed.ok, false);
});

test("closing the entry tab keeps the mode; closing the window ends it", async () => {
  const worker = createWorker();
  const entered = await worker.send({ type: "remote:browser-enter" }, youtube());
  assert.equal(entered.state.active, true);
  worker.removeTab(1);
  await worker.emit("tabs.onRemoved", 1, { windowId: 7 });
  const state = await worker.send({ type: "remote:browser-state" }, extPage());
  assert.equal(state.state.active, true);
  await worker.emit("windows.onRemoved", 7);
  const closed = await worker.send({ type: "remote:browser-state" }, extPage());
  assert.equal(closed.state.active, false);
});

test("the mode survives a worker restart because it is stored in session storage", async () => {
  const first = createWorker();
  const entered = await first.send({ type: "remote:browser-enter" }, youtube());
  const snapshot = first.store.get("remote:browser-mode");
  assert.equal(snapshot.active, true);
  assert.equal(snapshot.sessionId, entered.state.sessionId);
});

test("optional site access registers the all-sites controller and revoking it exits", async () => {
  const worker = createWorker({ permission: false });
  await worker.tick();
  assert.equal(worker.registered.size, 0);
  worker.setPermission(true);
  await worker.emit("permissions.onAdded", { origins: ["https://*/*"] });
  await worker.tick();
  assert.equal(worker.registered.size, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(worker.registered.get("youtube-remote-browser-global").excludeMatches)),
    ["https://www.youtube.com/*"]);

  await worker.activateTab(2);
  const entered = await worker.send({ type: "remote:browser-enter" }, site());
  assert.equal(entered.state.active, true);

  worker.setPermission(false);
  await worker.emit("permissions.onRemoved", { origins: ["https://*/*"] });
  await worker.tick();
  assert.equal(worker.registered.size, 0);
  const state = await worker.send({ type: "remote:browser-state" }, extPage());
  assert.equal(state.state.active, false);
  // A leftover controller cannot issue commands after the grant is revoked.
  const rejected = await worker.send({ type: "remote:browser-input", sessionId: entered.state.sessionId, input: "reload" }, site());
  assert.equal(rejected.error.code, "NOT_AUTHORIZED");
});
