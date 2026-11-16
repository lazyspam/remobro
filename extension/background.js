// remobro background: WebSocket link to the local remobro daemon, tab management,
// screenshots, and step-by-step action runs that survive page navigations.
// One source for both browser families: Firefox/Zen (MV2, persistent background page)
// and Chromium/Chrome/Brave/Edge (MV3, service worker that may be suspended).
"use strict";

const B = globalThis.browser ?? globalThis.chrome;
// Our Chromium build is Manifest V3, the Firefox/Zen build V2 (recent Chromium also
// defines a `browser` global, so that can't tell them apart).
const CHROMIUM = B.runtime.getManifest().manifest_version === 3;
const ACTION = B.action ?? B.browserAction;

const DAEMON = "ws://127.0.0.1:8765/ext";
let ws = null;
let backoff = 1000;
let keepalive = null;

// tabId -> { sessionId, agent, color, goal, paused, min }
const agentTabs = new Map();
// A suspended Chromium service worker loses its memory: keep agent tabs in session storage.
let saveTimer = null;
function saveTabs() {
  if (!B.storage.session) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => B.storage.session.set({ agentTabs: [...agentTabs] }).catch(() => {}), 100);
}
async function restoreTabs() {
  try {
    const { agentTabs: saved } = (await B.storage.session?.get("agentTabs")) || {};
    for (const [id, t] of saved || []) if (!agentTabs.has(id)) agentTabs.set(id, t);
  } catch {}
}
// tabId -> last time a navigation started (status "loading")
const navStarted = new Map();
// tabId -> [{t, s}] failed network requests (HTTP >= 400, network errors) in agent tabs
const netErrors = new Map();

function shortUrl(u) {
  try {
    const x = new URL(u);
    return (x.host + x.pathname).slice(0, 100);
  } catch {
    return String(u).slice(0, 100);
  }
}
const site = (u) => {
  try {
    return new URL(u).hostname.split(".").slice(-2).join(".");
  } catch {
    return "";
  }
};
function pushNet(tabId, s, d) {
  if (/\/favicon\.ico($|\?)/.test(d.url)) return; // noise
  const l = netErrors.get(tabId) || [];
  // third-party = different site than the page (trackers, ads, CDNs blocked by DNS…)
  const page = d.documentUrl || d.initiator || d.originUrl || "";
  const third = d.type !== "main_frame" && !!page && site(d.url) !== site(page);
  if (l.length < 300) l.push({ t: Date.now(), s, third });
  netErrors.set(tabId, l);
}
// first-party failures as lines (deduped ×N), third-party ones as a single count
function netReport(list) {
  const counts = new Map();
  let third = 0;
  for (const e of list) {
    if (e.third) third++;
    else counts.set(e.s, (counts.get(e.s) || 0) + 1);
  }
  const lines = [...counts].map(([s, n]) => (n > 1 ? `${s} ×${n}` : s));
  if (third) lines.push(`(${third} third-party request(s) failed — ignored; errors() lists them)`);
  return lines;
}
B.webRequest.onCompleted.addListener(
  (d) => {
    if (d.statusCode >= 400 && agentTabs.has(d.tabId)) pushNet(d.tabId, `HTTP ${d.statusCode} ${d.method} ${shortUrl(d.url)}`, d);
  },
  { urls: ["<all_urls>"] },
);
B.webRequest.onErrorOccurred.addListener(
  (d) => {
    if (agentTabs.has(d.tabId) && !/ABORTED|BLOCKED_BY_CLIENT/i.test(d.error)) pushNet(d.tabId, `${d.error} ${d.method} ${shortUrl(d.url)}`, d);
  },
  { urls: ["<all_urls>"] },
);
const netSince = (tabId, t0) => (netErrors.get(tabId) || []).filter((e) => e.t >= t0);

// ------------------------------------------------------------------ connection
// Which browser this is, and a stable id per profile, so the daemon can tell several
// connected browsers apart and keep each agent session in one of them.
async function identity() {
  let name = "Browser";
  try {
    if (CHROMIUM) {
      const brands = navigator.userAgentData?.brands?.map((b) => b.brand) || [];
      name = brands.find((b) => !/chromium|not.?a.?brand/i.test(b)) || (brands.some((b) => /chromium/i.test(b)) ? "Chromium" : "Chrome");
      name = name.replace(/^Google /, "").replace(/^Microsoft /, "");
    } else {
      const info = await B.runtime.getBrowserInfo();
      name = info.zen ? "Zen" : info.name || "Firefox"; // Zen says "Firefox" but adds info.zen
    }
  } catch {}
  let { instance } = await B.storage.local.get("instance");
  if (!instance) {
    instance = crypto.randomUUID();
    await B.storage.local.set({ instance });
  }
  return { browser: name, instance };
}

function connect() {
  if (ws && ws.readyState <= WebSocket.OPEN) return; // connecting or open
  try {
    ws = new WebSocket(DAEMON);
  } catch {
    return retry();
  }
  ws.onopen = async () => {
    backoff = 1000;
    send({ event: "hello", version: B.runtime.getManifest().version, ...(await identity()) });
    badge("on");
    // Chromium suspends idle service workers; traffic on the socket keeps this one alive
    clearInterval(keepalive);
    keepalive = setInterval(() => send({ event: "ping" }), 20000);
  };
  ws.onmessage = async (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.id == null) return;
    try {
      const result = await handle(msg.method, msg.params || {});
      send({ id: msg.id, result: result ?? null });
    } catch (e) {
      send({ id: msg.id, error: String(e?.message || e) });
    }
  };
  ws.onclose = () => {
    clearInterval(keepalive);
    badge("off");
    retry();
  };
  ws.onerror = () => {};
}
function retry() {
  setTimeout(connect, backoff);
  backoff = Math.min(backoff * 1.6, 8000);
}
function send(obj) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}
// Backup for retry(): timers die with a suspended service worker, alarms wake it up.
B.alarms?.create("reconnect", { periodInMinutes: 0.5 });
B.alarms?.onAlarm.addListener(() => connect());
B.windows.onFocusChanged.addListener((id) => {
  if (id !== B.windows.WINDOW_ID_NONE) send({ event: "focus" }); // "the browser you used last"
});

function badge(state) {
  ACTION.setBadgeText({ text: state === "on" ? "" : "off" });
  ACTION.setBadgeBackgroundColor({ color: "#888" });
  ACTION.setTitle({ title: state === "on" ? "remobro: connected to agent bridge" : "remobro: daemon not running (remobro daemon)" });
}
restoreTabs().then(connect);

// ------------------------------------------------------------------ tab events
B.tabs.onUpdated.addListener(async (tabId, info) => {
  if (info.status === "loading") {
    navStarted.set(tabId, Date.now());
    // install the error hooks as early as possible on agent pages
    if (agentTabs.has(tabId)) injectHooks(tabId).catch(() => {});
  }
  if (info.status === "complete" && agentTabs.has(tabId)) {
    try {
      await ensureContent(tabId);
      await showOverlay(tabId);
    } catch {}
  }
});
B.tabs.onRemoved.addListener((tabId) => {
  if (agentTabs.has(tabId)) send({ event: "tab_closed", tabId, sessionId: agentTabs.get(tabId).sessionId });
  agentTabs.delete(tabId);
  saveTabs();
  navStarted.delete(tabId);
  netErrors.delete(tabId);
  cdpEvents.delete(tabId);
  cdpSticky.delete(tabId);
});

// pending questions: notification id -> tabId
const pendingAsks = new Map();
function clearAsk(askId) {
  B.notifications.clear("zp-ask-" + askId).catch(() => {});
  pendingAsks.delete("zp-ask-" + askId);
  if (!pendingAsks.size) ACTION.setBadgeText({ text: "" });
}
async function focusTab(tabId) {
  const t = await B.tabs.update(tabId, { active: true });
  await B.windows.update(t.windowId, { focused: true });
}
B.notifications.onClicked.addListener((nid) => {
  const tabId = pendingAsks.get(nid);
  if (tabId != null) focusTab(tabId).catch(() => {});
});
// toolbar button: jump to the tab where an agent is waiting for you
ACTION.onClicked.addListener(() => {
  const [tabId] = [...pendingAsks.values()].slice(-1);
  if (tabId != null) focusTab(tabId).catch(() => {});
});

// UI events from the overlay (pause / take over / answers)
B.runtime.onMessage.addListener((msg, sender) => {
  if (!msg?.ui) return;
  const tabId = sender.tab?.id;
  const t = agentTabs.get(tabId);
  if (msg.ui === "answer") {
    clearAsk(msg.askId);
    return send({ event: "answer", askId: msg.askId, answer: msg.answer });
  }
  if (!t) return;
  // Pause/Resume and minimize apply to every tab of the session, right away (the daemon
  // learns about pauses too, so the agent's next call waits until you resume).
  const patch = msg.ui === "pause" ? { paused: !t.paused } : msg.ui === "min" ? { min: !t.min } : null;
  if (!patch) return;
  for (const [id, x] of agentTabs) {
    if (x.sessionId !== t.sessionId) continue;
    Object.assign(x, patch);
    showOverlay(id);
  }
  saveTabs();
  if ("paused" in patch) send({ event: "pause", sessionId: t.sessionId, paused: patch.paused });
});

// ------------------------------------------------------------------ helpers
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Run an extension script in a tab. world "MAIN" = the page's own JS context (Chromium only).
async function inject(tabId, file, { early = false, world } = {}) {
  if (B.scripting && CHROMIUM) {
    await B.scripting.executeScript({ target: { tabId }, files: [file], injectImmediately: early, ...(world ? { world } : {}) });
  } else {
    await B.tabs.executeScript(tabId, { file, runAt: early ? "document_start" : "document_idle" });
  }
}
// Console-error capture. Firefox reaches into the page from the content script
// (exportFunction); Chromium needs a small script in the page's own world for that.
async function injectHooks(tabId) {
  await inject(tabId, "hook.js", { early: true });
  if (CHROMIUM) await inject(tabId, "hook-main.js", { early: true, world: "MAIN" });
}

// Message the content script. Replies come as {v} or {err} (works the same in both
// browser families, which differ in how listeners may answer).
async function tell(tabId, cmd, args) {
  const r = await B.tabs.sendMessage(tabId, { cmd, args });
  if (r && "err" in r) throw new Error(r.err);
  return r?.v;
}

async function ensureContent(tabId) {
  try {
    if ((await tell(tabId, "ping")) === "pong") return;
  } catch {}
  const tab = await B.tabs.get(tabId);
  if (!/^(https?|file):/.test(tab.url || "")) {
    throw new Error(`can't control ${tab.url || "this tab"} (browser-internal page) — open() a website first`);
  }
  if (tab.status === "loading") await waitComplete(tabId, 15000);
  await injectHooks(tabId).catch(() => {});
  await inject(tabId, "content.js");
}

async function waitComplete(tabId, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const t = await B.tabs.get(tabId).catch(() => null);
    if (!t) throw new Error("tab was closed");
    if (t.status === "complete") return true;
    await sleep(150);
  }
  return false; // still loading (slow page) — continue anyway
}

async function cs(tabId, cmd, args) {
  await ensureContent(tabId);
  return tell(tabId, cmd, args);
}

async function showOverlay(tabId) {
  const t = agentTabs.get(tabId);
  if (!t) return;
  await tell(tabId, "ui", { on: true, agent: t.agent, color: t.color, goal: t.goal, paused: t.paused, min: t.min }).catch(() => {});
}

const GROUP_COLORS = { orange: "#f76f53", green: "#10a37f", blue: "#4c8bf5", purple: "#a06cd5", cyan: "#22b8cf", pink: "#e64980", yellow: "#f2c94c", red: "#e03131", grey: "#999" };

async function addToGroup(tabId, s) {
  if (!B.tabs.group) return null;
  try {
    let gid = s.groupId;
    if (gid != null) {
      try {
        await B.tabGroups.get(gid);
      } catch {
        gid = null;
      }
    }
    gid = await B.tabs.group(gid != null ? { tabIds: [tabId], groupId: gid } : { tabIds: [tabId] });
    await B.tabGroups.update(gid, { title: `${s.agent} · ${(s.goal || "").slice(0, 28)}`, color: s.colorName in GROUP_COLORS ? s.colorName : "orange" });
    return gid;
  } catch {
    return null; // tab groups unsupported here (or Zen essentials/pinned) — not fatal
  }
}

async function pageSummary(tabId, withOutline) {
  const tab = await B.tabs.get(tabId);
  if (!/^(https?|file):/.test(tab.url || "")) return `${tab.title} — ${tab.url}`;
  try {
    return await cs(tabId, withOutline ? "outline" : "status", withOutline ? { maxLines: 30 } : {});
  } catch (e) {
    return `${tab.title} — ${tab.url}\n(page not readable: ${e.message})`;
  }
}

// ------------------------------------------------------------------ RPC methods
async function handle(method, p) {
  switch (method) {
    case "tabs.list": {
      const tabs = await B.tabs.query(p.all ? {} : { currentWindow: true });
      return tabs
        .filter((t) => p.all || !p.sessionId || agentTabs.get(t.id)?.sessionId === p.sessionId || t.active)
        .map((t) => ({ id: t.id, title: t.title, url: t.url, active: t.active, mine: agentTabs.get(t.id)?.sessionId === p.sessionId }));
    }

    case "tab.open": {
      // p: { url?, tab?: id|"active", focus, session: {sessionId, agent, color, colorName, goal, groupId} }
      let tabId;
      if (p.tab != null) {
        const [act] = p.tab === "active" ? await B.tabs.query({ active: true, currentWindow: true }) : [await B.tabs.get(+p.tab)];
        tabId = act.id;
        if (p.url) await B.tabs.update(tabId, { url: p.url });
      } else {
        const t = await B.tabs.create({ url: p.url || "about:blank", active: !!p.focus });
        tabId = t.id;
      }
      const s = p.session;
      const sibling = [...agentTabs.values()].find((x) => x.sessionId === s.sessionId);
      agentTabs.set(tabId, { sessionId: s.sessionId, agent: s.agent, color: s.color, goal: s.goal, paused: false, min: !!sibling?.min });
      saveTabs();
      const groupId = p.tab == null ? await addToGroup(tabId, s) : s.groupId;
      if (p.url) {
        await sleep(100);
        await waitComplete(tabId, 20000);
      }
      try {
        await ensureContent(tabId);
        await showOverlay(tabId);
      } catch {}
      const tab = await B.tabs.get(tabId);
      return { tabId, groupId, url: tab.url, title: tab.title, page: await pageSummary(tabId, p.outline !== false) };
    }

    case "tab.close":
      await B.tabs.remove(+p.tabId);
      return "closed";

    case "tab.info": {
      const t = await B.tabs.get(+p.tabId);
      return { url: t.url, title: t.title };
    }

    case "tab.focus":
      await B.tabs.update(+p.tabId, { active: true });
      return "focused";

    case "tab.release": {
      agentTabs.delete(+p.tabId);
      saveTabs();
      if (cdpTabs.has(+p.tabId)) cdpDetach(+p.tabId);
      await tell(+p.tabId, "ui", { on: false }).catch(() => {});
      return "released";
    }

    case "session.ui": {
      // update overlay state on all tabs of a session (paused, goal…)
      for (const [tabId, t] of agentTabs) {
        if (t.sessionId !== p.sessionId) continue;
        Object.assign(t, p.patch);
        if (p.patch.on === false) {
          agentTabs.delete(tabId);
          if (cdpTabs.has(tabId)) cdpDetach(tabId);
          await tell(tabId, "ui", { on: false }).catch(() => {});
        } else await showOverlay(tabId);
      }
      saveTabs();
      return true;
    }

    case "page.outline":
      return cs(+p.tabId, "outline", p.args);
    case "page.elements":
      return cs(+p.tabId, "elements", p.args);
    case "page.find":
      return cs(+p.tabId, "find", p.args);
    case "page.read":
      return cs(+p.tabId, "read", p.args);

    case "page.errors": {
      const tabId = +p.tabId;
      const cons = await cs(tabId, "errors", {}).catch(() => []);
      const net = (netErrors.get(tabId) || []).map((e) => (e.third ? "(3rd-party) " : "") + e.s);
      if (p.clear) netErrors.set(tabId, []);
      const lines = [...cons.map((e) => "page: " + e), ...net.map((e) => "net: " + e)];
      return lines.length ? lines.slice(-40).join("\n") : "no errors recorded on this page";
    }

    case "page.look":
      return look(+p.tabId, p);

    case "page.act":
      return actSteps(+p.tabId, p.steps || []);

    case "devtools":
      return devtools(+p.tabId, String(p.cmd || ""), p.params || {});

    case "ui.ask": {
      // Show the question in the agent's tab, and tell the user without switching tabs.
      await ensureContent(+p.tabId).catch(() => {});
      await tell(+p.tabId, "ask", p).catch(() => {});
      const agent = agentTabs.get(+p.tabId)?.agent || "AI";
      pendingAsks.set("zp-ask-" + p.askId, +p.tabId);
      B.notifications.create("zp-ask-" + p.askId, {
        type: "basic",
        iconUrl: "icons/icon-128.png",
        title: `${agent} needs you`,
        message: p.question.slice(0, 200) + "\n(click to open the tab)",
      }).catch(() => {});
      ACTION.setBadgeText({ text: "?" });
      ACTION.setBadgeBackgroundColor({ color: "#f76f53" });
      return true;
    }
    case "ui.closeAsk":
      await tell(+p.tabId, "closeAsk").catch(() => {});
      clearAsk(p.askId);
      return true;

    default:
      throw new Error(`unknown method ${method}`);
  }
}

// ------------------------------------------------------------------ screenshots
async function look(tabId, p) {
  await ensureContent(tabId);
  const target = p.target && p.target !== "viewport" && p.target !== "full" ? p.target : null;
  let rect = await cs(tabId, "rect", target ? { target } : { full: p.target === "full" });
  if (p.marks) await cs(tabId, "marks", { on: true });
  await tell(tabId, "uiHide", { hide: true });
  await sleep(200); // let the compositor repaint without the overlay
  try {
    const maxW = p.maxWidth || (target ? 900 : 1200);
    const scale = Math.min(1, maxW / rect.width) * (p.scale || 1);
    const dataUrl = await capture(tabId, rect, scale, p.quality || 60);
    return { dataUrl, w: Math.round(rect.width * scale), h: Math.round(rect.height * scale), scale, x0: rect.x, y0: rect.y };
  } finally {
    await tell(tabId, "uiHide", { hide: false }).catch(() => {});
    if (p.marks) await cs(tabId, "marks", { on: false }).catch(() => {});
  }
}

// rect is in page (document) CSS px. Firefox can capture background tabs directly;
// Chromium only via the DevTools protocol (chrome.debugger), which shows a "remobro
// started debugging this browser" bar while attached, so we detach again when idle.
async function capture(tabId, rect, scale, quality) {
  if (!CHROMIUM) return B.tabs.captureTab(tabId, { format: "jpeg", quality, rect, scale });
  await cdpAttach(tabId);
  const shot = B.debugger.sendCommand({ tabId }, "Page.captureScreenshot", {
    format: "jpeg",
    quality,
    captureBeyondViewport: true,
    clip: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale },
  });
  const timeout = sleep(10000).then(() => {
    throw new Error("screenshot timed out (Chromium did not render the tab)");
  });
  const { data } = await Promise.race([shot, timeout]);
  return "data:image/jpeg;base64," + data;
}
const cdpTabs = new Map(); // tabId -> detach timer
async function cdpAttach(tabId) {
  clearTimeout(cdpTabs.get(tabId));
  if (!cdpTabs.has(tabId)) {
    try {
      await B.debugger.attach({ tabId }, "1.3");
    } catch (e) {
      if (!/already attached/i.test(e.message)) throw new Error(`can't screenshot this tab: ${e.message}`);
    }
  }
  // stay attached while the agent uses devtools (event capture); else detach when idle
  cdpTabs.set(tabId, cdpSticky.has(tabId) ? null : setTimeout(() => cdpDetach(tabId), 15000));
}
function cdpDetach(tabId) {
  clearTimeout(cdpTabs.get(tabId));
  cdpTabs.delete(tabId);
  cdpSticky.delete(tabId);
  B.debugger?.detach({ tabId }).catch(() => {});
}
B.debugger?.onDetach.addListener(({ tabId }) => {
  clearTimeout(cdpTabs.get(tabId));
  cdpTabs.delete(tabId);
  cdpSticky.delete(tabId);
});

// ------------------------------------------------------------------ devtools
// Chromium: the Chrome DevTools Protocol, passed through. Events are kept per tab as
// short lines so the agent can ask for them later without huge payloads.
const cdpSticky = new Set(); // tabs the agent uses devtools on
const cdpEvents = new Map(); // tabId -> [{t, line}]
// low-value chatter that would only cost tokens
const CDP_NOISE = /ExtraInfo$|^Network\.(dataReceived|policyUpdated|resourceChangedPriority)$|^Runtime\.executionContext/;
B.debugger?.onEvent.addListener(({ tabId }, method, params) => {
  if (!cdpSticky.has(tabId) || CDP_NOISE.test(method)) return;
  const list = cdpEvents.get(tabId) || [];
  list.push({ t: Date.now(), line: cdpLine(method, params || {}) });
  if (list.length > 500) list.splice(0, list.length - 500);
  cdpEvents.set(tabId, list);
});
const clip = (x, n) => (x.length > n ? x.slice(0, n - 1) + "…" : x);
const arg = (a) => (a.value !== undefined ? (typeof a.value === "string" ? a.value : JSON.stringify(a.value)) : a.description || a.type);
function cdpLine(method, p) {
  switch (method) {
    case "Network.requestWillBeSent":
      return `→ ${p.requestId} ${p.request.method} ${clip(p.request.url, 140)} (${p.type || "?"})`;
    case "Network.responseReceived":
      return `← ${p.requestId} ${p.response.status} ${clip(p.response.url, 140)} ${p.response.mimeType || ""}`;
    case "Network.loadingFailed":
      return `✗ ${p.requestId} ${p.errorText}${p.canceled ? " (canceled)" : ""}`;
    case "Network.loadingFinished":
      return `✓ ${p.requestId} ${p.encodedDataLength}B`;
    case "Runtime.consoleAPICalled":
      return `console.${p.type}: ${clip((p.args || []).map(arg).join(" "), 300)}`;
    case "Runtime.exceptionThrown":
      return `exception: ${clip(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text || "", 300)}`;
    case "Log.entryAdded":
      return `log.${p.entry.level}: ${clip(p.entry.text, 300)}${p.entry.url ? " " + clip(p.entry.url, 100) : ""}`;
    default:
      return `${method} ${clip(JSON.stringify(p), 200)}`;
  }
}
async function devtools(tabId, cmd, params) {
  if (cmd === "events") {
    const f = String(params.filter || "").toLowerCase();
    const all = cdpEvents.get(tabId) || [];
    const hits = all.filter((e) => !f || e.line.toLowerCase().includes(f));
    if (params.clear) cdpEvents.set(tabId, []);
    const max = Math.min(params.max || 60, 300);
    const shown = hits.slice(-max).map((e) => e.line);
    if (!all.length && !cdpSticky.has(tabId)) return "no events: enable a domain first, e.g. devtools(\"Network.enable\")";
    return (hits.length > max ? `(${hits.length - max} older not shown)\n` : "") + (shown.join("\n") || "no matching events");
  }
  if (!CHROMIUM) {
    if (cmd === "Runtime.evaluate") return evalInPage(tabId, String(params.expression || ""));
    throw new Error(`${cmd} needs a Chromium browser (Chrome, Brave, Edge…); Firefox/Zen only supports Runtime.evaluate`);
  }
  cdpSticky.add(tabId);
  await cdpAttach(tabId);
  const r = await B.debugger.sendCommand({ tabId }, cmd, params);
  return r && Object.keys(r).length ? r : "ok";
}
// Firefox/Zen: run JS in the page's own world (subject to the page's CSP, unlike CDP).
async function evalInPage(tabId, expression) {
  const [r] = await B.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    args: [expression],
    func: (src) => {
      const ser = (x) => {
        try {
          return { value: JSON.parse(JSON.stringify(x === undefined ? null : x)) };
        } catch {
          return { value: String(x) };
        }
      };
      try {
        return Promise.resolve((0, eval)(src)).then(ser, (e) => ({ exception: String(e) }));
      } catch (e) {
        return { exception: String(e) };
      }
    },
  });
  return r?.result;
}

// ------------------------------------------------------------------ actions
const NAV_OPS = new Set(["goto", "back", "forward", "reload"]);

async function navStep(tabId, s) {
  const t0 = Date.now();
  if (s.do === "goto") await B.tabs.update(tabId, { url: s.url });
  else if (s.do === "back") await B.tabs.goBack(tabId);
  else if (s.do === "forward") await B.tabs.goForward(tabId);
  else await B.tabs.reload(tabId);
  // wait for the navigation to start, then finish
  for (let i = 0; i < 20 && !((navStarted.get(tabId) || 0) >= t0); i++) await sleep(50);
  await waitComplete(tabId, 20000);
}

async function navigatedSince(tabId, t0, windowMs) {
  const end = Date.now() + windowMs;
  while (Date.now() < end) {
    if ((navStarted.get(tabId) || 0) >= t0) return true;
    await sleep(50);
  }
  return (navStarted.get(tabId) || 0) >= t0;
}

async function actSteps(tabId, steps) {
  const lines = [];
  const rec = []; // steps with label locators instead of ids (for recorded tests)
  const tStart = Date.now();
  let navigated = false;
  await cs(tabId, "fxBegin");
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const t0 = Date.now();
    if (agentTabs.get(tabId)?.paused) {
      lines.push(`⏸ the user paused you before step ${i + 1}; ${steps.length - i} step(s) not run. Wait for the user.`);
      break;
    }
    if (NAV_OPS.has(s.do)) {
      await navStep(tabId, s);
      lines.push(`✓ ${s.do}${s.url ? " " + s.url : ""}`);
      rec.push(s);
      navigated = true;
      await cs(tabId, "fxBegin").catch(() => {});
      continue;
    }
    let r;
    try {
      r = await cs(tabId, "act", { step: s, last: i === steps.length - 1 });
    } catch (e) {
      // the page may have unloaded mid-action (link click / form submit)
      if (await navigatedSince(tabId, t0, 600)) {
        r = { ok: true, desc: `${s.do} ${s.id ?? s.el ?? ""}`.trim() };
      } else {
        lines.push(`✗ step ${i + 1} ${s.do}${s.id != null ? " " + s.id : ""}: ${e.message}`);
        if (i + 1 < steps.length) lines.push(`(skipped ${steps.length - i - 1} remaining step(s))`);
        break;
      }
    }
    lines.push(`✓ ${r.desc}`);
    if (r.note) lines.push(r.note);
    const { id, ...rest } = s;
    rec.push(id != null && r.loc ? { ...rest, el: r.loc } : s);
    if (await navigatedSince(tabId, t0, 350)) {
      await waitComplete(tabId, 20000);
      navigated = true;
      await cs(tabId, "fxBegin").catch(() => {});
    }
  }
  if (navigated) {
    lines.push(`navigated → ${(await B.tabs.get(tabId)).url}`);
    lines.push(await pageSummary(tabId, true));
  } else {
    const fx = await cs(tabId, "fxEnd").catch((e) => `(effects unavailable: ${e.message})`);
    lines.push(fx);
  }
  if (navigated) {
    const errs = await cs(tabId, "errors", {}).catch(() => []);
    for (const e of errs.slice(0, 4)) lines.push(`ERROR ${e}`);
  }
  const net = netReport(netSince(tabId, tStart));
  for (const e of net.slice(0, 5)) lines.push(e.startsWith("(") ? e : `ERROR ${e}`);
  if (net.length > 5) lines.push(`ERROR … +${net.length - 5} more failed requests (errors())`);
  const tab = await B.tabs.get(tabId);
  return { out: lines.join("\n").replace(/\nno visible change(?=\nERROR)/, ""), rec, url: tab.url, title: tab.title };
}
