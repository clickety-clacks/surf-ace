/** Uses ttyd's exposed public xterm/fit interface when it owns the one live terminal. */
export function browserContentScaleScript(scale: number): string {
  if (!Number.isFinite(scale) || scale <= 0 || scale > 4) throw new Error("Invalid guest content scale");
  return `(() => {
    const scale = ${JSON.stringify(scale)};
    const root = document.documentElement;
    const terminal = window.term;
    const ownsTerminal = terminal && typeof terminal === 'object' &&
      terminal.element instanceof HTMLElement && terminal.element.ownerDocument === document &&
      terminal.element.isConnected && terminal.element.matches('.xterm') &&
      document.querySelectorAll('.xterm').length === 1 && terminal.element.querySelector('.xterm-screen') &&
      typeof terminal.fit === 'function' && terminal.options &&
      Number.isFinite(terminal.options.fontSize) && terminal.options.fontSize > 0;
    if (ownsTerminal) {
      const key = Symbol.for('surf-ace.public-terminal-font-scale.v1');
      if (window[key] === undefined) Object.defineProperty(window, key, { value: new WeakMap() });
      const states = window[key];
      if (!(states instanceof WeakMap)) throw new Error('Terminal scale state unavailable');
      let state = states.get(terminal);
      if (!state) { state = { baseFontSize: terminal.options.fontSize, revision: 0 }; states.set(terminal, state); }
      const revision = ++state.revision;
      const fontSize = state.baseFontSize * scale;
      if (!Number.isFinite(fontSize) || fontSize <= 0) throw new Error('Invalid terminal font size');
      const previousFontSize = terminal.options.fontSize;
      const previousZoom = root.style.zoom;
      try {
        terminal.options.fontSize = fontSize;
        root.style.zoom = '';
        terminal.fit();
      } catch (error) {
        ++state.revision;
        root.style.zoom = previousZoom;
        terminal.options.fontSize = previousFontSize;
        try { terminal.fit(); } catch (recoveryError) { console.warn('Terminal refit recovery failed', recoveryError); }
        throw error;
      }
      document.body?.style.setProperty('--surf-ace-content-scale', String(scale));
      requestAnimationFrame(() => {
        if (window.term === terminal && terminal.element.isConnected && state.revision === revision &&
            terminal.options.fontSize === fontSize) {
          try { terminal.fit(); } catch (error) { console.warn('Deferred terminal refit failed', error); }
        }
      });
      window.dispatchEvent(new Event('resize'));
      return { mode: 'public-terminal-font', fontSize };
    }
    root.style.zoom = scale === 1 ? '' : String(scale);
    document.body?.style.setProperty('--surf-ace-content-scale', String(scale));
    window.dispatchEvent(new Event('resize'));
    return { mode: 'document-zoom', scale };
  })()`;
}
