/** Uses ttyd's public terminal interface, preserving independently changed font preferences. */
export function browserContentScaleScript(scale: number): string {
  if (!Number.isFinite(scale) || scale <= 0 || scale > 4) throw new Error("Invalid guest content scale");
  return `(() => {
    const key = Symbol.for('surf-ace.public-terminal-font-scale.v2');
    if (window[key] === undefined) Object.defineProperty(window, key, { value: {
      scale: 1, revision: 0, active: null, states: new WeakMap(), timer: null
    }});
    const c = window[key];
    if (!c || !(c.states instanceof WeakMap)) throw new Error('Terminal scale state unavailable');
    c.scale = ${JSON.stringify(scale)};
    ++c.revision;
    if (c.timer !== null) { clearTimeout(c.timer); c.timer = null; }
    const root = document.documentElement;
    const compatible = (t) => t && typeof t === 'object' &&
      t.element instanceof HTMLElement && t.element.ownerDocument === document &&
      t.element.isConnected && t.element.matches('.xterm') &&
      document.querySelectorAll('.xterm').length === 1 && t.element.querySelector('.xterm-screen') &&
      typeof t.fit === 'function' && typeof t.onRender === 'function' && t.options &&
      Number.isFinite(t.options.fontSize) && t.options.fontSize > 0;
    const retire = () => {
      const a = c.active;
      c.active = null;
      if (!a) return;
      ++a.revision;
      a.subscription?.dispose(); a.subscription = null;
      // Restore only the value we still own; page preferences have priority.
      if (a.terminal.options === a.options && a.options.fontSize === a.applied) {
        a.options.fontSize = a.base;
      }
      a.applied = null;
    };
    const reconcile = () => {
      const t = window.term;
      if (!compatible(t)) {
        retire();
        root.style.zoom = c.scale === 1 ? '' : String(c.scale);
        return { mode: 'document-zoom', scale: c.scale };
      }
      if (c.active && (c.active.terminal !== t || c.active.options !== t.options || c.active.fit !== t.fit)) retire();
      let a = c.states.get(t);
      if (!a || a.options !== t.options || a.fit !== t.fit) {
        a = { terminal: t, options: t.options, fit: t.fit, base: t.options.fontSize,
          applied: null, revision: 0, subscription: null, writing: false };
        c.states.set(t, a);
      }
      c.active = a;
      if (a.writing) return { mode: 'public-terminal-font', fontSize: a.applied };
      const previousApplied = a.options.fontSize === a.applied ? a.applied : null;
      if (previousApplied === null) a.base = a.options.fontSize;
      const fontSize = a.base * c.scale;
      if (!Number.isFinite(fontSize) || fontSize <= 0) throw new Error('Invalid terminal font size');
      const previousFont = a.options.fontSize, previousZoom = root.style.zoom;
      const revision = ++a.revision;
      a.writing = true;
      try {
        a.applied = fontSize;
        a.options.fontSize = fontSize;
        root.style.zoom = '';
        a.fit.call(t);
      } catch (error) {
        ++a.revision;
        // A restored font may still belong to the previous successful scale.
        // Keep that ownership so render/reset/fallback cannot recapture it as a page baseline.
        a.applied = previousApplied;
        root.style.zoom = previousZoom;
        a.options.fontSize = previousFont;
        try { a.fit.call(t); } catch (recoveryError) { console.warn('Terminal refit recovery failed', recoveryError); }
        throw error;
      } finally { a.writing = false; }
      if (!a.subscription && typeof t.onRender === 'function') {
        a.subscription = t.onRender(() => {
          if (c.active !== a || a.writing) return;
          if (!compatible(t) || window.term !== t || t.options !== a.options || t.fit !== a.fit ||
              a.options.fontSize !== a.applied) {
            try { reconcile(); } catch (error) { console.warn('Terminal preference reconciliation failed', error); }
          }
        });
      }
      requestAnimationFrame(() => {
        if (c.active !== a || a.revision !== revision) return;
        if (!compatible(t) || window.term !== t || t.options !== a.options || t.fit !== a.fit ||
            a.options.fontSize !== a.applied) {
          try { reconcile(); } catch (error) { console.warn('Terminal ownership reconciliation failed', error); }
          return;
        }
        try { a.fit.call(t); } catch (error) { console.warn('Deferred terminal refit failed', error); }
      });
      return { mode: 'public-terminal-font', fontSize };
    };
    const result = reconcile();
    // A bounded current-document readiness window covers ttyd's asynchronous initialization.
    // After expiry an unsupported page retains document zoom until the next host scale request.
    if (result.mode === 'document-zoom') {
      const revision = c.revision;
      let remaining = 40;
      const poll = () => {
        c.timer = null;
        if (c.revision !== revision) return;
        try {
          if (reconcile().mode === 'public-terminal-font') return;
        } catch (error) { console.warn('Terminal readiness reconciliation failed', error); return; }
        if (--remaining > 0) c.timer = setTimeout(poll, 50);
      };
      c.timer = setTimeout(poll, 50);
    }
    document.body?.style.setProperty('--surf-ace-content-scale', String(c.scale));
    window.dispatchEvent(new Event('resize'));
    return result;
  })()`;
}
