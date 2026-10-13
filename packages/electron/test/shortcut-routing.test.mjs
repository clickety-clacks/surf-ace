import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import { transformSync } from 'esbuild';
import { parseAnnotationDoneContext } from '../src/annotation-done-context.ts';

// Execute the production wiring and handler without importing Electron's startup.
const source = readFileSync(process.env.SURF_ACE_SHORTCUT_SOURCE ?? new URL('../src/main.ts', import.meta.url), 'utf8');
const section = (start, end) => {
  const from = source.indexOf(start), to = source.indexOf(end);
  assert.ok(from >= 0 && to > from, `production section ${start}`);
  return source.slice(from, to);
};
// The extracted attachment wiring now reads this production default-off gate.
// Include its actual declaration instead of silently inventing a fixture value.
const diagnosticGate = source.match(/^const panePaintDiagnosticEnabled = (true|false);$/m)?.[0];
assert.equal(diagnosticGate, 'const panePaintDiagnosticEnabled = false;', 'diagnostic remains default-off');
const code = transformSync(diagnosticGate + '\n' + section('function keyboardDirectionForVimKey', 'function focusNextWindow') +
  section('function handleShortcutInput', 'function wireWindowDiagnostics'), { loader: 'ts' }).code;
function fixture({ native = false } = {}) {
  const annotations = [], sends = [], activations = [], navigation = [], history = [];
  const panes = [{ paneId: 1, paneLineageId: 'lineage-1', content: { contentType: 'markdown', contentId:'content-1', revision:1, renderVersion:1 } },
    { paneId: 2, externalNative: native, content: { contentType: native ? 'terminal' : 'browser_url' } }];
  let active = native ? 2 : 1;
  let doneBusy = false;
  const contents = id => ({ id, handlers: new Map(),
    on(name, listener) { this.handlers.set(name, listener); },
    once(name, listener) { this.handlers.set(name, listener); },
    send(...args) { sends.push(args); } });
  const window = { webContents: contents(1) }, guest = contents(2);
  const bindings = new Map([[2, { surfaceId: 'sf', paneId: 2 }]]);
  let diagnosticOwnerReads = 0;
  const context = vm.createContext({ process, console, parseAnnotationDoneContext,
    annotationDoneFence: { isBusy() { return doneBusy; } },
    get paintNativeOwners() { diagnosticOwnerReads++; throw Error('disabled diagnostic owner accessed'); },
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
  return { window, guest, bindings, annotations, sends, activations, navigation, history, key,
    setDoneBusy(value) { doneBusy = value; }, diagnosticOwnerReads: () => diagnosticOwnerReads };
}
test('production default-off attachment gate never accesses diagnostic owner', () => {
  const f = fixture();
  assert.equal(f.diagnosticOwnerReads(), 0);
  assert.ok(f.guest.handlers.has('before-input-event'));
  f.key(f.guest, 'a');
  f.guest.handlers.get('destroyed')();
  assert.equal(f.diagnosticOwnerReads(), 0);
});
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
test('typing A and D in a bound guest never changes annotation mode', () => {
  const f = fixture();
  f.key(f.guest, 'a'); f.key(f.guest, 'd');
  assert.deepEqual(f.annotations, []);
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
  assert.deepEqual(f.annotations, []);
  assert.deepEqual(f.sends.slice(0,2).map(row=>row[1].action), ['enter','done']);
  assert.equal(f.sends[1][1].expected.paneLineageId,'lineage-1');
  assert.equal(f.key(f.window.webContents, 'ArrowDown'), 1);
});
test('native terminal owns ordinary keys delivered through the host', () => {
  const f = fixture({ native: true });
  assert.equal(f.key(f.window.webContents, 'ArrowUp'), 0);
  f.key(f.window.webContents, 'a');
  assert.deepEqual(f.annotations, []); assert.deepEqual(f.sends, []);
});

test('production A/D shortcuts cannot bypass a held main Done owner', () => {
 const f=fixture();f.setDoneBusy(true);
 for(const key of ['a','d','d']) f.key(f.window.webContents,key);
 assert.deepEqual(f.annotations,[]);assert.deepEqual(f.sends,[]);
 f.setDoneBusy(false);f.key(f.window.webContents,'d');
 assert.equal(f.sends.length,1);assert.equal(f.sends[0][1].action,'done');
});
