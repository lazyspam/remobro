// Runs in the page's own JS world (scripting world "MAIN"), on agent tabs only, as early
// as possible. remobro's input is synthetic wherever the browser can't make real input
// (Firefox/Zen always; Chromium when DevTools input is unavailable), and synthetic events
// carry event.isTrusted === false. Some pages ignore those on purpose: chess boards
// (chessground), canvas editors, games, anti-bot widgets. Here every listener the page
// registers sees untrusted input events as trusted. Real user events pass through
// untouched; other event types are never wrapped.
//
// Limits: only the page's own code is fooled. The browser still knows the event is
// synthetic, so its defaults (native drag and drop, text selection, popups, fullscreen,
// clipboard) won't run, and listeners registered before this script ran aren't wrapped.
(() => {
  if (window.__remobroTrust) return;
  Object.defineProperty(window, "__remobroTrust", { value: true });

  const INPUT = /^(pointer|mouse|click$|dblclick$|auxclick$|contextmenu$|touch|wheel$|drag|drop$|key)/;
  const bound = new WeakMap(); // native method -> bound copy (keeps === stable per event)
  const trusted = (e) =>
    new Proxy(e, {
      get(t, p) {
        if (p === "isTrusted") return true;
        const v = Reflect.get(t, p, t); // getters must run on the real event, not the proxy
        if (typeof v !== "function") return v;
        let m = bound.get(v);
        if (!m || m.t !== t) bound.set(v, (m = { t, f: v.bind(t) }));
        return m.f;
      },
    });

  const wraps = new WeakMap(); // page listener -> our wrapper
  function wrap(l) {
    let w = wraps.get(l);
    if (!w) {
      w = function (e) {
        const ev = e && e.isTrusted === false && INPUT.test(e.type) ? trusted(e) : e;
        return typeof l === "function" ? l.call(this, ev) : l.handleEvent(ev);
      };
      wraps.set(l, w);
    }
    return w;
  }

  const P = EventTarget.prototype;
  const add = P.addEventListener, rem = P.removeEventListener;
  const listener = (l) => l && (typeof l === "function" || typeof l === "object");
  P.addEventListener = function addEventListener(type, l, opts) {
    return add.call(this, type, listener(l) && INPUT.test(type) ? wrap(l) : l, opts);
  };
  P.removeEventListener = function removeEventListener(type, l, opts) {
    // the page may have added it before we wrapped addEventListener: remove both forms
    rem.call(this, type, l, opts);
    const w = listener(l) && wraps.get(l);
    if (w) rem.call(this, type, w, opts);
  };
})();
