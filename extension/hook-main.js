// Chromium only: runs in the page's own JS world (scripting world "MAIN") to see
// console.error, uncaught errors, failed resource loads and unhandled rejections.
// Reports each one to hook.js (extension world) as a DOM event.
(() => {
  if (window.__remobroHooked) return;
  Object.defineProperty(window, "__remobroHooked", { value: true });
  // remobro's synthetic pointer (content.js SYNTH_POINTER) isn't a real active pointer:
  // let pointer capture calls for it pass instead of throwing "Invalid pointer id".
  for (const m of ["setPointerCapture", "releasePointerCapture"]) {
    const orig = Element.prototype[m];
    Element.prototype[m] = function (id) {
      if (id === 7331) return;
      return orig.call(this, id);
    };
  }
  const emit = (s) => document.dispatchEvent(new CustomEvent("__remobro_err", { detail: String(s) }));
  const str = (x) => {
    try {
      if (x && typeof x === "object") return x.message || JSON.stringify(x).slice(0, 200);
      return String(x);
    } catch {
      return "[object]";
    }
  };
  const orig = console.error;
  console.error = function (...a) {
    try {
      emit("console.error: " + a.map(str).join(" "));
    } catch {}
    return orig.apply(this, a);
  };
  window.addEventListener(
    "error",
    (e) => {
      if (e.message) emit(`uncaught ${e.message} (${(e.filename || "").split("/").pop()}:${e.lineno})`);
      else if (e.target && e.target !== window && e.target.tagName)
        emit(`failed to load <${e.target.tagName.toLowerCase()}> ${(e.target.src || e.target.href || "").slice(0, 120)}`);
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
    emit("unhandled rejection: " + r);
  });
})();
