// remobro background: WebSocket link to the local remobro daemon, tab management,
// screenshots, and step-by-step action runs that survive page navigations.
"use strict";

const DAEMON = "ws://127.0.0.1:8765/ext";
let ws = null;
let backoff = 1000;

// tabId -> { sessionId, agent, color, goal, paused, min }
const agentTabs = new Map();
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
  const third = !!d.documentUrl && site(d.url) !== site(d.documentUrl) || (!d.documentUrl && d.type !== "main_frame" && site(d.url) !== site(d.originUrl || ""));
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
browser.webRequest.onCompleted.addListener(
  (d) => {
    if (d.statusCode >= 400 && agentTabs.has(d.tabId)) pushNet(d.tabId, `HTTP ${d.statusCode} ${d.method} ${shortUrl(d.url)}`, d);
  },
  { urls: ["<all_urls>"] },
);
browser.webRequest.onErrorOccurred.addListener(
  (d) => {
    if (agentTabs.has(d.tabId) && !/ABORTED|BLOCKED_BY_CLIENT/i.test(d.error)) pushNet(d.tabId, `${d.error} ${d.method} ${shortUrl(d.url)}`, d);
  },
  { urls: ["<all_urls>"] },
);
const netSince = (tabId, t0) => (netErrors.get(tabId) || []).filter((e) => e.t >= t0);

// ------------------------------------------------------------------ connection
function connect() {
  try {
    ws = new WebSocket(DAEMON);
  } catch {
    return retry();
  }
  ws.onopen = () => {
    backoff = 1000;
    send({ event: "hello", version: browser.runtime.getManifest().version });
    badge("on");
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
function badge(state) {
  browser.browserAction.setBadgeText({ text: state === "on" ? "" : "off" });
  browser.browserAction.setBadgeBackgroundColor({ color: "#888" });
  browser.browserAction.setTitle({ title: state === "on" ? "remobro: connected to agent bridge" : "remobro: daemon not running (remobro daemon)" });
}
connect();

// ------------------------------------------------------------------ tab events
browser.tabs.onUpdated.addListener(async (tabId, info) => {
  if (info.status === "loading") {
    navStarted.set(tabId, Date.now());
    // install the error hooks as early as possible on agent pages
    if (agentTabs.has(tabId)) browser.tabs.executeScript(tabId, { file: "hook.js", runAt: "document_start" }).catch(() => {});
  }
  if (info.status === "complete" && agentTabs.has(tabId)) {
    try {
      await ensureContent(tabId);
      await showOverlay(tabId);
    } catch {}
  }
});
browser.tabs.onRemoved.addListener((tabId) => {
  if (agentTabs.has(tabId)) send({ event: "tab_closed", tabId, sessionId: agentTabs.get(tabId).sessionId });
  agentTabs.delete(tabId);
  navStarted.delete(tabId);
});

// pending questions: notification id -> tabId
const pendingAsks = new Map();
function clearAsk(askId) {
  browser.notifications.clear("zp-ask-" + askId).catch(() => {});
  pendingAsks.delete("zp-ask-" + askId);
  if (!pendingAsks.size) browser.browserAction.setBadgeText({ text: "" });
}
async function focusTab(tabId) {
  const t = await browser.tabs.update(tabId, { active: true });
  await browser.windows.update(t.windowId, { focused: true });
}
browser.notifications.onClicked.addListener((nid) => {
  const tabId = pendingAsks.get(nid);
  if (tabId != null) focusTab(tabId).catch(() => {});
});
// toolbar button: jump to the tab where an agent is waiting for you
browser.browserAction.onClicked.addListener(() => {
  const [tabId] = [...pendingAsks.values()].slice(-1);
  if (tabId != null) focusTab(tabId).catch(() => {});
});

// UI events from the overlay (pause / take over / answers)
browser.runtime.onMessage.addListener((msg, sender) => {
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
  if ("paused" in patch) send({ event: "pause", sessionId: t.sessionId, paused: patch.paused });
});

// ------------------------------------------------------------------ helpers
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ensureContent(tabId) {
  try {
    if ((await browser.tabs.sendMessage(tabId, { cmd: "ping" })) === "pong") return;
  } catch {}
  const tab = await browser.tabs.get(tabId);
  if (!/^(https?|file):/.test(tab.url || "")) {
    throw new Error(`can't control ${tab.url || "this tab"} (browser-internal page) — open() a website first`);
  }
  if (tab.status === "loading") await waitComplete(tabId, 15000);
  await browser.tabs.executeScript(tabId, { file: "hook.js", runAt: "document_start" }).catch(() => {});
  await browser.tabs.executeScript(tabId, { file: "content.js", runAt: "document_idle" });
}

async function waitComplete(tabId, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const t = await browser.tabs.get(tabId).catch(() => null);
    if (!t) throw new Error("tab was closed");
    if (t.status === "complete") return true;
    await sleep(150);
  }
  return false; // still loading (slow page) — continue anyway
}

async function cs(tabId, cmd, args) {
  await ensureContent(tabId);
  return browser.tabs.sendMessage(tabId, { cmd, args });
}

async function showOverlay(tabId) {
  const t = agentTabs.get(tabId);
  if (!t) return;
  await browser.tabs.sendMessage(tabId, { cmd: "ui", args: { on: true, agent: t.agent, color: t.color, goal: t.goal, paused: t.paused, min: t.min } }).catch(() => {});
}

const GROUP_COLORS = { orange: "#f76f53", green: "#10a37f", blue: "#4c8bf5", purple: "#a06cd5", cyan: "#22b8cf", pink: "#e64980", yellow: "#f2c94c", red: "#e03131", grey: "#999" };

async function addToGroup(tabId, s) {
  if (!browser.tabs.group) return null;
  try {
    let gid = s.groupId;
    if (gid != null) {
      try {
        await browser.tabGroups.get(gid);
      } catch {
        gid = null;
      }
    }
    gid = await browser.tabs.group(gid != null ? { tabIds: [tabId], groupId: gid } : { tabIds: [tabId] });
    await browser.tabGroups.update(gid, { title: `${s.agent} · ${(s.goal || "").slice(0, 28)}`, color: s.colorName in GROUP_COLORS ? s.colorName : "orange" });
    return gid;
  } catch {
    return null; // tab groups unsupported here (or Zen essentials/pinned) — not fatal
  }
}

async function pageSummary(tabId, withOutline) {
  const tab = await browser.tabs.get(tabId);
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
      const tabs = await browser.tabs.query(p.all ? {} : { currentWindow: true });
      return tabs
        .filter((t) => p.all || !p.sessionId || agentTabs.get(t.id)?.sessionId === p.sessionId || t.active)
        .map((t) => ({ id: t.id, title: t.title, url: t.url, active: t.active, mine: agentTabs.get(t.id)?.sessionId === p.sessionId }));
    }

    case "tab.open": {
      // p: { url?, tab?: id|"active", focus, session: {sessionId, agent, color, colorName, goal, groupId} }
      let tabId;
      if (p.tab != null) {
        const [act] = p.tab === "active" ? await browser.tabs.query({ active: true, currentWindow: true }) : [await browser.tabs.get(+p.tab)];
        tabId = act.id;
        if (p.url) await browser.tabs.update(tabId, { url: p.url });
      } else {
        const t = await browser.tabs.create({ url: p.url || "about:blank", active: !!p.focus });
        tabId = t.id;
      }
      const s = p.session;
      const sibling = [...agentTabs.values()].find((x) => x.sessionId === s.sessionId);
      agentTabs.set(tabId, { sessionId: s.sessionId, agent: s.agent, color: s.color, goal: s.goal, paused: false, min: !!sibling?.min });
      const groupId = p.tab == null ? await addToGroup(tabId, s) : s.groupId;
      if (p.url) {
        await sleep(100);
        await waitComplete(tabId, 20000);
      }
      try {
        await ensureContent(tabId);
        await showOverlay(tabId);
      } catch {}
      const tab = await browser.tabs.get(tabId);
      return { tabId, groupId, url: tab.url, title: tab.title, page: await pageSummary(tabId, p.outline !== false) };
    }

    case "tab.close":
      await browser.tabs.remove(+p.tabId);
      return "closed";

    case "tab.info": {
      const t = await browser.tabs.get(+p.tabId);
      return { url: t.url, title: t.title };
    }

    case "tab.focus":
      await browser.tabs.update(+p.tabId, { active: true });
      return "focused";

    case "tab.release": {
      agentTabs.delete(+p.tabId);
      await browser.tabs.sendMessage(+p.tabId, { cmd: "ui", args: { on: false } }).catch(() => {});
      return "released";
    }

    case "session.ui": {
      // update overlay state on all tabs of a session (paused, goal…)
      for (const [tabId, t] of agentTabs) {
        if (t.sessionId !== p.sessionId) continue;
        Object.assign(t, p.patch);
        if (p.patch.on === false) {
          agentTabs.delete(tabId);
          await browser.tabs.sendMessage(tabId, { cmd: "ui", args: { on: false } }).catch(() => {});
        } else await showOverlay(tabId);
      }
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

    case "ui.ask": {
      // Show the question in the agent's tab, and tell the user without switching tabs.
      await ensureContent(+p.tabId).catch(() => {});
      await browser.tabs.sendMessage(+p.tabId, { cmd: "ask", args: p }).catch(() => {});
      const agent = agentTabs.get(+p.tabId)?.agent || "AI";
      pendingAsks.set("zp-ask-" + p.askId, +p.tabId);
      browser.notifications.create("zp-ask-" + p.askId, {
        type: "basic",
        iconUrl: "icons/icon.svg",
        title: `${agent} needs you`,
        message: p.question.slice(0, 200) + "\n(click to open the tab)",
      }).catch(() => {});
      browser.browserAction.setBadgeText({ text: "?" });
      browser.browserAction.setBadgeBackgroundColor({ color: "#f76f53" });
      return true;
    }
    case "ui.closeAsk":
      await browser.tabs.sendMessage(+p.tabId, { cmd: "closeAsk" }).catch(() => {});
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
  await browser.tabs.sendMessage(tabId, { cmd: "uiHide", args: { hide: true } });
  await sleep(200); // let the compositor repaint without the overlay
  try {
    const maxW = p.maxWidth || (target ? 900 : 1200);
    const scale = Math.min(1, maxW / rect.width) * (p.scale || 1);
    const dataUrl = await browser.tabs.captureTab(tabId, {
      format: "jpeg",
      quality: p.quality || 60,
      rect,
      scale,
    });
    return { dataUrl, w: Math.round(rect.width * scale), h: Math.round(rect.height * scale), scale, x0: rect.x, y0: rect.y };
  } finally {
    await browser.tabs.sendMessage(tabId, { cmd: "uiHide", args: { hide: false } }).catch(() => {});
    if (p.marks) await cs(tabId, "marks", { on: false }).catch(() => {});
  }
}

// ------------------------------------------------------------------ actions
const NAV_OPS = new Set(["goto", "back", "forward", "reload"]);

async function navStep(tabId, s) {
  const t0 = Date.now();
  if (s.do === "goto") await browser.tabs.update(tabId, { url: s.url });
  else if (s.do === "back") await browser.tabs.goBack(tabId);
  else if (s.do === "forward") await browser.tabs.goForward(tabId);
  else await browser.tabs.reload(tabId);
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
    lines.push(`navigated → ${(await browser.tabs.get(tabId)).url}`);
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
  const tab = await browser.tabs.get(tabId);
  return { out: lines.join("\n").replace(/\nno visible change(?=\nERROR)/, ""), rec, url: tab.url, title: tab.title };
}
