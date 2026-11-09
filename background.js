"use strict";
// Serialize updates so rapid selection changes cannot overwrite another route.
let queue = Promise.resolve();
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (!sender.tab || !/^https:\/\/www\.youtube\.com\//.test(sender.url || "")) return;
  const key = `remote:tab:${sender.tab.id}`;
  queue = queue.catch(() => {}).then(async () => {
    const stored = (await chrome.storage.session.get(key))[key] || { routes: {}, events: [] };
    if (message.type === "remote:restore") {
      respond(stored.routes[message.route] || null);
      return;
    }
    if (message.type === "remote:save" && typeof message.route === "string" && message.route.length < 4096) {
      const snapshot = message.snapshot;
      if (!snapshot || !["list", "sidebar", "player"].includes(snapshot.region)) return respond(null);
      delete stored.routes[message.route];
      stored.routes[message.route] = snapshot;
      while (Object.keys(stored.routes).length > 30) delete stored.routes[Object.keys(stored.routes)[0]];
    } else if (message.type === "remote:diagnostic") {
      const e = message.event;
      if (!e || typeof e.key !== "string") return respond(null);
      stored.events.push({ time: Date.now(), type: String(e.type).slice(0, 30), key: e.key.slice(0, 80),
        code: String(e.code || "").slice(0, 60), repeat: !!e.repeat, composing: !!e.composing,
        region: String(e.region).slice(0, 20), action: String(e.action || "").slice(0, 30) });
      stored.events = stored.events.slice(-60);
    } else return respond(null);
    await chrome.storage.session.set({ [key]: stored });
    respond(true);
  }).catch(() => respond(null));
  return true;
});
chrome.tabs.onRemoved.addListener((tabId) => {
  queue = queue.catch(() => {}).then(() => chrome.storage.session.remove(`remote:tab:${tabId}`));
});
