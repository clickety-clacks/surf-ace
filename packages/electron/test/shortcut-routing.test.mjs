import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import { transformSync } from 'esbuild';

// Execute the production wiring and handler without importing Electron's startup.
const source = readFileSync(process.env.SURF_ACE_SHORTCUT_SOURCE ?? new URL('../src/main.ts', import.meta.url), 'utf8');
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end));
const code = transformSync(section('function keyboardDirectionForVimKey', 'function focusNextWindow') +
  section('function handleShortcutInput', 'function wireWindowDiagnostics'), { loader: 'ts' }).code;
function fixture({ native = false } = {}) {
  const annotations = [], sends = [], activations = [], navigation = [], history = [];
  const panes = [{ paneId: 1, content: { contentType: 'markdown' } },
    { paneId: 2, externalNative: native, content: { contentType: native ? 'terminal' : 'browser_url' } }];
  let active = native ? 2 : 1;
  const contents = id => ({ id, handlers: new Map(),
    on(name, listener) { this.handlers.set(name, listener); },
    once(name, listener) { this.handlers.set(name, listener); },
    send(...args) { sends.push(args); } });
  const window = { webContents: contents(1) }, guest = contents(2);
  const bindings = new Map([[2, { surfaceId: 'sf', paneId: 2 }]]);
  const context = vm.createContext({ process, console,
    core: { setActiveKeyboardPane(_s, id) { active = id; activations.push(id); },
      activeKeyboardPaneId() { return active; }, navigateActiveKeyboardPane(...args) { navigation.push(args); } },
    rendererWindowState: () => ({ panes }), browserUrlWebContentsPanes: bindings,
    annotationSourceCoordinator: { setAnnotating(...args) { annotations.push(args); return Promise.resolve(); } },
    navigateHistoryAfterNativeRelease(...args) { history.push(args); return Promise.resolve(); },
    wireEditableContextMenu() {}, clientWarn() {}, errorDiagnosticFields: x => x, focusNextWindow() {},
  });
  vm.runInContext(code, context);
  context.wireWindowShortcuts('sf', window);
  context.wireWindowInputMenus('sf', window);
  window.webContents.handlers.get('did-attach-webview')({}, guest);
  function key(target, key, modifiers = {}) {
    let prevented = 0;
    target.handlers.get('before-input-event')({ preventDefault() { prevented++; } },
      { type: 'keyDown', key, meta: false, control: false, alt: false, shift: false, ...modifiers });
    return prevented;
  }
  return { window, guest, bindings, annotations, sends, activations, navigation, history, key };
}
test('focused guest owns ordinary typing, modifiers, arrows and page keys', () => {
  const f = fixture();
  for (const [key, modifiers] of [['a'], ['d'], ['A', { shift: true }], ['a', { control: true }],
    ['d', { alt: true }], ['ArrowLeft'], ['ArrowRight'], ['ArrowUp'], ['ArrowDown'], ['PageUp'], ['PageDown']]) {
    assert.equal(f.key(f.guest, key, modifiers), 0, key);
  }
  assert.deepEqual(f.annotations, []);
  assert.deepEqual(f.sends, []);
  assert.ok(f.activations.every(id => id === 2));
});
test('unbound and destroyed guest cannot fall back to another pane', () => {
  const f = fixture();
  f.bindings.clear();
  f.key(f.guest, 'a'); f.key(f.guest, '=', { meta: true });
  assert.deepEqual(f.annotations, []); assert.deepEqual(f.sends, []); assert.deepEqual(f.activations, []);
  f.bindings.set(2, { surfaceId: 'other', paneId: 2 });
  f.key(f.guest, 'ArrowDown');
  assert.deepEqual(f.sends, []);
  f.bindings.set(2, { surfaceId: 'sf', paneId: 999 });
  f.key(f.guest, 'a');
  assert.deepEqual(f.activations, []);
  f.guest.handlers.get('destroyed')();
  assert.equal(f.bindings.size, 0);
});
test('explicit guest command shortcuts keep owning pane identity', () => {
  const f = fixture();
  assert.equal(f.key(f.guest, '=', { meta: true }), 1);
  assert.equal(f.sends[0][1].paneId, 2);
  assert.equal(f.key(f.guest, 'h', { meta: true, alt: true, shift: true, code: 'KeyH' }), 1);
  assert.equal(f.navigation.length, 1);
  f.key(f.guest, '[', { meta: true }); assert.equal(f.history[0][1], 2);
});
test('chrome retains deliberate annotation and scrolling shortcuts', () => {
  const f = fixture();
  f.key(f.window.webContents, 'a'); f.key(f.window.webContents, 'd');
  assert.deepEqual(f.annotations.map(args => args[2]), [true, false]);
  assert.equal(f.key(f.window.webContents, 'ArrowDown'), 1);
});
test('native terminal owns ordinary keys delivered through the host', () => {
  const f = fixture({ native: true });
  assert.equal(f.key(f.window.webContents, 'ArrowUp'), 0);
  f.key(f.window.webContents, 'a');
  assert.deepEqual(f.annotations, []); assert.deepEqual(f.sends, []);
});
