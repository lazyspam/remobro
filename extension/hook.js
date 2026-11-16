// Error capture for agent tabs, injected as early as possible (document_start).
// Records console.error, uncaught errors, failed resource loads and unhandled rejections
// into window.__zpErrors (shared with content.js, same content-script world).
(() => {
  if (window.__zpErrors) return;
  const errs = (window.__zpErrors = []);
  const push = (s) => {
    if (errs.length < 300) errs.push({ t: Date.now(), s: String(s).replace(/\s+/g, " ").slice(0, 240) });
  };

  // Chromium: hook-main.js runs in the page's own world and reports here via DOM events.
  if (typeof exportFunction !== "function") {
    document.addEventListener("__remobro_err", (e) => push(e.detail));
    return;
  }

  // Firefox: remobro's synthetic pointer (content.js SYNTH_POINTER) isn't a real active
  // pointer; let the page's pointer capture calls for it pass instead of throwing.
  try {
    const proto = window.wrappedJSObject.Element.prototype;
    for (const m of ["setPointerCapture", "releasePointerCapture"]) {
      const orig = proto[m];
      exportFunction(
        function (id) {
          if (id === 7331) return;
          return orig.call(this, id);
        },
        proto,
        { defineAs: m },
      );
    }
  } catch {}

  // Firefox: wrap the page's console.error from here, through the X-ray wrapper.
  const str = (x) => {
    try {
      if (x && typeof x === "object") return x.message || JSON.stringify(x).slice(0, 200);
      return String(x);
    } catch {
      return "[object]";
    }
  };
  try {
    const c = window.wrappedJSObject.console;
    const orig = c.error;
    exportFunction(
      function (...a) {
        try {
          push("console.error: " + a.map(str).join(" "));
        } catch {}
        // spread, not apply(this, a): the page can't read an array from the extension's
        // world, which made every console.error throw inside the page
        return orig.call(this, ...a);
      },
      c,
      { defineAs: "error" },
    );
  } catch {}
  window.addEventListener(
    "error",
    (e) => {
      if (e.message) push(`uncaught ${e.message} (${(e.filename || "").split("/").pop()}:${e.lineno})`);
      else if (e.target && e.target !== window && e.target.tagName)
        push(`failed to load <${e.target.tagName.toLowerCase()}> ${(e.target.src || e.target.href || "").slice(0, 120)}`);
    },
    true,
  );
  window.addEventListener("unhandledrejection", (e) => {
    let r;
    try {
      r = e.reason?.message || String(e.reason);
    } catch {
      r = "?";
    }
    push("unhandled rejection: " + r);
  });
})();
