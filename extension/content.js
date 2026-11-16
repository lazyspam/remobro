// remobro content script: compact page observation, actions with effect reports,
// and the "AI is driving" overlay. Injected on demand by background.js.
(() => {
  if (window.__remobro) return;
  const ZP = (window.__remobro = {});
  const B = globalThis.browser ?? globalThis.chrome;

  // ---------------------------------------------------------------- ids
  // Stable ids: an element keeps its number until it leaves the DOM.
  let nextId = 1;
  let nextRid = 1;
  const idOf = new WeakMap();
  const byId = new Map();
  const ridOf = new WeakMap();
  const byRid = new Map();

  function eid(el) {
    let id = idOf.get(el);
    if (!id) {
      id = nextId++;
      idOf.set(el, id);
      byId.set(id, new WeakRef(el));
    }
    return id;
  }
  function rid(el) {
    let id = ridOf.get(el);
    if (!id) {
      id = "r" + nextRid++;
      ridOf.set(el, id);
      byRid.set(id, new WeakRef(el));
    }
    return id;
  }
  function getEl(id) {
    const n = Number(String(id).replace(/^#/, ""));
    const el = byId.get(n)?.deref();
    if (!el || !el.isConnected) throw new Error(`element ${id} is gone (page changed) - look again with elements()/find()`);
    return el;
  }
  function getTarget(ref) {
    if (ref == null || ref === "") return null;
    const s = String(ref);
    if (/^r\d+$/.test(s)) {
      const el = byRid.get(s)?.deref();
      if (!el || !el.isConnected) throw new Error(`region ${s} is gone - call outline() again`);
      return el;
    }
    return getEl(s);
  }

  // ---------------------------------------------------------------- helpers
  const clip = (s, n) => {
    s = (s || "").replace(/\s+/g, " ").trim();
    return s.length > n ? s.slice(0, n - 1) + "…" : s;
  };
  const q = (s) => JSON.stringify(s);

  const INTERACTIVE = [
    "a[href]", "button", "input:not([type=hidden])", "textarea", "select", "summary",
    "[contenteditable='']", "[contenteditable='true']", "[onclick]",
    "[tabindex]:not([tabindex='-1'])", "[draggable='true']",
    ...["button", "link", "checkbox", "radio", "tab", "menuitem", "menuitemcheckbox", "menuitemradio",
      "option", "switch", "combobox", "textbox", "searchbox", "slider", "spinbutton", "treeitem"]
      .map((r) => `[role=${r}]`),
  ].join(",");

  const LANDMARKS = [
    "header", "nav", "main", "aside", "footer", "form", "dialog[open]",
    "[role=banner]", "[role=navigation]", "[role=main]", "[role=complementary]",
    "[role=contentinfo]", "[role=search]", "[role=form]", "[role=dialog]", "[role=alertdialog]",
    "[role=region][aria-label]", "section[aria-label]", "section[aria-labelledby]",
  ].join(",");

  // Document-ordered querySelectorAll that also descends into open shadow roots.
  function qsaDeep(sel, root = document) {
    const out = [];
    const walk = (r) => {
      const tw = document.createTreeWalker(r, NodeFilter.SHOW_ELEMENT);
      let n;
      while ((n = tw.nextNode())) {
        if (n.matches(sel)) out.push(n);
        if (n.shadowRoot) walk(n.shadowRoot);
      }
    };
    if (root.nodeType === 1 && root.matches(sel)) out.push(root);
    walk(root);
    return out;
  }

  function isVisible(el) {
    if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
    const r = el.getBoundingClientRect();
    return r.width >= 1 && r.height >= 1;
  }
  function inViewport(el, margin = 0) {
    const r = el.getBoundingClientRect();
    return r.bottom > -margin && r.right > 0 && r.top < innerHeight + margin && r.left < innerWidth;
  }

  function role(el) {
    return el.getAttribute("role") || "";
  }

  function kind(el) {
    const t = el.tagName.toLowerCase();
    const r = role(el);
    if (t === "a") return "link";
    if (t === "button" || t === "summary") return "button";
    if (t === "input") {
      const ty = (el.type || "text").toLowerCase();
      if (["submit", "button", "reset", "image"].includes(ty)) return "button";
      if (ty === "checkbox" || ty === "radio") return ty;
      return ty === "text" ? "input" : "input:" + ty;
    }
    if (t === "textarea" || t === "select") return t;
    if (el.isContentEditable) return "editable";
    if (!r && el.getAttribute("draggable") === "true") return "draggable";
    return r || t;
  }

  function textOf(el) {
    return (el.innerText ?? el.textContent ?? "").trim();
  }

  function label(el) {
    let s = el.getAttribute("aria-label") || "";
    if (!s) {
      const lb = el.getAttribute("aria-labelledby");
      if (lb) s = lb.split(/\s+/).map((i) => document.getElementById(i)?.textContent || "").join(" ");
    }
    const t = el.tagName;
    const isField = t === "INPUT" || t === "TEXTAREA" || t === "SELECT";
    if (!s && isField && el.labels?.length) s = [...el.labels].map((l) => l.innerText).join(" ");
    if (!s && t === "INPUT" && ["submit", "button", "reset"].includes(el.type)) s = el.value;
    if (!s && isField) s = el.placeholder || el.title || el.name || "";
    if (!s && !isField) s = textOf(el);
    if (!s) {
      const img = el.querySelector("img[alt]");
      s = img?.alt || el.querySelector("svg title")?.textContent || "";
    }
    if (!s) s = el.title || el.getAttribute("name") || "";
    return clip(s, 60);
  }

  const TRACKING = /^(utm_|fbclid$|gclid$|mc_|ref$|ref_|_hs|igshid$|si$)/;
  function shortHref(el) {
    try {
      const u = new URL(el.href, location.href);
      for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
      const s = u.origin === location.origin ? u.pathname + u.search : u.host + u.pathname;
      return clip(s, 50);
    } catch {
      return "";
    }
  }

  function elLine(el, opts = {}) {
    const k = kind(el);
    let s = `${eid(el)} ${k}`;
    const lab = label(el);
    if (lab) s += ` ${q(lab)}`;
    if (k === "input" || k.startsWith("input:") || k === "textarea" || k === "editable") {
      const v = el.type === "password" ? (el.value ? "•••" : "") : el.isContentEditable ? textOf(el) : el.value;
      if (v || opts.values !== false) s += ` =${q(clip(v || "", 40))}`;
      if (el.required) s += " req";
    }
    if (k === "select") {
      const opts2 = [...el.options].map((o) => clip(o.text, 20));
      s += ` =${q(clip(el.selectedOptions[0]?.text || "", 30))} (${opts2.slice(0, 6).join("|")}${opts2.length > 6 ? `|+${opts2.length - 6}` : ""})`;
    }
    const checked = el.checked ?? (el.getAttribute("aria-checked") === "true" || el.getAttribute("aria-selected") === "true");
    if (k === "checkbox" || k === "radio" || ["checkbox", "switch", "radio", "tab", "option"].includes(role(el)))
      s += checked ? " [x]" : " [ ]";
    if (el.getAttribute("aria-expanded") != null) s += el.getAttribute("aria-expanded") === "true" ? " (open)" : " (closed)";
    if (el.disabled || el.getAttribute("aria-disabled") === "true") s += " (disabled)";
    if (opts.hrefs && k === "link") s += ` →${shortHref(el)}`;
    return s;
  }

  // Label locators: `button "Sign in"`, `input:email "Email"#2`, or bare text "Sign in".
  // Agents can act by label without listing elements first; recorded tests replay with them.
  function locator(el) {
    const k = kind(el), lab = label(el);
    if (!lab) return null;
    const same = interactiveIn(document.body, { viewportOnly: false }).filter((e) => kind(e) === k && label(e) === lab);
    const i = same.indexOf(el);
    return `${k} ${q(lab)}${same.length > 1 && i >= 0 ? "#" + (i + 1) : ""}`;
  }
  function resolveEl(ref) {
    const m = /^(\S+)\s+"(.*)"(?:#(\d+))?$/.exec(String(ref).trim());
    const wantKind = m ? m[1] : null;
    const wantLab = (m ? m[2] : String(ref)).toLowerCase();
    const nth = m && m[3] ? +m[3] - 1 : null;
    const scope = modalDialog() && nth == null ? modalDialog() : document.body;
    const all = interactiveIn(scope, { viewportOnly: false }).filter((e) => !wantKind || kind(e) === wantKind);
    const exact = all.filter((e) => label(e).toLowerCase() === wantLab);
    let pick = nth != null ? exact[nth] : exact.find((e) => inViewport(e)) || exact[0];
    if (!pick && nth == null) {
      const partial = all.filter((e) => label(e).toLowerCase().includes(wantLab));
      pick = partial.find((e) => inViewport(e)) || partial[0];
    }
    if (!pick) {
      const near = all.filter((e) => label(e)).slice(0, 8).map((e) => elLine(e)).join("; ");
      throw new Error(`no element matching ${q(ref)}${near ? ` — e.g. ${near}` : ""}`);
    }
    return pick;
  }

  function interactiveIn(root, { viewportOnly }) {
    const els = qsaDeep(INTERACTIVE, root).filter((el) => isVisible(el) && (!viewportOnly || inViewport(el)));
    // Drop wrappers that just repeat their parent control (e.g. <span tabindex> inside <a>).
    return els.filter((el) => {
      const anc = el.parentElement?.closest(INTERACTIVE);
      if (!anc || !els.includes(anc)) return true;
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return true;
      return textOf(el) !== textOf(anc);
    });
  }

  // Signature used to collapse long runs of look-alike items (result lists, product grids).
  function sig(el) {
    const parts = [kind(el)];
    let p = el.parentElement;
    for (let i = 0; i < 3 && p; i++, p = p.parentElement) {
      parts.push(p.tagName + "." + (typeof p.className === "string" ? p.className.replace(/\d+/g, "").trim().split(/\s+/).slice(0, 2).join(".") : ""));
    }
    return parts.join(">");
  }

  function modalDialog() {
    const ds = qsaDeep("dialog[open],[role=dialog],[role=alertdialog],[aria-modal=true]").filter(isVisible);
    return ds.length ? ds[ds.length - 1] : null;
  }

  function regionName(el) {
    const a = el.getAttribute("aria-label");
    if (a) return clip(a, 40);
    const lb = el.getAttribute("aria-labelledby");
    if (lb) return clip(document.getElementById(lb)?.textContent || "", 40);
    const h = el.querySelector("h1,h2,h3,h4,legend");
    if (h) return clip(textOf(h), 40);
    return "";
  }

  function regionKind(el) {
    const r = role(el);
    if (r) return { banner: "header", contentinfo: "footer", navigation: "nav", complementary: "aside", alertdialog: "dialog" }[r] || r;
    return el.tagName.toLowerCase() === "dialog" ? "dialog" : el.tagName.toLowerCase();
  }

  function stats(el) {
    const items = interactiveIn(el, { viewportOnly: false });
    let links = 0, buttons = 0, fields = 0;
    for (const i of items) {
      const k = kind(i);
      if (k === "link") links++;
      else if (k === "input" || k.startsWith("input:") || k === "textarea" || k === "select" || k === "editable") fields++;
      else buttons++;
    }
    const chars = textOf(el).length;
    const p = [];
    if (chars > 300) p.push(chars >= 1000 ? `${(chars / 1000).toFixed(1)}k chars` : `${chars} chars`);
    if (links) p.push(`${links} links`);
    if (buttons) p.push(`${buttons} buttons`);
    if (fields) p.push(`${fields} fields`);
    return p.join(", ");
  }

  // ---------------------------------------------------------------- L0 status
  ZP.status = () => {
    const se = document.scrollingElement || document.documentElement;
    const screens = se.scrollHeight / innerHeight;
    const dlg = modalDialog();
    const lines = [
      `${clip(document.title, 80)} — ${location.href.slice(0, 120)}`,
      `ready=${document.readyState} · page ${screens.toFixed(1)} screens · scrolled ${Math.round((100 * se.scrollTop) / Math.max(1, se.scrollHeight - innerHeight))}%` +
        (dlg ? ` · MODAL ${rid(dlg)} ${q(regionName(dlg))}` : ""),
    ];
    // flash messages / alerts / toasts: what a tester needs to see after a submit
    const seen = new Set();
    for (const n of qsaDeep("[role=alert],[role=status],[aria-live=assertive],.alert,.flash,.toast,.notification,.error-message,.errors,.invalid-feedback,#flash")) {
      if (seen.size >= 3) break;
      const t = clip(textOf(n), 160);
      if (!t || t.length < 3 || seen.has(t) || !isVisible(n) || [...seen].some((x) => x.includes(t) || t.includes(x))) continue;
      seen.add(t);
      lines.push(`notice ${q(t)}`);
    }
    return lines.join("\n");
  };

  // ---------------------------------------------------------------- L1 outline
  ZP.outline = ({ maxLines = 40 } = {}) => {
    const lines = [ZP.status()];
    const dlg = modalDialog();
    if (dlg) lines.push(`MODAL ${rid(dlg)} dialog ${q(regionName(dlg))}: ${stats(dlg)} — act on it first`);

    let regions = qsaDeep(LANDMARKS).filter(isVisible);
    const top = regions.filter((r) => !regions.some((o) => o !== r && o.contains(r)));
    // Pages without landmarks: use the big direct blocks of <body>.
    if (!top.some((r) => regionKind(r) === "main")) {
      const big = [...document.body.children]
        .filter((c) => !regions.includes(c) && isVisible(c) && c.getBoundingClientRect().height > 150 && textOf(c).length > 200)
        .sort((a, b) => textOf(b).length - textOf(a).length);
      if (big[0]) {
        for (let i = top.length - 1; i >= 0; i--) if (big[0].contains(top[i])) top.splice(i, 1);
        top.push(big[0]);
        top.sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
      }
    }

    const visibleNow = [];
    const emit = (el, depth) => {
      if (lines.length >= maxLines) return;
      const k = regions.includes(el) ? regionKind(el) : "block";
      const name = regionName(el);
      const st = stats(el);
      const id = rid(el);
      if (depth === 0 && inViewport(el)) visibleNow.push(id);
      lines.push(`${"  ".repeat(depth)}${id} ${k}${name ? " " + q(name) : ""}${st ? ": " + st : ""}`);
      // Nested landmarks (search inside header, form inside main) and section headings.
      if (depth === 0) {
        for (const sub of regions.filter((r) => r !== el && el.contains(r) && !regions.some((o) => o !== r && o !== el && el.contains(o) && o.contains(r)))) {
          if (lines.length >= maxLines) break;
          emit(sub, 1);
        }
        if (["main", "block", "article", "region"].includes(k) || el.tagName === "ARTICLE") {
          // headings, minus those already shown as a named sub-region
          const named = new Set(regions.filter((r) => r !== el && el.contains(r)).map(regionName));
          const hs = qsaDeep("h1,h2,h3", el).filter((h) => isVisible(h) && !named.has(clip(textOf(h), 40)));
          for (const h of hs.slice(0, 8)) {
            if (lines.length >= maxLines) break;
            lines.push(`  ${rid(h)} ${h.tagName.toLowerCase()} ${q(clip(textOf(h), 60))}`);
          }
          if (hs.length > 8) lines.push(`  … +${hs.length - 8} headings`);
        }
      }
    };
    for (const r of top) emit(r, 0);
    if (lines.length >= maxLines) lines.push("… (outline truncated)");
    if (visibleNow.length) lines.push(`in view: ${visibleNow.join(" ")}`);
    return lines.join("\n");
  };

  // ---------------------------------------------------------------- L2 elements
  ZP.elements = ({ region, all = false, filter, expand = false, hrefs = false, max = 80 } = {}) => {
    let root = getTarget(region);
    let scope;
    if (!root) {
      const dlg = modalDialog();
      root = dlg || document.body;
      scope = dlg ? `modal ${rid(dlg)}` : all ? "whole page" : "viewport";
    } else scope = String(region);
    let els = interactiveIn(root, { viewportOnly: !all && !region });
    if (filter) {
      const f = String(filter).toLowerCase();
      const kinds = { link: (k) => k === "link", button: (k) => k === "button", field: (k) => /^(input|textarea|select|editable|checkbox|radio)/.test(k) };
      els = els.filter((el) => (kinds[f] ? kinds[f](kind(el)) : label(el).toLowerCase().includes(f)));
    }
    const out = [];
    let i = 0;
    while (i < els.length && out.length < max) {
      // collapse runs of > 6 look-alike items
      let j = i + 1;
      if (!expand) {
        const s = sig(els[i]);
        while (j < els.length && sig(els[j]) === s) j++;
      }
      const run = j - i;
      if (!expand && run > 6) {
        for (let k = i; k < i + 3; k++) out.push(elLine(els[k], { hrefs }));
        for (let k = i + 3; k < j; k++) eid(els[k]);
        out.push(`… +${run - 3} similar ${kind(els[i])}s ${eid(els[i + 3])}–${eid(els[j - 1])} (expand=true or find())`);
        i = j;
      } else {
        out.push(elLine(els[i], { hrefs }));
        i++;
      }
    }
    const more = els.length - i;
    const head = `${scope}: ${els.length} elements`;
    if (more > 0) out.push(`… ${more} more (narrow with region=/filter= or max=)`);
    if (!all && !region && !modalDialog()) {
      const se = document.scrollingElement || document.documentElement;
      if (se.scrollTop + innerHeight < se.scrollHeight - 10) out.push("(more below the fold: scroll, or all=true)");
    }
    return [head, ...out].join("\n");
  };

  // ---------------------------------------------------------------- L2b find
  ZP.find = ({ query, region, max = 12 } = {}) => {
    const root = getTarget(region) || document.body;
    let re;
    const m = /^\/(.+)\/([a-z]*)$/.exec(query || "");
    re = m ? new RegExp(m[1], m[2].includes("i") ? m[2] : m[2] + "i") : new RegExp(String(query).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    const out = [];
    const seen = new Set();
    // 1) controls whose label matches
    for (const el of interactiveIn(root, { viewportOnly: false })) {
      if (out.length >= max) break;
      if (re.test(label(el))) {
        out.push(elLine(el) + (inViewport(el) ? "" : ` (${screensAway(el)})`));
        seen.add(el);
      }
    }
    // 2) text matches, reported with the nearest control
    const walk = (r) => {
      const tw = document.createTreeWalker(r, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = tw.nextNode()) && out.length < max) {
        if (!re.test(n.data)) continue;
        const block = n.parentElement?.closest("p,li,td,th,dd,dt,h1,h2,h3,h4,h5,h6,article,section,div,span,label") || n.parentElement;
        if (!block || seen.has(block) || !isVisible(block)) continue;
        if ([...seen].some((s) => s.nodeType === 1 && (s.contains(block) || block.contains(s)))) continue;
        seen.add(block);
        const txt = textOf(block).replace(/\s+/g, " ");
        const at = txt.search(re);
        const snip = clip(txt.slice(Math.max(0, at - 50), at + 90), 140);
        let near = block.closest(INTERACTIVE) || block.querySelector(INTERACTIVE);
        for (let p = block.parentElement, i = 0; !near && p && i < 4; p = p.parentElement, i++) near = p.querySelector(INTERACTIVE);
        out.push(`· ${q(snip)}${near && isVisible(near) ? ` → near ${elLine(near)}` : ""}${inViewport(block) ? "" : ` (${screensAway(block)})`}`);
      }
    };
    walk(root);
    return out.length ? `${out.length} match(es) for ${query}:\n${out.join("\n")}` : `no matches for ${query}`;
  };

  function screensAway(el) {
    const y = el.getBoundingClientRect().top / innerHeight;
    return y > 0 ? `${y.toFixed(1)} screens down` : `${(-y).toFixed(1)} screens up`;
  }

  // ---------------------------------------------------------------- L3 read
  ZP.read = ({ target, offset = 0, max = 3000 } = {}) => {
    let root = getTarget(target);
    let text;
    if (root && /^H[1-6]$/.test(root.tagName)) {
      // a heading: read its section (until the next heading of the same or higher level)
      const lvl = +root.tagName[1];
      const parts = [textOf(root)];
      for (let n = nextInFlow(root); n; n = nextInFlow(n)) {
        if (/^H[1-6]$/.test(n.tagName) && +n.tagName[1] <= lvl) break;
        if (n.querySelector?.(`h1,h2,h3,h4,h5,h6`)) {
          const sub = [...n.querySelectorAll("h1,h2,h3,h4,h5,h6")].find((h) => +h.tagName[1] <= lvl);
          if (sub) break;
        }
        if (isVisible(n)) parts.push(textOf(n));
        if (parts.join("\n").length > offset + max + 2000) break;
      }
      text = parts.join("\n");
    } else {
      if (!root) root = mainContent();
      text = root.innerText || "";
    }
    // Compact: trim lines, drop empties and immediate repeats, mark headings.
    const heads = new Set(qsaDeep("h1,h2,h3,h4", root?.nodeType === 1 ? root : document.body).map((h) => clip(textOf(h), 200)));
    const lines = [];
    for (let l of text.split("\n")) {
      l = l.replace(/[  ]+/g, " ").trim();
      if (!l || l === lines[lines.length - 1]) continue;
      lines.push(heads.has(l) ? "## " + l : l);
    }
    const all = lines.join("\n");
    const slice = all.slice(offset, offset + max);
    const end = offset + slice.length;
    return (offset ? `[from char ${offset}]\n` : "") + slice + (end < all.length ? `\n[… ${all.length - end} more chars: read(offset=${end})]` : "");
  };

  // Readability-lite: the container that directly holds the most paragraph text,
  // so read() skips menus, toolbars and sidebars.
  function mainContent() {
    const scope = document.querySelector("main,[role=main]") || document.body;
    const score = new Map();
    for (const p of scope.querySelectorAll("p,pre,blockquote,li,td")) {
      const len = (p.textContent || "").trim().length;
      if (len < 40) continue;
      const linkLen = [...p.querySelectorAll("a")].reduce((a, l) => a + l.textContent.length, 0);
      const s = len - 1.5 * linkLen;
      if (s <= 0) continue;
      const par = p.parentElement, gp = par?.parentElement;
      if (par) score.set(par, (score.get(par) || 0) + s);
      if (gp) score.set(gp, (score.get(gp) || 0) + s / 2);
    }
    let best = null, bestS = 0;
    for (const [el, s] of score) if (s > bestS && isVisible(el)) (best = el), (bestS = s);
    if (!best) return scope;
    // include the article's title/header when it sits just above the body
    const art = best.closest("article,[role=article]");
    return art && art.innerText.length < best.innerText.length * 1.6 ? art : best;
  }

  function nextInFlow(n) {
    while (n && !n.nextElementSibling) n = n.parentElement;
    return n ? n.nextElementSibling : null;
  }

  // ---------------------------------------------------------------- L4 look (geometry for screenshots)
  ZP.rectOf = ({ target, margin = 8 } = {}) => {
    const el = getTarget(target);
    if (!el) return null;
    el.scrollIntoView({ block: "nearest", behavior: "instant" });
    const r = el.getBoundingClientRect();
    return {
      x: Math.max(0, r.left + scrollX - margin),
      y: Math.max(0, r.top + scrollY - margin),
      width: Math.min(r.width + 2 * margin, 2400),
      height: Math.min(r.height + 2 * margin, 3000),
    };
  };
  ZP.viewportRect = (full) => {
    const se = document.scrollingElement || document.documentElement;
    return full
      ? { x: 0, y: 0, width: innerWidth, height: Math.min(se.scrollHeight, 6000) }
      : { x: scrollX, y: scrollY, width: innerWidth, height: innerHeight };
  };
  // "Show layout bounds" for screenshots: every visible box under target (default: the page),
  // within the viewport, with margins and padding. Wrappers that exactly cover their parent
  // are skipped. Labels are element numbers, the same ones inspect(N) takes.
  ZP.bounds = ({ on, target } = {}) => {
    if (!on) return UI.bounds(null);
    const root = getTarget(target) || document.body;
    const px = (v) => parseFloat(v) || 0;
    const items = [];
    const vis = (r) => r.width >= 4 && r.height >= 4 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
    const same = (a, b) => Math.abs(a.left - b.left) < 1 && Math.abs(a.top - b.top) < 1 && Math.abs(a.width - b.width) < 1 && Math.abs(a.height - b.height) < 1;
    for (const el of qsaDeep("*", root)) {
      if (items.length >= 400) break;
      if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|LINK|META|BR|REMOBRO-OVERLAY)$/.test(el.tagName) || !isVisible(el)) continue;
      const r = el.getBoundingClientRect();
      if (!vis(r)) continue;
      const par = el.parentElement;
      if (el !== root && par && same(r, par.getBoundingClientRect())) continue;
      const cs = getComputedStyle(el);
      const m = [px(cs.marginTop), px(cs.marginRight), px(cs.marginBottom), px(cs.marginLeft)];
      const p = [px(cs.paddingTop), px(cs.paddingRight), px(cs.paddingBottom), px(cs.paddingLeft)];
      items.push({ id: eid(el), r, m, p, depth: el === root ? 0 : 1 });
    }
    UI.bounds(items);
    return items.length;
  };
  ZP.marks = (on) => {
    UI.marks(on ? interactiveIn(modalDialog() || document.body, { viewportOnly: true }).map((el) => [eid(el), el.getBoundingClientRect()]) : null);
  };

  // ---------------------------------------------------------------- layout inspector
  // Like a mobile layout inspector: any element's box, ancestors, attributes, computed
  // layout and children, the element stack under a point, or a tree of boxes. Boxes are
  // viewport CSS px ("@x,y w×h"), the same coordinates click_at uses.
  const LAYOUT_PROPS = ["display", "position", "zIndex", "overflow", "visibility", "opacity", "flexDirection", "gap",
    "margin", "padding", "fontSize", "fontWeight", "color", "backgroundColor", "cursor", "pointerEvents"];
  const DEFAULTS = { position: "static", zIndex: "auto", overflow: "visible", visibility: "visible", opacity: "1",
    flexDirection: "row", gap: "normal", margin: "0px", padding: "0px", cursor: "auto", pointerEvents: "auto",
    backgroundColor: "rgba(0, 0, 0, 0)" };
  const kebab = (k) => k.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());

  function nodeName(el) {
    let s = el.tagName.toLowerCase();
    if (el.id) s += "#" + clip(el.id, 30);
    const cls = typeof el.className === "string" ? el.className.trim().split(/\s+/).filter(Boolean) : [];
    if (cls.length) s += "." + cls.slice(0, 2).map((c) => clip(c, 24)).join(".") + (cls.length > 2 ? "…" : "");
    const r = role(el);
    if (r) s += `[${r}]`;
    return s;
  }
  function box(el) {
    const r = el.getBoundingClientRect();
    const b = `@${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}×${Math.round(r.height)}`;
    if (!isVisible(el)) return b + " hidden";
    return inViewport(el) ? b : b + " offscreen";
  }
  function ownText(el) {
    let t = "";
    for (const n of el.childNodes) if (n.nodeType === 3) t += n.data;
    t = t.trim() || (el.children.length ? "" : textOf(el));
    return t ? ` ${q(clip(t, 50))}` : "";
  }
  const nodeLine = (el) => `${eid(el)} ${nodeName(el)}${ownText(el)} ${box(el)}`;
  const kids = (el) => [...el.children, ...(el.shadowRoot ? el.shadowRoot.children : [])].filter((c) => !/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|LINK|META)$/.test(c.tagName) && c.tagName !== "REMOBRO-OVERLAY");

  // Alignment check for a group of boxes: shared edges, small offsets (likely bugs),
  // uneven gaps, overlaps, and children sticking out of their parent.
  function alignInfo(els, parent, focus) {
    // only boxes in normal flow: fixed/absolute ones (banners, popovers) aren't laid out with their siblings
    const inFlow = (e) => !/fixed|absolute/.test(getComputedStyle(e).position);
    const rs = els.map((e) => [e, e.getBoundingClientRect()]).filter(([e, r]) => r.width >= 1 && r.height >= 1 && isVisible(e) && (e === focus || inFlow(e)));
    if (rs.length < 2) return [];
    const out = [];
    const tag = (e) => (e === focus ? `${eid(e)}◀` : `${eid(e)}`);
    const r0 = rs[0][1];
    const row = rs.filter(([, r]) => Math.abs(r.top + r.height / 2 - (r0.top + r0.height / 2)) < Math.max(r0.height, r.height) / 2).length > rs.length / 2;
    out.push(`${rs.length} boxes laid out as a ${row ? "row" : "column"}`);
    const metrics = row
      ? { top: (r) => r.top, bottom: (r) => r.bottom, "center-y": (r) => r.top + r.height / 2 }
      : { left: (r) => r.left, right: (r) => r.right, "center-x": (r) => r.left + r.width / 2 };
    const aligned = [];
    for (const [name, f] of Object.entries(metrics)) {
      const vals = rs.map(([e, r]) => [e, Math.round(f(r) * 2) / 2]);
      const counts = new Map();
      for (const [, v] of vals) counts.set(v, (counts.get(v) || 0) + 1);
      const [mode, n] = [...counts].sort((a, b) => b[1] - a[1])[0];
      if (n < 2) continue;
      const off = vals.filter(([, v]) => v !== mode && Math.abs(v - mode) <= 12);
      if (n === vals.length) aligned.push(`${name} ${mode}px`);
      else if (off.length) out.push(`${name}: ${n} at ${mode}px, off by a little: ${off.map(([e, v]) => `${tag(e)} ${v > mode ? "+" : ""}${v - mode}px`).join(", ")}`);
    }
    if (aligned.length) out.push("all aligned on: " + aligned.join(", "));
    // gaps along the main axis
    const sorted = [...rs].sort((a, b) => (row ? a[1].left - b[1].left : a[1].top - b[1].top));
    const gaps = [];
    for (let i = 1; i < sorted.length; i++) {
      const [pe, pr] = sorted[i - 1], [e, r] = sorted[i];
      gaps.push([pe, e, Math.round(row ? r.left - pr.right : r.top - pr.bottom)]);
    }
    const gc = new Map();
    for (const [, , g] of gaps) gc.set(g, (gc.get(g) || 0) + 1);
    const [gmode] = [...gc].sort((a, b) => b[1] - a[1])[0];
    const odd = gaps.filter(([, , g]) => g !== gmode);
    if (gaps.length > 1 && odd.length && odd.length < gaps.length)
      out.push(`gaps: mostly ${gmode}px; ${odd.map(([a, b, g]) => (g < 0 ? `${tag(b)} overlaps ${tag(a)} by ${-g}px` : `${tag(a)}→${tag(b)} ${g}px`)).join(", ")}`);
    else if (gaps.length) out.push(`gaps: ${gaps.length === 1 || !odd.length ? `${gmode}px` : gaps.map(([, , g]) => g + "px").join(", ")}`);
    // children outside the parent's content box
    if (parent && parent !== document.body) {
      const pr = parent.getBoundingClientRect(), pc = getComputedStyle(parent);
      const L = pr.left + parseFloat(pc.borderLeftWidth) + parseFloat(pc.paddingLeft), R = pr.right - parseFloat(pc.borderRightWidth) - parseFloat(pc.paddingRight);
      const T = pr.top + parseFloat(pc.borderTopWidth) + parseFloat(pc.paddingTop), Bm = pr.bottom - parseFloat(pc.borderBottomWidth) - parseFloat(pc.paddingBottom);
      const clipped = pc.overflow !== "visible";
      for (const [e, r] of rs) {
        const sides = [["left", L - r.left], ["right", r.right - R], ["top", T - r.top], ["bottom", r.bottom - Bm]].filter(([, d]) => d > 0.5);
        if (sides.length) out.push(`${tag(e)} sticks out of ${eid(parent)}'s content box: ${sides.map(([k, d]) => `${k} ${Math.round(d)}px`).join(", ")}${clipped ? " (clipped)" : ""}`);
      }
    }
    return out;
  }

  function inspectNode(el) {
    const out = [`node ${nodeLine(el)}`];
    const path = [];
    for (let p = el.parentElement; p && p !== document.documentElement; p = p.parentElement) path.unshift(`${eid(p)} ${nodeName(p)}`);
    if (path.length) out.push("path: " + (path.length > 6 ? ["…", ...path.slice(-6)] : path).join(" > "));
    const attrs = [...el.attributes].filter((a) => !["id", "class", "style"].includes(a.name)).map((a) => `${a.name}=${q(clip(a.value, 60))}`);
    if (el.getAttribute("style")) attrs.push(`style=${q(clip(el.getAttribute("style"), 80))}`);
    if (attrs.length) out.push("attrs: " + attrs.slice(0, 12).join(" "));
    const cs = getComputedStyle(el);
    const lay = LAYOUT_PROPS.map((k) => [k, cs[k]]).filter(([k, v]) => v && v !== DEFAULTS[k] && !(k === "gap" && !/flex|grid/.test(cs.display)) && !(k === "flexDirection" && !/flex/.test(cs.display)));
    out.push("layout: " + lay.map(([k, v]) => `${kebab(k)}=${clip(v, 40)}`).join(" "));
    out.push(`box: margin ${cs.margin} · border ${cs.borderWidth} · padding ${cs.padding}`);
    if (el.scrollHeight > el.clientHeight + 4 && /auto|scroll/.test(cs.overflowY)) out.push(`scrolls: ${el.scrollTop}/${el.scrollHeight - el.clientHeight}px`);
    if (el.scrollWidth > el.clientWidth + 1 && cs.overflowX !== "visible") out.push(`content clipped horizontally by ${el.scrollWidth - el.clientWidth}px`);
    const par = el.parentElement;
    if (par && par !== document.documentElement) {
      const sib = alignInfo(kids(par), par, el);
      if (sib.length) out.push(`among siblings in ${eid(par)} (◀ = this):`, ...sib.map((l) => "  " + l));
    }
    const ch = kids(el);
    if (ch.length) {
      out.push(`children (${ch.length}):`);
      for (const c of ch.slice(0, 25)) out.push("  " + nodeLine(c) + (c.children.length ? ` +${c.children.length}` : ""));
      if (ch.length > 25) out.push(`  … +${ch.length - 25} more`);
      const al = alignInfo(ch, el);
      if (al.length) out.push("children alignment:", ...al.map((l) => "  " + l));
    }
    return out.join("\n");
  }

  // Indented tree of visible boxes. Chains of single-child wrappers fold into one line,
  // and long runs of look-alike siblings collapse.
  function inspectTree(root, depth, max) {
    const out = [];
    const walk = (el, d) => {
      if (out.length >= max) return;
      let chain = [el];
      while (true) {
        const ch = kids(chain[chain.length - 1]).filter(isVisible);
        if (ch.length !== 1 || ownText(chain[chain.length - 1])) break;
        chain.push(ch[0]);
      }
      const last = chain[chain.length - 1];
      const head = chain.length > 1 ? chain.slice(0, -1).map(nodeName).join(" > ") + " > " : "";
      const ch = kids(last).filter(isVisible);
      out.push(`${"  ".repeat(d)}${eid(last)} ${head}${nodeName(last)}${ownText(last)} ${box(last)}${d >= depth && ch.length ? ` +${ch.length}` : ""}`);
      if (d >= depth) return;
      for (let i = 0; i < ch.length && out.length < max; ) {
        let j = i + 1;
        const sg = sig(ch[i]);
        while (j < ch.length && sig(ch[j]) === sg) j++;
        if (j - i > 4) {
          for (let k = i; k < i + 2; k++) walk(ch[k], d + 1);
          out.push(`${"  ".repeat(d + 1)}… +${j - i - 2} similar ${nodeName(ch[i])} ${eid(ch[i + 2])}–${eid(ch[j - 1])}`);
          i = j;
        } else walk(ch[i++], d + 1);
      }
    };
    walk(root, 0);
    if (out.length >= max) out.push(`… (tree truncated at ${max} lines: inspect a child, or raise max)`);
    return out.join("\n");
  }

  ZP.inspect = ({ target, at, tree = false, depth = 2, max = 80 } = {}) => {
    if (at) {
      const [x, y] = String(at).split(/[ ,]+/).map(Number);
      const stack = document.elementsFromPoint(x, y).filter((e) => !e.closest?.("remobro-overlay") && e !== document.documentElement);
      if (!stack.length) return `nothing at ${x},${y} (viewport is ${innerWidth}×${innerHeight})`;
      UI.inspectBox(stack[0], `${eid(stack[0])} ${nodeName(stack[0])}`);
      return [`at ${x},${y}, top first (a click hits the first):`, ...stack.slice(0, 9).map((e, i) => `${i + 1}. ${nodeLine(e)}`), stack.length > 9 ? `… +${stack.length - 9} more` : ""].filter(Boolean).join("\n");
    }
    let el;
    if (target === "picked") {
      el = ZP.picked?.deref();
      if (!el?.isConnected) throw new Error("nothing picked: ask the user to click Point in the remobro bar, then the element");
    } else el = getTarget(target) || document.body;
    UI.inspectBox(el, `${eid(el)} ${nodeName(el)}`);
    return tree ? inspectTree(el, Math.min(depth, 8), Math.min(max, 300)) : inspectNode(el);
  };

  // ---------------------------------------------------------------- effects
  // Snapshot before an action, diff after it: the agent learns what changed without
  // re-reading the page.
  let fx = null;
  ZP.fxBegin = () => {
    const texts = new Map();
    const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n, count = 0;
    while ((n = tw.nextNode()) && count < 4000) {
      const p = n.parentElement;
      if (!p || texts.has(p)) continue;
      const t = p.textContent.trim();
      if (t && t.length <= 100) {
        texts.set(p, t);
        count++;
      }
    }
    const added = [];
    const obs = new MutationObserver((ms) => {
      for (const m of ms) for (const a of m.addedNodes) if (a.nodeType === 1 && added.length < 300) added.push(a);
    });
    obs.observe(document.body, { childList: true, subtree: true });
    fx = { url: location.href, title: document.title, dlg: modalDialog(), texts, added, obs, focus: document.activeElement, errAt: (window.__zpErrors || []).length };
  };

  ZP.errors = ({ since = 0 } = {}) => (window.__zpErrors || []).slice(since).map((e) => e.s);

  ZP.fxEnd = () => {
    if (!fx) return "";
    const f = fx;
    fx = null;
    f.obs.disconnect();
    const out = [];
    if (location.href !== f.url) out.push(`url → ${location.href.slice(0, 120)}`);
    if (document.title !== f.title) out.push(`title → ${q(clip(document.title, 80))}`);
    const dlg = modalDialog();
    if (dlg && dlg !== f.dlg) {
      out.push(`dialog opened ${rid(dlg)} ${q(regionName(dlg))}:`);
      out.push(ZP.elements({ region: rid(dlg), max: 15 }).split("\n").slice(1).map((l) => "  " + l).join("\n"));
    } else if (!dlg && f.dlg) out.push("dialog closed");
    // changed short texts (badges, counters, status lines)
    let changed = 0;
    for (const [el, before] of f.texts) {
      if (changed >= 4) break;
      if (!el.isConnected) continue;
      const now = el.textContent.trim();
      if (now !== before && isVisible(el)) {
        out.push(`text ${q(clip(before, 40))} → ${q(clip(now, 60))}`);
        changed++;
      }
    }
    // new visible text (toasts, validation, results)
    const alerts = [], news = [];
    let addedEls = 0;
    for (const a of f.added) {
      if (!a.isConnected || !isVisible(a)) continue;
      addedEls += 1 + a.querySelectorAll("*").length;
      const t = clip(textOf(a), 120);
      if (!t) continue;
      if (a.closest("[role=alert],[role=status],[aria-live]") || a.matches("[role=alert],[role=status]")) alerts.push(t);
      else if (t.length <= 120) news.push(t);
    }
    for (const t of alerts.slice(0, 3)) out.push(`alert ${q(t)}`);
    for (const t of news.slice(0, Math.max(0, 3 - alerts.length))) out.push(`new ${q(t)}`);
    if (addedEls > 30) out.push(`+${addedEls} elements added (content loaded — elements()/outline())`);
    const inv = qsaDeep("input:invalid,textarea:invalid,select:invalid").filter((e) => isVisible(e) && e.validationMessage && (e.value || e === document.activeElement)).slice(0, 3);
    for (const e of inv) out.push(`invalid ${eid(e)} ${q(label(e))}: ${e.validationMessage}`);
    const ae = document.activeElement;
    if (ae && ae !== f.focus && ae !== document.body && ae.matches(INTERACTIVE)) out.push(`focus ${elLine(ae)}`);
    const errs = ZP.errors({ since: f.errAt });
    for (const e of errs.slice(0, 4)) out.push(`ERROR ${e}`);
    if (errs.length > 4) out.push(`ERROR … +${errs.length - 4} more (errors())`);
    return out.length ? out.join("\n") : "no visible change";
  };

  // ---------------------------------------------------------------- actions
  // Background tabs clamp setTimeout to >= 1s, which made agents 3x slower there.
  // MessageChannel ticks are not throttled, so hidden tabs wait on those instead.
  const mc = new MessageChannel();
  const ticks = [];
  mc.port1.onmessage = () => ticks.shift()?.();
  const tick = () => new Promise((r) => (ticks.push(r), mc.port2.postMessage(0)));
  async function sleep(ms) {
    if (!document.hidden) return new Promise((r) => setTimeout(r, ms));
    const end = performance.now() + ms;
    while (performance.now() < end) await tick();
  }

  async function settle(quiet = 300, maxWait = 2500) {
    const start = performance.now();
    let last = start;
    const obs = new MutationObserver(() => (last = performance.now()));
    obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
    for (;;) {
      const now = performance.now();
      if (now - last >= quiet || now - start >= maxWait) break;
      await sleep(Math.min(40, quiet));
    }
    obs.disconnect();
  }

  function center(el) {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, r };
  }

  // Our pointer events are synthetic, so no real pointer has this id. Apps that call
  // setPointerCapture(e.pointerId) (canvas editors, sliders, drag and drop) would get
  // "Invalid pointer id"; hook.js / hook-main.js let capture calls with this id pass.
  const SYNTH_POINTER = 7331;
  function mouse(el, type, x, y, extra = {}) {
    const Ctor = type.startsWith("pointer") ? PointerEvent : MouseEvent;
    el.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, view: window, button: 0, buttons: type.endsWith("down") ? 1 : 0, pointerType: "mouse", pointerId: SYNTH_POINTER, isPrimary: true, ...extra }));
  }

  async function prep(el) {
    const r0 = el.getBoundingClientRect();
    if (r0.top < 0 || r0.bottom > innerHeight || r0.left < 0 || r0.right > innerWidth) {
      el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      await sleep(30);
    }
    const { x, y, r } = center(el);
    // humans don't hit the exact centre
    const jx = x + (Math.random() - 0.5) * Math.min(r.width * 0.3, 16);
    const jy = y + (Math.random() - 0.5) * Math.min(r.height * 0.3, 6);
    await UI.pointTo(jx, jy, r, el);
    return { x: jx, y: jy };
  }

  function coverCheck(el, x, y) {
    const top = document.elementFromPoint(x, y);
    if (top && top !== el && !el.contains(top) && !top.contains(el)) {
      const c = top.closest(INTERACTIVE) || top;
      return `warning: target was covered by <${c.tagName.toLowerCase()}${c.id ? "#" + c.id : ""}> ${q(clip(textOf(c), 50))} (cookie banner/overlay?)`;
    }
    return "";
  }

  function setValue(el, value) {
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : el.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    setter.call(el, value); // bypass React's value tracker
    el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: value }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  const KEYS = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, ArrowDown: 40, ArrowUp: 38, ArrowLeft: 37, ArrowRight: 39, " ": 32, Space: 32, PageDown: 34, PageUp: 33, Home: 36, End: 35, Delete: 46 };
  // punctuation: key -> [code, keyCode] (US layout; shifted variants share the physical key)
  const PUNCT = { ".": ["Period", 190], ">": ["Period", 190], ",": ["Comma", 188], "<": ["Comma", 188], "/": ["Slash", 191], "?": ["Slash", 191],
    ";": ["Semicolon", 186], ":": ["Semicolon", 186], "'": ["Quote", 222], '"': ["Quote", 222], "[": ["BracketLeft", 219], "{": ["BracketLeft", 219],
    "]": ["BracketRight", 221], "}": ["BracketRight", 221], "-": ["Minus", 189], "_": ["Minus", 189], "=": ["Equal", 187], "+": ["Equal", 187],
    "\\": ["Backslash", 220], "|": ["Backslash", 220], "`": ["Backquote", 192], "~": ["Backquote", 192] };
  function keyInit(k, mods = {}) {
    if (k === "Space") k = " ";
    let code, kc;
    if (PUNCT[k]) [code, kc] = PUNCT[k];
    else if (/^[0-9]$/.test(k)) (code = "Digit" + k), (kc = 48 + +k);
    else if (k.length === 1) (code = k === " " ? "Space" : "Key" + k.toUpperCase()), (kc = KEYS[k] || k.toUpperCase().charCodeAt(0));
    else (code = k), (kc = KEYS[k] || 0);
    const shift = k.length === 1 && k !== k.toLowerCase();
    return { key: k, code, keyCode: kc, which: kc, bubbles: true, cancelable: true, composed: true, shiftKey: shift, ...mods };
  }
  function key(el, k, mods = {}) {
    if (k === "Space") k = " ";
    const init = keyInit(k, mods);
    const down = el.dispatchEvent(new KeyboardEvent("keydown", init));
    if (k.length === 1 || k === "Enter") el.dispatchEvent(new KeyboardEvent("keypress", init));
    el.dispatchEvent(new KeyboardEvent("keyup", init));
    return down; // false if a handler called preventDefault
  }

  // ---- human-like typing (only animated while someone is watching the tab)
  function insertChar(el, ch) {
    if (document.execCommand("insertText", false, ch)) return; // real input events, undo stack
    if (!("value" in el)) return;
    const v = el.value || "";
    const st = typeof el.selectionStart === "number" ? el.selectionStart : v.length;
    const en = typeof el.selectionEnd === "number" ? el.selectionEnd : v.length;
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, v.slice(0, st) + ch + v.slice(en));
    try {
      el.setSelectionRange(st + ch.length, st + ch.length);
    } catch {}
    el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: ch }));
  }
  function charDelay(ch, prev, base) {
    let d = base * (0.5 + Math.random()); // jitter
    if (ch === " ") d += base * 0.35;
    if (/[.,!?;:]/.test(prev)) d += 90 + Math.random() * 160; // pause after punctuation
    if (/[A-Z0-9@#$%&*()]/.test(ch)) d += base * 0.4; // shift / number row
    if (Math.random() < 0.035) d += 140 + Math.random() * 220; // brief hesitation
    return d;
  }
  async function humanType(el, text, { replace = false, keys = true } = {}) {
    const editable = el.isContentEditable;
    if (replace) {
      if (editable) {
        document.getSelection().selectAllChildren(el);
        document.execCommand("delete");
      } else if (el.value) {
        try {
          el.select();
        } catch {}
        if (!document.execCommand("delete")) setValue(el, "");
      }
    }
    if (!UI.watching() || text.length > 300) {
      // nobody watching (background tab / replay): type instantly
      if (!document.execCommand("insertText", false, text)) {
        if (editable) el.textContent += text;
        else setValue(el, (el.value || "") + text);
      }
      if (!editable && "value" in el) el.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }
    const base = Math.max(16, Math.min(75, 2400 / Math.max(1, text.length))); // ~2.5s cap per field
    let prev = "";
    for (const ch of text) {
      const init = keyInit(ch);
      const ok = !keys || el.dispatchEvent(new KeyboardEvent("keydown", init));
      if (ok) {
        if (keys) el.dispatchEvent(new KeyboardEvent("keypress", init));
        insertChar(el, ch);
      }
      if (keys) el.dispatchEvent(new KeyboardEvent("keyup", init));
      await sleep(charDelay(ch, prev, base));
      prev = ch;
    }
    if (!editable && "value" in el) el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  ZP.act = async (s, { last = true } = {}) => {
    const op = s.do;
    const el = s.id != null ? getEl(s.id) : s.el != null && op !== "expect" ? resolveEl(s.el) : null;
    const loc = el ? locator(el) : null;
    const name = el ? `${eid(el)} ${q(label(el))}` : "";
    UI.step(`${op} ${name}`.trim());
    let note = "", dragTo = null;
    switch (op) {
      case "click":
      case "dblclick":
      case "hover": {
        const { x, y } = await prep(el);
        note = coverCheck(el, x, y);
        for (const t of ["pointerover", "pointerenter", "mouseover", "mouseenter", "pointermove", "mousemove"]) mouse(el, t, x, y);
        if (op === "hover") break;
        await UI.press(true);
        mouse(el, "pointerdown", x, y);
        mouse(el, "mousedown", x, y);
        el.focus?.({ preventScroll: true });
        await sleep(UI.watching() ? 55 + Math.random() * 50 : 0); // button held briefly
        mouse(el, "pointerup", x, y);
        mouse(el, "mouseup", x, y);
        UI.press(false);
        UI.ripple(x, y);
        el.click(); // fires click + default action (links, submit buttons, labels)
        if (op === "dblclick") mouse(el, "dblclick", x, y, { detail: 2 });
        break;
      }
      case "fill": {
        await prep(el);
        await UI.press(true);
        await sleep(UI.watching() ? 60 : 0);
        UI.press(false);
        el.focus?.({ preventScroll: true });
        await humanType(el, String(s.text ?? ""), { replace: true });
        if (s.enter) await sleep(UI.watching() ? 180 : 0), await pressEnter(el);
        break;
      }
      case "type": {
        const target = el || document.activeElement || document.body;
        if (el) await prep(el), el.focus?.({ preventScroll: true });
        await humanType(target, String(s.text ?? ""));
        if (s.enter) await pressEnter(target);
        break;
      }
      case "insert": {
        // Insert text into whatever has focus via the editing command (real input events):
        // works in canvas-app text editors (Figma, Docs) where synthetic key presses don't.
        if (el) el.focus?.({ preventScroll: true });
        // canvas apps focus their text editor a moment after the click: wait for it
        const editable = (e) => e && (e.isContentEditable || /^(INPUT|TEXTAREA)$/.test(e.tagName));
        for (let i = 0; i < 30 && !el && !editable(document.activeElement); i++) await sleep(50);
        const target = el || document.activeElement;
        const sel = document.getSelection();
        if (target?.isContentEditable && !(sel.rangeCount && target.contains(sel.anchorNode))) {
          const r = document.createRange();
          r.selectNodeContents(target);
          r.collapse(false);
          sel.removeAllRanges();
          sel.addRange(r);
        }
        if (!target || !(target.isContentEditable || "value" in target))
          throw new Error(`nothing editable is focused (active: <${target?.tagName?.toLowerCase()}>)`);
        await humanType(target, String(s.text ?? ""), { keys: false });
        break;
      }
      case "select": {
        await prep(el);
        if (el.tagName === "SELECT") {
          const want = String(s.value ?? s.text ?? "").toLowerCase();
          const opt = [...el.options].find((o) => o.value.toLowerCase() === want || o.text.trim().toLowerCase() === want) ||
            [...el.options].find((o) => o.text.toLowerCase().includes(want));
          if (!opt) throw new Error(`no option ${q(want)} in ${name}; options: ${[...el.options].map((o) => o.text.trim()).slice(0, 15).join(" | ")}`);
          setValue(el, opt.value);
        } else {
          throw new Error(`${name} is not a <select>; click it, then click the option`);
        }
        break;
      }
      case "check": {
        const want = s.on !== false;
        const isOn = el.checked ?? el.getAttribute("aria-checked") === "true";
        if (isOn !== want) {
          const { x, y } = await prep(el);
          UI.ripple(x, y);
          el.click();
        }
        break;
      }
      case "press": {
        const target = el || document.activeElement || document.body;
        if (el) await prep(el), el.focus?.({ preventScroll: true });
        const mods = { ctrlKey: !!s.ctrl, shiftKey: !!s.shift, altKey: !!s.alt, metaKey: !!s.meta };
        const times = Math.max(1, Math.min(200, s.repeat || 1));
        for (let r = 0; r < times; r++) {
          const t = el || document.activeElement || document.body;
          if (s.key === "Enter" && !Object.values(mods).some(Boolean)) await pressEnter(t);
          else if (key(t, s.key, mods)) {
            if (s.key === "Tab") moveFocus(t, s.shift ? -1 : 1);
            if (s.key === "Escape") modalDialog()?.querySelector("[aria-label*=close i],[aria-label*=schließen i],button.close")?.click?.();
          }
          if (times > 1) await sleep(10);
        }
        break;
      }
      case "expect": {
        // assertion for end-to-end tests; waits up to ms (default 4000)
        const until = Date.now() + Math.min(s.ms ?? 4000, 30000);
        const want = s.not ? false : true;
        const check = () => {
          if (s.text != null) return new RegExp(String(s.text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(document.body.innerText);
          if (s.url != null) return location.href.includes(s.url);
          if (s.title != null) return document.title.toLowerCase().includes(String(s.title).toLowerCase());
          if (s.el != null) {
            try {
              return isVisible(resolveEl(s.el));
            } catch {
              return false;
            }
          }
          throw new Error('expect needs text, url, title or el');
        };
        while (check() !== want) {
          if (Date.now() > until) {
            const what = s.text != null ? `text ${q(s.text)}` : s.url != null ? `url containing ${q(s.url)} (now ${location.href})` : s.title != null ? `title ${q(s.title)} (now ${q(document.title)})` : `element ${q(s.el)}`;
            throw new Error(`expected ${s.not ? "no " : ""}${what}`);
          }
          await sleep(150);
        }
        return { ok: true, desc: `expect ${s.not ? "no " : ""}${s.text ?? s.url ?? s.title ?? s.el}`, loc: null };
      }
      case "scroll": {
        if (el) {
          el.scrollIntoView({ block: "center", behavior: "instant" });
          const { x, y, r } = center(el);
          await UI.pointTo(x, y, r, el);
        } else {
          const amt = (s.amount ?? 0.85) * innerHeight;
          const dir = s.dir || "down";
          const box = s.region ? getTarget(s.region) : null;
          const sc = box && box.scrollHeight > box.clientHeight ? box : document.scrollingElement || document.documentElement;
          if (dir === "top") sc.scrollTo({ top: 0, behavior: "instant" });
          else if (dir === "bottom") sc.scrollTo({ top: sc.scrollHeight, behavior: "instant" });
          else sc.scrollBy({ top: dir === "up" ? -amt : amt, behavior: "instant" });
        }
        break;
      }
      // Coordinate actions for canvas apps (Figma, maps, games). x/y are viewport CSS pixels.
      case "drag": {
        const r = await dragOp(s, el);
        note = r.note;
        dragTo = r.toLoc;
        break;
      }
      case "click_at":
      case "move": {
        const pt = (x, y) => ({ x: +x, y: +y, t: document.elementFromPoint(+x, +y) || document.body });
        const a = pt(s.x, s.y);
        await UI.pointTo(a.x, a.y);
        const opt = {};
        mouse(a.t, "pointermove", a.x, a.y, opt);
        mouse(a.t, "mousemove", a.x, a.y);
        if (op === "move") break;
        await UI.press(true);
        mouse(a.t, "pointerdown", a.x, a.y, opt);
        mouse(a.t, "mousedown", a.x, a.y);
        await sleep(UI.watching() ? 60 : 0);
        UI.press(false);
        mouse(a.t, "pointerup", a.x, a.y, opt);
        mouse(a.t, "mouseup", a.x, a.y);
        mouse(a.t, "click", a.x, a.y);
        if (s.double) mouse(a.t, "dblclick", a.x, a.y, { detail: 2 });
        UI.ripple(a.x, a.y);
        break;
      }
      case "wait": {
        const until = Date.now() + Math.min(s.ms ?? 5000, 20000);
        if (s.text) {
          const re = new RegExp(String(s.text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
          while (!re.test(document.body.innerText)) {
            if (Date.now() > until) throw new Error(`text ${q(s.text)} did not appear`);
            await sleep(250);
          }
        } else await sleep(Math.min(s.ms ?? 1000, 20000));
        break;
      }
      default:
        throw new Error(`unknown action ${q(op)}`);
    }
    // Short settle between steps of a batch, full settle only after the last one (or clicks,
    // which may load content the next step needs).
    const heavy = op === "click" || op === "dblclick" || op === "check" || (op === "fill" && s.enter);
    if (op !== "wait") await settle(last || heavy ? 250 : 80, last || heavy ? 2500 : 600);
    return { ok: true, desc: `${op} ${name}${s.repeat > 1 ? " ×" + s.repeat : ""}`.trim(), note, loc, toLoc: dragTo };
  };

  // ---------------------------------------------------------------- drag
  // The element at a point, looking through remobro's own overlay.
  function hit(x, y) {
    for (const e of document.elementsFromPoint(x, y)) if (e.tagName !== "REMOBRO-OVERLAY") return e;
    return document.documentElement;
  }
  // drag from an element (or s.x,s.y) to "to" (element number, label, or "x,y"), dx/dy, or x2/y2.
  // draggable="true" sources get real HTML5 drag-and-drop events (kanban boards, sortable
  // lists, drop zones); everything else a pointer/mouse drag (sliders, canvases, dnd libraries).
  async function dragOp(s, src) {
    let a;
    if (src) a = await prep(src);
    else a = { x: +s.x, y: +s.y };
    if (!Number.isFinite(a.x) || !Number.isFinite(a.y)) throw new Error('drag needs a source: "id"/"el", or x,y');
    let dest = null, b;
    if (s.to != null) {
      const m = /^\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*$/.exec(String(s.to));
      if (m) b = { x: +m[1], y: +m[2] };
      else {
        dest = /^#?\d+$/.test(String(s.to)) ? getEl(s.to) : resolveDropTarget(String(s.to));
        if (!inViewport(dest)) {
          dest.scrollIntoView({ block: "nearest", behavior: "instant" });
          if (src) a = center(src);
        }
        if (src && !inViewport(src)) throw new Error("source and target don't fit on one screen: scroll so both are visible, or drag in steps");
        const c = center(dest);
        b = { x: c.x, y: c.y };
      }
    } else if (s.dx != null || s.dy != null) b = { x: a.x + (+s.dx || 0), y: a.y + (+s.dy || 0) };
    else if (s.x2 != null) b = { x: +s.x2, y: +s.y2 };
    else throw new Error('drag needs a target: "to" (element number, label or "x,y"), dx/dy, or x2/y2');
    const toLoc = dest ? locator(dest) : null;
    // native range sliders ignore synthetic pointer events: set the value at the drop position
    if (src?.matches?.('input[type="range"]')) {
      const r = src.getBoundingClientRect(), min = +src.min || 0, max = src.max === "" ? 100 : +src.max, step = +src.step || 1;
      const v = Math.min(max, Math.max(min, min + Math.round((((b.x - r.left) / r.width) * (max - min)) / step) * step));
      await UI.pointTo(b.x, a.y);
      setValue(src, String(v));
      return { note: `slider ${eid(src)} → ${src.value}`, toLoc };
    }
    const draggable = (src || hit(a.x, a.y)).closest?.('[draggable="true"]');
    const note = draggable ? await html5Drag(draggable, a, b) : await pointerDrag(a, b);
    return { note, toLoc };
  }
  // Drop targets are often not controls (a "Done" column, a folder row): match controls
  // first, then any visible element whose own text is the label (the deepest one).
  function resolveDropTarget(label) {
    try {
      return resolveEl(label);
    } catch (e) {
      const want = label.trim().toLowerCase();
      let best = null;
      for (const el of qsaDeep("*", document.body)) {
        if (/^(SCRIPT|STYLE|REMOBRO-OVERLAY)$/.test(el.tagName) || !isVisible(el)) continue;
        const own = ownText(el).trim().replace(/^"|"$/g, "").toLowerCase();
        if (own === want || (!best && own.startsWith(want))) best = el;
        if (own === want) break;
      }
      if (!best) throw e;
      return best;
    }
  }
  const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
  // After setPointerCapture, a browser sends every pointer event to the capturing element.
  const captor = () => document.querySelector("[data-remobro-capture]");
  async function pointerDrag(a, b) {
    document.querySelectorAll("[data-remobro-capture]").forEach((e) => e.removeAttribute("data-remobro-capture"));
    const t0 = hit(a.x, a.y);
    await UI.pointTo(a.x, a.y);
    mouse(t0, "pointermove", a.x, a.y);
    mouse(t0, "mousemove", a.x, a.y);
    await UI.press(true);
    mouse(t0, "pointerdown", a.x, a.y);
    mouse(t0, "mousedown", a.x, a.y);
    await sleep(80); // a beat before moving: some libraries start dragging only after a hold
    const n = Math.max(8, Math.min(40, Math.round(Math.hypot(b.x - a.x, b.y - a.y) / 20)));
    for (let i = 1; i <= n; i++) {
      const k = ease(i / n);
      const x = a.x + (b.x - a.x) * k, y = a.y + (b.y - a.y) * k;
      const t = hit(x, y);
      mouse(captor() || t, "pointermove", x, y, { buttons: 1 });
      mouse(t, "mousemove", x, y, { buttons: 1 });
      UI.cursorAt(x, y);
      await sleep(16);
    }
    await sleep(120); // settle over the target: sortable lists reorder on hover
    const tb = hit(b.x, b.y);
    mouse(captor() || tb, "pointermove", b.x, b.y, { buttons: 1 });
    mouse(captor() || tb, "pointerup", b.x, b.y);
    captor()?.removeAttribute("data-remobro-capture");
    mouse(tb, "mouseup", b.x, b.y);
    UI.press(false);
    UI.ripple(b.x, b.y);
    return `released at ${Math.round(b.x)},${Math.round(b.y)} over ${eid(tb)} ${nodeName(tb)}`;
  }
  async function html5Drag(srcEl, a, b) {
    // Firefox: build the events in the page's own world, or page code can't read dataTransfer
    const W = typeof cloneInto === "function" ? window.wrappedJSObject : null;
    const dt = W ? new W.DataTransfer() : new DataTransfer();
    const mk = (type, x, y) => {
      const init = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, screenX: x, screenY: y, buttons: 1, dataTransfer: dt };
      return W ? new W.DragEvent(type, cloneInto(init, window, { wrapReflectors: true })) : new DragEvent(type, init);
    };
    await UI.pointTo(a.x, a.y);
    await UI.press(true);
    mouse(srcEl, "pointerdown", a.x, a.y);
    mouse(srcEl, "mousedown", a.x, a.y);
    const start = mk("dragstart", a.x, a.y);
    srcEl.dispatchEvent(start);
    if (start.defaultPrevented) {
      UI.press(false);
      return "the page cancelled the drag (dragstart prevented)";
    }
    let over = null, accepted = false;
    const n = Math.max(8, Math.min(40, Math.round(Math.hypot(b.x - a.x, b.y - a.y) / 20)));
    for (let i = 1; i <= n; i++) {
      const k = ease(i / n);
      const x = a.x + (b.x - a.x) * k, y = a.y + (b.y - a.y) * k;
      const t = hit(x, y);
      srcEl.dispatchEvent(mk("drag", x, y));
      if (t !== over) {
        over?.dispatchEvent(mk("dragleave", x, y));
        t.dispatchEvent(mk("dragenter", x, y));
        over = t;
      }
      const ov = mk("dragover", x, y);
      t.dispatchEvent(ov);
      accepted = ov.defaultPrevented; // a drop target says "drop here" by preventing dragover
      UI.cursorAt(x, y);
      await sleep(16);
    }
    await sleep(80);
    let msg;
    if (accepted && over) {
      over.dispatchEvent(mk("drop", b.x, b.y));
      msg = `dropped on ${eid(over)} ${nodeName(over)}`;
    } else {
      over?.dispatchEvent(mk("dragleave", b.x, b.y));
      msg = `nothing accepted the drop at ${Math.round(b.x)},${Math.round(b.y)} (no dragover handler there)`;
    }
    srcEl.dispatchEvent(mk("dragend", b.x, b.y));
    mouse(over || srcEl, "mouseup", b.x, b.y);
    UI.press(false);
    UI.ripple(b.x, b.y);
    return msg + " (HTML5 drag and drop)";
  }

  async function pressEnter(el) {
    const notPrevented = key(el, "Enter");
    if (notPrevented && el.form && el.tagName === "INPUT") {
      await sleep(50);
      if (el.isConnected) el.form.requestSubmit?.();
    }
  }
  function moveFocus(from, dir) {
    const all = qsaDeep(INTERACTIVE).filter(isVisible);
    const i = all.indexOf(from);
    all[(i + dir + all.length) % all.length]?.focus();
  }

  // ---------------------------------------------------------------- overlay UI
  // Agent logos for the minimized bubble (Simple Icons, CC0; trademarks belong to their owners).
  // Agents without one show their initial.
  const LOGOS = {
    "openai": "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z",
    "claude": "m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z",
    "gemini": "M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81",
    "cursor": "M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23",
    "copilot": "M23.922 16.997C23.061 18.492 18.063 22.02 12 22.02 5.937 22.02.939 18.492.078 16.997A.641.641 0 0 1 0 16.741v-2.869a.883.883 0 0 1 .053-.22c.372-.935 1.347-2.292 2.605-2.656.167-.429.414-1.055.644-1.517a10.098 10.098 0 0 1-.052-1.086c0-1.331.282-2.499 1.132-3.368.397-.406.89-.717 1.474-.952C7.255 2.937 9.248 1.98 11.978 1.98c2.731 0 4.767.957 6.166 2.093.584.235 1.077.546 1.474.952.85.869 1.132 2.037 1.132 3.368 0 .368-.014.733-.052 1.086.23.462.477 1.088.644 1.517 1.258.364 2.233 1.721 2.605 2.656a.841.841 0 0 1 .053.22v2.869a.641.641 0 0 1-.078.256Zm-11.75-5.992h-.344a4.359 4.359 0 0 1-.355.508c-.77.947-1.918 1.492-3.508 1.492-1.725 0-2.989-.359-3.782-1.259a2.137 2.137 0 0 1-.085-.104L4 11.746v6.585c1.435.779 4.514 2.179 8 2.179 3.486 0 6.565-1.4 8-2.179v-6.585l-.098-.104s-.033.045-.085.104c-.793.9-2.057 1.259-3.782 1.259-1.59 0-2.738-.545-3.508-1.492a4.359 4.359 0 0 1-.355-.508Zm2.328 3.25c.549 0 1 .451 1 1v2c0 .549-.451 1-1 1-.549 0-1-.451-1-1v-2c0-.549.451-1 1-1Zm-5 0c.549 0 1 .451 1 1v2c0 .549-.451 1-1 1-.549 0-1-.451-1-1v-2c0-.549.451-1 1-1Zm3.313-6.185c.136 1.057.403 1.913.878 2.497.442.544 1.134.938 2.344.938 1.573 0 2.292-.337 2.657-.751.384-.435.558-1.15.558-2.361 0-1.14-.243-1.847-.705-2.319-.477-.488-1.319-.862-2.824-1.025-1.487-.161-2.192.138-2.533.529-.269.307-.437.808-.438 1.578v.021c0 .265.021.562.063.893Zm-1.626 0c.042-.331.063-.628.063-.894v-.02c-.001-.77-.169-1.271-.438-1.578-.341-.391-1.046-.69-2.533-.529-1.505.163-2.347.537-2.824 1.025-.462.472-.705 1.179-.705 2.319 0 1.211.175 1.926.558 2.361.365.414 1.084.751 2.657.751 1.21 0 1.902-.394 2.344-.938.475-.584.742-1.44.878-2.497Z"
  };
  const LOGO_ALIASES = { codex: "openai", chatgpt: "openai" };
  const logoFor = (agent) => {
    const a = String(agent).toLowerCase();
    const k = Object.keys(LOGOS).find((x) => a.includes(x)) || LOGO_ALIASES[Object.keys(LOGO_ALIASES).find((x) => a.includes(x))];
    return LOGOS[k];
  };
  const UI = (() => {
    let host, root, pill, logo, hand, label, stepEl, askBox, cursor, border, marksLayer, boundsLayer, state = { on: false };
    let cx = 0, cy = 0, kindNow = "arrow";
    const HOT = { arrow: [3.7, 1.8], hand: [9.5, 3.5], text: [11, 11] }; // hotspot per cursor shape
    const watching = () => state.on && !state.fast && !document.hidden;
    function place(x, y) {
      cx = x;
      cy = y;
      if (!cursor) return;
      const [hx, hy] = HOT[kindNow];
      cursor.style.transform = `translate(${x - hx}px, ${y - hy}px)`;
    }
    function shapeFor(el) {
      if (!el) return "arrow";
      if (el.isContentEditable || el.tagName === "TEXTAREA" || (el.tagName === "INPUT" && !/^(button|submit|reset|checkbox|radio|range|color|file|image)$/i.test(el.type))) return "text";
      const c = getComputedStyle(el).cursor;
      if (c === "pointer" || el.closest("a[href],button,[role=button],summary,label")) return "hand";
      if (c === "text") return "text";
      return "arrow";
    }
    function setShape(k) {
      kindNow = k;
      if (cursor) cursor.dataset.k = k;
    }
    // Human-like movement: curved path, minimum-jerk speed profile (fast start, slow
    // landing), Fitts-law duration, slight overshoot + correction on long moves, and a
    // mousemove trail so hover handlers along the way fire like they would for a person.
    async function glide(x, y, dur, bend) {
      const sx = cx, sy = cy, dx = x - sx, dy = y - sy, dist = Math.hypot(dx, dy) || 1;
      const mx = sx + dx / 2 - (dy / dist) * bend, my = sy + dy / 2 + (dx / dist) * bend;
      const t0 = performance.now();
      let n = 0;
      await new Promise((done) => {
        // rAF may never fire (minimized window, headless): never let the animation hang an action
        setTimeout(done, dur + 250);
        const frame = (now) => {
          const t = Math.min(1, (now - t0) / dur);
          const e = t * t * t * (10 - 15 * t + 6 * t * t);
          const u = 1 - e;
          const px = u * u * sx + 2 * u * e * mx + e * e * x;
          const py = u * u * sy + 2 * u * e * my + e * e * y;
          place(px, py);
          if (++n % 2 === 0 && t < 1) {
            const under = document.elementFromPoint(px, py);
            if (under) mouse(under, "mousemove", px, py);
          }
          if (t < 1) requestAnimationFrame(frame);
          else done();
        };
        requestAnimationFrame(frame);
      });
    }
    async function moveTo(x, y) {
      if (!watching() || !cursor) return place(x, y);
      const dist = Math.hypot(x - cx, y - cy);
      if (dist < 3) return place(x, y);
      const dur = Math.min(750, 170 + 105 * Math.log2(1 + dist / 14)) * (0.85 + Math.random() * 0.3);
      const bend = (Math.random() * 0.3 - 0.15) * Math.min(dist, 600);
      if (dist > 220) {
        const k = 1 + 0.025 + Math.random() * 0.03; // overshoot, then correct
        await glide(cx + (x - cx) * k, cy + (y - cy) * k, dur, bend);
        await sleep(25 + Math.random() * 40);
        await glide(x, y, 110 + Math.random() * 60, 0);
      } else await glide(x, y, dur, bend);
      try {
        sessionStorage.setItem("__zp_cursor", JSON.stringify([x, y]));
      } catch {}
    }
    const css = `
      :host{all:initial}
      /* soft glow around agent tabs */
      .border{position:fixed;inset:0;pointer-events:none;z-index:2147483646;
        box-shadow:inset 0 0 36px 4px color-mix(in srgb,var(--c) 42%,transparent);animation:breathe 3.2s ease-in-out infinite}
      .border.paused{animation:none;opacity:.6;box-shadow:inset 0 0 36px 4px rgba(140,140,150,.35)}
      @keyframes breathe{0%,100%{opacity:.3}50%{opacity:.8}}
      /* the island: top centre, frosted and tinted with the agent's colour. Click it to morph between
         a 38px circle (just the logo) and the full pill. 1px border + 5px padding + 26px circles, 10px gaps. */
      .pill{position:fixed;top:10px;left:50%;transform:translateX(-50%);z-index:2147483647;box-sizing:border-box;
        height:38px;min-width:38px;padding:5px;display:flex;align-items:center;gap:10px;overflow:hidden;
        max-width:min(640px,calc(100vw - 32px));font:13px/16px system-ui,sans-serif;color:rgba(255,255,255,.92);
        background:color-mix(in srgb,var(--c) 16%,rgba(26,26,32,.78));
        -webkit-backdrop-filter:blur(16px) saturate(150%);backdrop-filter:blur(16px) saturate(150%);
        border:1px solid color-mix(in srgb,var(--c) 38%,rgba(255,255,255,.08));border-radius:999px;
        box-shadow:0 8px 28px rgba(0,0,0,.22),inset 0 1px 0 rgba(255,255,255,.06);
        pointer-events:auto;cursor:pointer;user-select:none;
        transition:width .42s cubic-bezier(.32,.72,0,1),background-color .3s,border-color .3s}
      .pill.paused{background:rgba(40,40,46,.8);border-color:rgba(255,255,255,.14)}
      .logo{position:relative;width:26px;height:26px;border-radius:50%;flex:none;display:grid;place-items:center;
        background:color-mix(in srgb,var(--c) 78%,#fff 22%);color:rgba(20,20,24,.85);font:700 13px/1 system-ui,sans-serif;
        transition:background-color .3s}
      .logo svg{width:16px;height:16px}
      .logo svg path{fill:rgba(20,20,24,.82)}
      .logo::after{content:"";position:absolute;inset:-3px;border-radius:50%;
        border:1.5px solid color-mix(in srgb,var(--c) 55%,transparent);animation:ping 2.2s ease-out infinite}
      .paused .logo{background:#a3a3ab}
      .paused .logo::after{display:none}
      @keyframes ping{0%{opacity:.6;transform:scale(.92)}100%{opacity:0;transform:scale(1.4)}}
      .txt{display:flex;align-items:baseline;min-width:0;white-space:nowrap;transition:opacity .25s .12s}
      .lbl{font-weight:600}
      .step{opacity:.62;overflow:hidden;text-overflow:ellipsis;min-width:0}
      .step:not(:empty)::before{content:"·";margin:0 6px}
      @media (prefers-reduced-motion:reduce){.border{animation:none;opacity:.6}.logo::after{animation:none}}
      .hand{width:26px;height:26px;flex:none;border:0;border-radius:50%;padding:0;display:grid;place-items:center;
        color:rgba(255,255,255,.9);background:rgba(255,255,255,.1);cursor:pointer;transition:background-color .15s,opacity .25s .12s}
      .hand:hover{background:rgba(255,255,255,.2)}
      .hand svg{width:15px;height:15px}
      .hand:focus-visible{outline:2px solid color-mix(in srgb,var(--c) 70%,#fff);outline-offset:1px}
      .pill.min .txt,.pill.min .hand{opacity:0;transition-delay:0s;transition-duration:.12s;pointer-events:none}
      @media (prefers-reduced-motion:reduce){.pill,.txt,.hand{transition:none}}
      .cursor.away{display:none}
      .ask{position:fixed;top:56px;left:50%;transform:translateX(-50%);z-index:2147483647;
        font:14px/1.45 system-ui,sans-serif;color:#fff;background:rgba(22,22,26,.96);border:1px solid var(--c);
        border-radius:14px;padding:12px 14px;width:min(460px,90vw);box-shadow:0 10px 30px rgba(0,0,0,.4);pointer-events:auto}
      .ask p{margin:0 0 10px;white-space:pre-wrap}
      .ask input{width:100%;box-sizing:border-box;margin:0 0 10px;padding:6px 8px;border-radius:8px;border:1px solid #555;background:#111;color:#fff;font:inherit}
      .ask .row{display:flex;gap:8px;justify-content:flex-end}
      .ask .yes{background:var(--c);color:#111;font-weight:600}
      .cursor{position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;will-change:transform}
      .cursor svg{position:absolute;left:0;top:0;width:22px;height:22px;display:none;transform-origin:4px 2px;
        transition:transform .07s ease-out;filter:drop-shadow(0 1px 1.5px rgba(0,0,0,.45))}
      .cursor[data-k=arrow] .arrow,.cursor[data-k=hand] .hand,.cursor[data-k=text] .ibeam{display:block}
      .cursor.down svg{transform:scale(.84)}
      .cursor .tag{position:absolute;left:15px;top:19px;font:600 11px/1 system-ui,sans-serif;color:rgba(20,20,24,.85);background:color-mix(in srgb,var(--c) 78%,#fff 22%);
        padding:3px 6px;border-radius:3px 9px 9px 9px;white-space:nowrap;box-shadow:0 1px 3px rgba(0,0,0,.3)}
      .hl{position:fixed;z-index:2147483646;pointer-events:none;border:2px solid var(--c);border-radius:6px;
        background:color-mix(in srgb,var(--c) 14%,transparent);transition:opacity .4s}
      .hl span{position:absolute;top:-22px;left:-2px;background:var(--c);color:#111;font:600 11px/1 system-ui;padding:4px 6px;border-radius:5px;white-space:nowrap}
      .ripple{position:fixed;z-index:2147483647;pointer-events:none;width:12px;height:12px;margin:-6px 0 0 -6px;border-radius:50%;
        border:2px solid var(--c);animation:r .5s ease-out forwards}
      @keyframes r{to{transform:scale(4);opacity:0}}
      .mark{position:fixed;z-index:2147483647;pointer-events:none;font:700 11px/1 system-ui;color:#fff;background:#d4145a;
        padding:2px 3px;border-radius:3px;outline:1px solid #fff}
      .mbox{position:fixed;z-index:2147483646;pointer-events:none;outline:1.5px solid #d4145a}
      .bb{position:fixed;z-index:2147483646;pointer-events:none;box-sizing:border-box;border:1px solid rgba(37,99,235,.75)}
      .bm{position:fixed;z-index:2147483645;pointer-events:none;background:rgba(249,115,22,.22)}
      .bp{position:fixed;z-index:2147483645;pointer-events:none;background:rgba(34,197,94,.2)}
      .bl{position:fixed;z-index:2147483647;pointer-events:none;font:600 9px/1 system-ui,sans-serif;color:#fff;
        background:rgba(37,99,235,.92);padding:1px 3px;border-radius:2px}`;

    function ensure() {
      if (host?.isConnected) return;
      // drop overlays left behind by a previous version of the extension
      document.querySelectorAll("remobro-overlay").forEach((e) => e.remove());
      host = document.createElement("remobro-overlay");
      root = host.attachShadow({ mode: "closed" });
      root.innerHTML = `<style>${css}</style><div class="border"></div>
        <div class="pill"><span class="logo"></span><span class="txt"><span class="lbl"></span><span class="step"></span></span><button class="hand" data-a="pause"></button></div>
        <div class="cursor" data-k="arrow">
          <svg class="arrow" viewBox="0 0 24 24"><path d="M4 2 L4 20 L9 15 L13 23 L16 21.5 L12 13.8 L19 13.5 Z" fill="color-mix(in srgb,var(--c) 78%,#fff 22%)" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></svg>
          <svg class="hand" viewBox="0 0 24 24"><path d="M9 11.5V4.2a1.6 1.6 0 0 1 3.2 0V10h.4V8.4a1.6 1.6 0 0 1 3.2 0V10h.4V9.2a1.6 1.6 0 0 1 3.2 0v6.1c0 3.9-2.6 6.7-6.6 6.7-2.6 0-4.3-1.1-5.5-3.2L4 14.3a1.5 1.5 0 0 1 2.5-1.7L9 15.2z" fill="color-mix(in srgb,var(--c) 78%,#fff 22%)" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg>
          <svg class="ibeam" viewBox="0 0 24 24"><path d="M8 3.5h2.5L12 5l1.5-1.5H16M12 5v14M8 20.5h2.5L12 19l1.5 1.5H16" fill="none" stroke="#fff" stroke-width="3.4" stroke-linecap="round"/><path d="M8 3.5h2.5L12 5l1.5-1.5H16M12 5v14M8 20.5h2.5L12 19l1.5 1.5H16" fill="none" stroke="var(--c)" stroke-width="1.8" stroke-linecap="round"/></svg>
          <span class="tag"></span>
        </div>`;
      border = root.querySelector(".border");
      pill = root.querySelector(".pill");
      label = root.querySelector(".lbl");
      stepEl = root.querySelector(".step");
      cursor = root.querySelector(".cursor");
      logo = root.querySelector(".logo");
      hand = root.querySelector(".hand");
      // continue from where the cursor was on the previous page
      try {
        [cx, cy] = JSON.parse(sessionStorage.getItem("__zp_cursor") || "null") || [innerWidth * 0.62, innerHeight * 0.3];
      } catch {
        [cx, cy] = [innerWidth * 0.62, innerHeight * 0.3];
      }
      place(cx, cy);
      root.addEventListener("click", (e) => {
        const a = e.target.closest?.("[data-a]")?.dataset.a;
        if (a) B.runtime.sendMessage({ ui: a }); // ✋ / ▶
        else if (e.target.closest?.(".pill")) B.runtime.sendMessage({ ui: "min" }); // the island itself: expand/collapse
      });
      // Alt+hover outlines an element, Alt+click points it out to the agent (inspect("picked"))
      addEventListener("mouseover", (e) => {
        const t = e.composedPath?.()[0];
        if (e.altKey && state.on && t?.nodeType === 1 && !host.contains(t)) inspectBoxFn(t, `${eid(t)} ${nodeName(t)}`);
      }, true);
      addEventListener("click", (e) => {
        const t = e.composedPath?.()[0];
        if (!e.altKey || !state.on || t?.nodeType !== 1 || host.contains(t)) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        ZP.picked = new WeakRef(t);
        inspectBoxFn(t, `${eid(t)} ${nodeName(t)}`);
        state.step = `you pointed at ${eid(t)} ${nodeName(t)}: tell ${state.agent || "the agent"} what's wrong`;
        render();
      }, true);
      document.documentElement.appendChild(host);
    }
    let ibTimer = null;
    function inspectBoxFn(el, text) {
      if (!state.on) return;
      ensure();
      root.querySelector(".inspect")?.remove();
      const r = el.getBoundingClientRect();
      const b = document.createElement("div");
      b.className = "hl inspect";
      Object.assign(b.style, { left: r.left - 2 + "px", top: r.top - 2 + "px", width: r.width + "px", height: r.height + "px", borderColor: "#f5a623", background: "transparent" });
      b.innerHTML = "<span></span>";
      b.firstChild.textContent = text;
      b.firstChild.style.background = "#f5a623";
      root.appendChild(b);
      clearTimeout(ibTimer);
      ibTimer = setTimeout(() => b.remove(), 6000);
    }
    // Island morph: animate between the 38px circle and the pill's natural width, then hand
    // the width back to "auto" so step text can change freely while expanded.
    let morphEnd = null;
    function morph(min, animate) {
      pill.removeEventListener("transitionend", morphEnd);
      if (!animate) {
        pill.style.width = min ? "38px" : "";
        return;
      }
      const from = pill.getBoundingClientRect().width;
      pill.style.transition = "none";
      pill.style.width = min ? "38px" : "auto";
      const to = min ? 38 : pill.getBoundingClientRect().width;
      pill.style.width = from + "px";
      pill.getBoundingClientRect(); // commit the start width
      pill.style.transition = "";
      pill.style.width = to + "px";
      if (!min) {
        morphEnd = (e) => {
          if (e.propertyName === "width") pill.style.width = "";
        };
        pill.addEventListener("transitionend", morphEnd);
      }
    }
    function render() {
      if (!state.on) {
        host?.remove();
        return;
      }
      ensure();
      host.style.setProperty("--c", state.color || "#f76f53");
      root.host.style.setProperty("--c", state.color || "#f76f53");
      root.querySelector("style").textContent = css.replace(/var\(--c\)/g, state.color || "#f76f53");
      border.className = "border" + (state.paused ? " paused" : "");
      const wasMin = pill.classList.contains("min");
      pill.className = "pill" + (state.paused ? " paused" : "") + (state.min ? " min" : "");
      morph(!!state.min, wasMin !== !!state.min && pill.dataset.ready === "1");
      pill.dataset.ready = "1";
      const who = state.agent || "AI";
      label.textContent = state.paused ? `${who} paused` : `${who} is driving`;
      const face = `${who}|${!!state.paused}`;
      if (logo.dataset.face !== face) {
        // rebuilt only when the agent or pause state changes, not on every step
        logo.dataset.face = face;
        if (logoFor(who)) logo.innerHTML = `<svg viewBox="0 0 24 24"><path fill="#141414" d="${logoFor(who)}"/></svg>`;
        else logo.textContent = who[0].toUpperCase();
        hand.innerHTML = state.paused
          ? `<svg viewBox="0 0 24 24"><path fill="currentColor" d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/></svg>`
          : `<svg viewBox="0 0 24 24"><path fill="currentColor" d="M18 6.5a1.5 1.5 0 0 0-3 0V11h-.5V4a1.5 1.5 0 0 0-3 0v7H11V5a1.5 1.5 0 0 0-3 0v8.6l-1.7-2.2a1.6 1.6 0 0 0-2.5 2l3.4 4.6C8.6 20.4 10.6 22 13.4 22h.6c3.3 0 6-2.7 6-6V9a1.5 1.5 0 0 0-3 0v2H17V6.5z"/></svg>`;
        hand.title = state.paused ? `Resume: give the wheel back to ${who}` : `Pause: take the wheel from ${who}`;
      }
      pill.title = `${state.min ? "Click to expand" : "Click to collapse"} · Alt+click an element to point it out to ${who}`;
      cursor.classList.toggle("away", !!state.paused); // your turn: hide the agent's cursor
      root.querySelector(".tag").textContent = state.agent || "AI";
      stepEl.textContent = state.paused ? "your turn" : state.step || state.goal || "";
    }
    return {
      set(s) {
        Object.assign(state, s);
        render();
      },
      step(text) {
        if (!state.on) return;
        state.step = text;
        render();
      },
      watching,
      async press(down) {
        if (!cursor) return;
        cursor.classList.toggle("down", down);
      },
      async pointTo(x, y, r, el) {
        if (!state.on) return;
        ensure();
        await moveTo(x, y);
        setShape(shapeFor(el || document.elementFromPoint(x, y)));
        place(x, y);
        if (r && watching()) {
          const hl = document.createElement("div");
          hl.className = "hl";
          Object.assign(hl.style, { left: r.left - 3 + "px", top: r.top - 3 + "px", width: r.width + 2 + "px", height: r.height + 2 + "px" });
          if (state.step) hl.innerHTML = `<span></span>`, (hl.firstChild.textContent = state.step);
          root.appendChild(hl);
          setTimeout(() => (hl.style.opacity = "0"), 700);
          setTimeout(() => hl.remove(), 1200);
        }
        if (watching()) await sleep(60 + Math.random() * 70); // aim before clicking
      },
      // persistent outline on the element the agent is inspecting (like a layout inspector)
      inspectBox(el, text) {
        inspectBoxFn(el, text);
      },
      cursorAt(x, y) {
        if (state.on) place(x, y);
      },
      ripple(x, y) {
        if (!state.on) return;
        const d = document.createElement("div");
        d.className = "ripple";
        Object.assign(d.style, { left: x + "px", top: y + "px" });
        root.appendChild(d);
        setTimeout(() => d.remove(), 600);
      },
      ask({ question, kind, askId }) {
        ensure();
        askBox?.remove();
        askBox = document.createElement("div");
        askBox.className = "ask";
        const buttons = kind === "confirm" ? `<button data-v="no">Deny</button><button class="yes" data-v="yes">Approve</button>`
          : kind === "text" ? `<button class="yes" data-v="__text">Send</button>`
          : `<button class="yes" data-v="done">Done</button>`;
        askBox.innerHTML = `<p></p>${kind === "text" ? "<input>" : ""}<div class="row">${buttons}</div>`;
        askBox.querySelector("p").textContent = `${state.agent || "AI"} asks: ${question}`;
        askBox.addEventListener("click", (e) => {
          let v = e.target.dataset?.v;
          if (!v) return;
          if (v === "__text") v = askBox.querySelector("input").value;
          B.runtime.sendMessage({ ui: "answer", askId, answer: v });
          askBox.remove();
          askBox = null;
        });
        root.appendChild(askBox);
        askBox.querySelector("input")?.focus();
      },
      closeAsk() {
        askBox?.remove();
        askBox = null;
      },
      bounds(items) {
        boundsLayer?.remove();
        boundsLayer = null;
        if (!items) return;
        ensure();
        boundsLayer = document.createElement("div");
        const add = (cls, x, y, w, h) => {
          if (w <= 0 || h <= 0) return;
          const d = document.createElement("div");
          d.className = cls;
          Object.assign(d.style, { left: x + "px", top: y + "px", width: w + "px", height: h + "px" });
          boundsLayer.appendChild(d);
        };
        const taken = []; // label positions, so labels never overlap
        for (const { id, r, m, p } of items) {
          // margin (outside the border box) and padding (inside it) as bands, like DevTools
          add("bm", r.left, r.top - m[0], r.width, m[0]);
          add("bm", r.left, r.bottom, r.width, m[2]);
          add("bm", r.left - m[3], r.top - m[0], m[3], r.height + m[0] + m[2]);
          add("bm", r.right, r.top - m[0], m[1], r.height + m[0] + m[2]);
          add("bp", r.left, r.top, r.width, p[0]);
          add("bp", r.left, r.bottom - p[2], r.width, p[2]);
          add("bp", r.left, r.top + p[0], p[3], r.height - p[0] - p[2]);
          add("bp", r.right - p[1], r.top + p[0], p[1], r.height - p[0] - p[2]);
          add("bb", r.left, r.top, r.width, r.height);
          // labels in the top-right corner, where text rarely starts
          const lw = 6 + 5.5 * String(id).length;
          const lx = Math.max(0, Math.min(innerWidth, r.right) - lw), ly = Math.max(0, r.top);
          if (r.width >= 14 && r.height >= 10 && !taken.some(([x, y]) => Math.abs(x - lx) < 26 && Math.abs(y - ly) < 12)) {
            taken.push([lx, ly]);
            const l = document.createElement("div");
            l.className = "bl";
            l.textContent = id;
            Object.assign(l.style, { left: lx + "px", top: ly + "px" });
            boundsLayer.appendChild(l);
          }
        }
        root.appendChild(boundsLayer);
      },
      marks(items) {
        marksLayer?.remove();
        marksLayer = null;
        if (!items) return;
        ensure();
        marksLayer = document.createElement("div");
        for (const [id, r] of items) {
          const b = document.createElement("div");
          b.className = "mbox";
          Object.assign(b.style, { left: r.left + "px", top: r.top + "px", width: r.width + "px", height: r.height + "px" });
          const m = document.createElement("div");
          m.className = "mark";
          m.textContent = id;
          Object.assign(m.style, { left: Math.max(0, r.left - 2) + "px", top: Math.max(0, r.top - 14) + "px" });
          marksLayer.append(b, m);
        }
        root.appendChild(marksLayer);
      },
      async hideChrome(h) {
        // hide pill/cursor/border during screenshots so they don't cover the page (marks stay)
        if (!root) return;
        let st = root.querySelector("style.hide");
        if (h && !st) {
          st = document.createElement("style");
          st.className = "hide";
          // Chromium renders background tabs only while something animates; with the island
          // hidden, a capture would wait forever for a frame. This 1px tick (opacity 0.2%,
          // below one colour step) keeps frames coming without showing in the screenshot.
          st.textContent = ".border,.pill,.cursor,.hl,.ask,.ripple{display:none!important}" +
            ".tick{position:fixed;left:0;top:0;width:1px;height:1px;background:#000;opacity:.002;animation:tick .4s linear infinite;pointer-events:none}" +
            "@keyframes tick{to{opacity:.003}}";
          const tick = document.createElement("div");
          tick.className = "tick";
          root.appendChild(tick);
          root.appendChild(st);
        } else if (!h) {
          st?.remove();
          root.querySelectorAll(".tick").forEach((t) => t.remove());
        }
        // wait until the change is painted (rAF is paused in background tabs: cap the wait)
        const painted = new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        await Promise.race([painted, sleep(150)]);
      },
    };
  })();
  ZP.ui = UI;

  // ---------------------------------------------------------------- messaging
  // Replies are {v} or {err}: Chromium listeners can't return a promise, so answer through
  // sendResponse (Firefox supports that too) and carry errors as data.
  B.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg?.cmd) return;
    handle(msg).then(
      (v) => sendResponse({ v: v ?? null }),
      (e) => sendResponse({ err: String(e?.message || e) }),
    );
    return true; // answering asynchronously
  });
  async function handle({ cmd, args = {} }) {
    switch (cmd) {
      case "ping": return "pong";
      case "status": return ZP.status();
      case "outline": return ZP.outline(args);
      case "elements": return ZP.elements(args);
      case "find": return ZP.find(args);
      case "read": return ZP.read(args);
      case "rect": return args.target ? ZP.rectOf(args) : ZP.viewportRect(args.full);
      case "marks": ZP.marks(args.on); return true;
      case "bounds": return ZP.bounds(args);
      case "inspect": return ZP.inspect(args);
      case "fxBegin": ZP.fxBegin(); return true;
      case "fxEnd": return ZP.fxEnd();
      case "act": return ZP.act(args.step, { last: args.last });
      case "ui": UI.set(args); return true;
      case "uiHide": await UI.hideChrome(args.hide); return true;
      case "errors": return ZP.errors(args);
      case "ask": UI.ask(args); return true;
      case "closeAsk": UI.closeAsk(); return true;
      case "scrollY": return { y: scrollY, dpr: devicePixelRatio, w: innerWidth, h: innerHeight };
    }
  }
})();
