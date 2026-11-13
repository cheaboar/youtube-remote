(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.RemoteCommandPanel = api;
})(typeof globalThis === "object" ? globalThis : this, function () {
  "use strict";

  // A glass command panel in the same visual language as the YouTube sequence panel.
  // The host owns the key grammar; this module renders groups, tracks the selected action and
  // narrows the list by the typed sequence prefix (leftmost keys first).
  const STYLE = `
    :host{position:fixed;right:24px;top:50%;transform:translateY(-50%);z-index:2147483647;pointer-events:none;color-scheme:light;
      font:400 17px/1.5 -apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue","PingFang SC",sans-serif;
      color:#34363b;-webkit-font-smoothing:antialiased}
    :host([hidden]){display:none!important}
    *{box-sizing:border-box}
    .panel{position:relative;display:flex;flex-direction:column;width:min(440px,calc(100vw - 48px));max-height:calc(100vh - 40px);overflow:hidden;padding:24px;
      background:linear-gradient(145deg,rgba(255,255,255,.32),rgba(255,255,255,.06) 65%),rgba(246,247,249,.82);
      -webkit-backdrop-filter:blur(32px) saturate(145%);backdrop-filter:blur(32px) saturate(145%);
      border:1px solid rgba(255,255,255,.78);border-radius:28px;
      box-shadow:0 18px 58px rgba(24,28,36,.14),0 3px 12px rgba(24,28,36,.05),inset 0 1px 0 rgba(255,255,255,.98),inset 0 -1px 0 rgba(32,36,44,.045)}
    h2{flex-shrink:0;font-size:23px;font-weight:600;letter-spacing:-.45px;margin:0 0 6px}
    .subtitle{flex-shrink:0;margin:0;color:#575b63;font-size:14px;line-height:1.6}
    .subtitle.error{color:#92554d}
    .progress{flex-shrink:0;display:flex;flex-wrap:wrap;gap:8px;align-items:center;min-height:44px;margin:14px 0 8px;padding:8px 12px;
      border:1px solid rgba(255,255,255,.5);border-radius:16px;background:rgba(255,255,255,.32);color:#555960;font-size:13px}
    .rows{position:relative;min-height:0;overflow:auto;overscroll-behavior:contain;padding:10px 10px 0;margin:2px -10px 0;isolation:isolate;outline:none;
      scrollbar-width:thin;scrollbar-color:rgba(88,101,120,.23) transparent}
    .group-title{position:relative;z-index:1;margin:0;padding:14px 0 6px;color:#60646c;font-size:12px;font-weight:500}
    .selection-glass + .group .group-title{padding-top:6px}
    .selection-glass{position:absolute;top:0;left:0;right:0;z-index:0;pointer-events:none;border-radius:16px;
      border:1px solid rgba(255,255,255,.9);background:linear-gradient(155deg,rgba(255,255,255,.6),rgba(255,255,255,.08) 55%),rgba(10,132,255,.14);
      -webkit-backdrop-filter:blur(12px) saturate(165%);backdrop-filter:blur(12px) saturate(165%);
      box-shadow:0 4px 16px rgba(0,100,210,.1),inset 0 1px 0 rgba(255,255,255,.98),inset 0 -1px 0 rgba(10,132,255,.12);
      transition:transform .36s cubic-bezier(.22,1,.36,1),height .28s ease}
    .selection-glass:after{content:"";position:absolute;inset:1px;border-radius:14px;border-top:1px solid rgba(255,255,255,.85)}
    .row{position:relative;z-index:1;display:flex;justify-content:space-between;align-items:center;gap:16px;min-height:46px;padding:6px 0;
      border-bottom:1px solid rgba(55,59,66,.075);transition:color .18s ease}
    .row:last-child{border:0}.row>span{font-weight:450;min-width:0}
    .keys{display:flex;flex-wrap:wrap;justify-content:flex-end;align-items:center;gap:7px;max-width:62%;flex-shrink:0}
    kbd{display:inline-flex;align-items:center;justify-content:center;min-width:32px;min-height:30px;padding:3px 8px;
      border:1px solid rgba(255,255,255,.8);border-radius:10px;background:rgba(255,255,255,.4);color:#555960;
      box-shadow:0 1px 3px rgba(32,36,44,.035),inset 0 1px 0 rgba(255,255,255,.8);font-family:inherit;font-size:16px;font-weight:500;line-height:1.2;overflow-wrap:anywhere}
    .progress kbd{min-width:28px;min-height:26px;font-size:15px}
    .used{opacity:.42}.next{background:rgba(255,255,255,.92);border-color:rgba(109,115,125,.4);color:#303238;
      box-shadow:0 2px 6px rgba(32,36,44,.07),inset 0 1px 0 #fff}
    .row.selected .next{border-color:rgba(10,132,255,.5);background:rgba(255,255,255,.94);box-shadow:0 2px 6px rgba(0,100,210,.1),inset 0 1px 0 #fff}
    .menu{color:#777c84;font-size:13px}
    .empty{color:#646871;font-size:13px}
    .row.selected{color:#0059bd}.row.selected>span{font-weight:600}
    .row.selected kbd{color:#0059bd;border-color:rgba(10,132,255,.22);background:rgba(255,255,255,.65)}
    .row.selected .menu{color:#2d6db3}
    .footer{flex-shrink:0;margin:14px 0 0;font-size:13px;color:#575b63}
    @supports not (backdrop-filter:blur(1px)){.panel{background:rgba(247,248,250,.97)}}
    @media(prefers-reduced-motion:reduce){.selection-glass,.row{transition:none}}
    @media(prefers-reduced-transparency:reduce){.panel{background:#f6f7f9}.selection-glass{background:#deebfc}.panel,.selection-glass{-webkit-backdrop-filter:none;backdrop-filter:none}}
    @media(prefers-contrast:more){.panel{background:#f6f7f9;border-color:#858991}.row{border-color:#b6b9c0}.subtitle,.footer,.group-title,.menu,.empty{color:#42464d}.used{opacity:.7}.row.selected{color:#0059bd}.selection-glass{background:#deebfc;border-color:#0059bd}}
    @media(max-height:580px){.panel{padding:18px}.row{min-height:38px}h2{font-size:21px}.progress{margin:10px 0 4px}.footer{margin-top:10px}}
  `;

  function create(options = {}) {
    const id = options.id || "remote-command-panel";
    const title = options.title || "指令面板";
    const ariaLabel = options.ariaLabel || title;
    const keyLabel = typeof options.label === "function" ? options.label : value => String(value || "");
    let host = null;
    let ui = null;
    let groups = [];
    let allChoices = [];
    let choices = [];
    let prefix = [];
    let error = "";
    let subtitle = "";
    let selected = "";
    let open = false;

    function make(tag, text, className = "") {
      const element = document.createElement(tag);
      if (text) element.textContent = text;
      if (className) element.className = className;
      return element;
    }
    function ensure() {
      if (host) return;
      host = document.createElement("div");
      host.id = id;
      host.hidden = true;
      const shadow = host.attachShadow({ mode: "open" });
      const style = document.createElement("style");
      style.textContent = STYLE;
      const panel = make("section", "", "panel");
      panel.setAttribute("aria-label", ariaLabel);
      const heading = make("h2", title);
      const subtitleNode = make("p", "", "subtitle");
      subtitleNode.setAttribute("role", "status");
      const progress = make("div", "", "progress");
      const rows = make("div", "", "rows");
      rows.setAttribute("role", "listbox");
      rows.setAttribute("aria-label", ariaLabel);
      rows.tabIndex = -1;
      const glass = make("div", "", "selection-glass");
      glass.setAttribute("aria-hidden", "true");
      const footer = make("p", "", "footer");
      panel.append(heading, subtitleNode, progress, rows, footer);
      shadow.append(style, panel);
      ui = { panel, subtitle: subtitleNode, progress, rows, glass, footer };
    }
    function mount() {
      const parent = document.fullscreenElement || document.documentElement;
      if (host.parentElement !== parent) parent.append(host);
    }
    function matching(item) {
      return !prefix.length || !!item.keys?.length && prefix.every((key, index) => item.keys[index] === key);
    }
    function renderProgress() {
      ui.progress.replaceChildren(make("span", "快捷输入"));
      if (!prefix.length) {
        ui.progress.append(make("span", options.startHint || "← / → 开始输入组合", "empty"));
        return;
      }
      ui.progress.firstChild.textContent = "已输入";
      for (const key of prefix) ui.progress.append(make("kbd", keyLabel(key)));
      ui.progress.append(make("span", `剩余 ${choices.length} 项 · Backspace 撤销`, "empty"));
    }
    function renderRows() {
      const nodes = [];
      for (const group of groups) {
        const actions = group.actions.filter(matching);
        if (!actions.length) continue;
        const section = make("div", "", "group");
        section.dataset.group = group.id;
        section.setAttribute("role", "group");
        section.setAttribute("aria-label", group.title);
        const heading = make("div", group.title, "group-title");
        heading.setAttribute("aria-hidden", "true");
        section.append(heading);
        for (const item of actions) {
          const row = make("div", "", "row");
          row.dataset.action = item.action;
          row.id = `${id}-${item.action}`;
          row.setAttribute("role", "option");
          const keys = make("div", "", "keys");
          if (item.keys?.length) {
            item.keys.forEach((key, index) => keys.append(make("kbd", keyLabel(key),
              index < prefix.length ? "used" : index === prefix.length ? "next" : "")));
          } else if (item.hint) keys.append(make("kbd", item.hint));
          else keys.append(make("span", "菜单", "menu"));
          row.append(make("span", item.label), keys);
          section.append(row);
        }
        nodes.push(section);
      }
      ui.rows.replaceChildren(ui.glass, ...nodes);
    }
    function updateSelection() {
      let active = null;
      for (const row of ui.rows.querySelectorAll(".row")) {
        const chosen = row.dataset.action === selected;
        row.classList.toggle("selected", chosen);
        row.setAttribute("aria-selected", String(chosen));
        if (chosen) active = row;
      }
      host.dataset.selected = selected;
      host.dataset.prefix = prefix.join(",");
      host.dataset.candidates = String(choices.length);
      ui.glass.hidden = !active;
      if (!active) {
        ui.rows.removeAttribute("aria-activedescendant");
        return;
      }
      ui.rows.setAttribute("aria-activedescendant", active.id);
      ui.glass.style.height = `${active.offsetHeight}px`;
      ui.glass.style.transform = `translateY(${active.offsetTop}px)`;
      const rowBox = active.getBoundingClientRect();
      const listBox = ui.rows.getBoundingClientRect();
      if (rowBox.bottom > listBox.bottom - 4) ui.rows.scrollTop += rowBox.bottom - listBox.bottom + 4;
      else if (rowBox.top < listBox.top + 4) ui.rows.scrollTop -= listBox.top + 4 - rowBox.top;
    }
    // Rebuild the visible groups from the typed prefix, keeping the selection on a visible row.
    function render({ opening = false } = {}) {
      choices = groups.flatMap(group => group.actions.filter(matching));
      if (prefix.length && !choices.length) {
        prefix = [];
        error = "没有匹配，已重置，请重试";
        choices = groups.flatMap(group => group.actions);
      }
      if (!choices.some(item => item.action === selected)) selected = choices[0]?.action || "";
      ui.subtitle.textContent = error || subtitle;
      ui.subtitle.className = error ? "subtitle error" : "subtitle";
      ui.progress.hidden = !options.startHint && !allChoices.some(item => item.keys?.length);
      renderProgress();
      renderRows();
      if (opening) ui.glass.style.transition = "none";
      updateSelection();
      if (opening) {
        ui.glass.getBoundingClientRect();
        ui.glass.style.removeProperty("transition");
      }
    }

    function openPanel(nextGroups, { selected: preferred = "", subtitle: text = "", footer = "" } = {}) {
      groups = (nextGroups || []).map(group => ({
        ...group,
        actions: (group.actions || []).filter(Boolean)
      })).filter(group => group.actions.length);
      allChoices = groups.flatMap(group => group.actions);
      if (!allChoices.length) return false;
      prefix = [];
      error = "";
      subtitle = text;
      selected = allChoices.some(item => item.action === preferred) ? preferred : allChoices[0].action;
      open = true;
      ensure();
      ui.footer.textContent = footer;
      ui.footer.hidden = !footer;
      host.dataset.open = "1";
      host.dataset.total = String(allChoices.length);
      host.hidden = false;
      mount();
      render({ opening: true });
      return true;
    }
    function close() {
      open = false;
      prefix = [];
      error = "";
      if (!host) return;
      host.dataset.open = "0";
      host.hidden = true;
    }
    function move(delta) {
      if (!open || !choices.length || !delta) return selected;
      const index = choices.findIndex(item => item.action === selected);
      const next = choices[Math.max(0, Math.min(choices.length - 1, index + delta))];
      if (next) {
        selected = next.action;
        updateSelection();
      }
      return selected;
    }
    // Feed one key into the sequence prefix. A complete match is returned for the host to run;
    // a prefix that matches nothing clears the input and reports the error.
    function type(value) {
      if (!open || !value) return null;
      const next = [...prefix, value];
      const matches = allChoices.filter(item => item.keys?.length &&
        next.every((key, index) => item.keys[index] === key));
      if (!matches.length) {
        prefix = [];
        error = "没有匹配，已重置，请重试";
        render();
        return { reset: true };
      }
      const exact = matches.find(item => item.keys.length === next.length);
      if (exact) return { action: exact.action };
      prefix = next;
      error = "";
      render();
      return { changed: true, candidates: matches.length };
    }
    function undo() {
      if (!open || !prefix.length) return false;
      prefix.pop();
      error = "";
      render();
      return true;
    }

    return {
      open: openPanel,
      close,
      move,
      type,
      undo,
      prefix: () => prefix.slice(),
      hasPrefix: () => prefix.length > 0,
      selected: () => selected,
      isOpen: () => open,
      count: () => choices.length,
      total: () => allChoices.length
    };
  }

  return { create };
});
