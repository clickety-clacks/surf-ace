import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import ts from 'typescript';
const module = { exports: {} };
vm.runInNewContext(ts.transpile(fs.readFileSync(process.env.PANE_PAINT_SOURCE || new URL('../src/pane-painted-observation.ts', import.meta.url), 'utf8'), { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }), { module, exports: module.exports, require: createRequire(import.meta.url), Buffer, Uint8Array, AbortController, structuredClone, performance, setTimeout, clearTimeout });
const { observePanePaint } = module.exports;
function chunk(type, data) { let crc = 0xffffffff; const t = Buffer.from(type); for (const v of Buffer.concat([t, data])) {
    crc ^= v;
    for (let b = 0; b < 8; b++)
        crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
} const out = Buffer.alloc(12 + data.length); out.writeUInt32BE(data.length); t.copy(out, 4); data.copy(out, 8); out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 8 + data.length); return out; }
function png() { const hdr = Buffer.alloc(13); hdr.writeUInt32BE(2); hdr.writeUInt32BE(1, 4); hdr[8] = 8; hdr[9] = 2; return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', hdr), chunk('IDAT', deflateSync(Buffer.from([0, 16, 25, 35, 16, 25, 35]))), chunk('IEND', Buffer.alloc(0))]); }
function state() { return { binding: { surfaceId: 'surface', surfaceEpoch: 'epoch', windowInstanceId: 'window', hostWebContentsId: 6, paneId: 9, paneLineageId: 'lineage', contentId: 'pointer-rev9', contentType: 'html', contentRevision: 9, topologyRevision: 523, geometryRevision: 10, guestId: 11, frameInstanceId: 'frame', renderGeneration: 2, documentGeneration: 3 }, hostAttached: true, guestAttached: true, guestDocument: { navigationUrlSha256: 'a'.repeat(64), readyState: 'complete', bodyRect: { x: 0, y: 0, width: 1600, height: 810 }, backgroundColor: 'rgb(16,25,35)' }, projection: { coordinateSpace: 'surface-css-px', guestCoordinateSpace: 'guest-css-px', hostRect: { x: 10, y: 20, width: 1357, height: 689 }, clipRect: { x: 10, y: 20, width: 1357, height: 689 }, guestViewport: { width: 1596, height: 810, scrollX: 0, scrollY: 0 }, guestToSurface: [.85, 0, 0, .85, 10, 20], devicePixelRatio: 2, scaleMode: 'host-transform', scaleSequence: 1, scaleNonce: 'request', scaleRevision: 4, hostVisible: true, opacity: 1 } }; }
function setup() { let now = 0; const timers = new Set(), calls = [], current = state(); const clock = { now: () => now, schedule(f) { timers.add(f); return () => timers.delete(f); } }; const adapter = { readState: async () => current, capture: async (target, s) => { calls.push(target); now += target === 'GUEST' ? 4 : 6; return { target, binding: s.binding, png: png(), pixelWidth: 2, pixelHeight: 1 }; } }; return { current, clock, timers, calls, adapter, advance: n => now += n, fire: () => { for (const f of [...timers])
        f(); }, run(options = {}) { return observePanePaint(structuredClone(current.binding), adapter, { clock, ...options }); } }; }
function refused(r, reason) { assert.equal(r.kind, 'refused'); assert.equal(r.reason, reason); }
test('stable pair binds raw images identity projection and non-atomic timings', async () => { const s = setup(), r = await s.run(); assert.equal(r.kind, 'observed'); assert.deepEqual(s.calls, ['GUEST', 'HOST']); assert.equal(r.stateReads.length, 6); assert.equal(r.midpointSkewMs, 5); assert.equal(r.endedMonotonicMs, 10); assert.equal(r.atomic, false); assert.equal(r.paintFreshness, 'not-established'); assert.equal(r.physicalDisplay, 'not-observed'); for (const i of r.captures) {
    assert.equal(i.sha256, createHash('sha256').update(i.png).digest('hex'));
    assert.equal(i.binding.paneLineageId, 'lineage');
    assert.equal(i.pixelWidth, 2);
} assert.equal(s.timers.size, 0); });
test('all expected binding fields reject stale requests before capture', async () => { const expected = state().binding; for (const key of Object.keys(expected)) {
    const s = setup(), other = structuredClone(expected);
    other[key] = typeof other[key] === 'number' ? other[key] + 1 : key === 'contentType' ? 'browser_url' : other[key] + '-other';
    refused(await observePanePaint(other, s.adapter, { clock: s.clock }), 'stale');
    assert.equal(s.calls.length, 0);
    assert.equal(s.timers.size, 0);
} });
test('guest detach after capture retains partial evidence and stops host', async () => { const s = setup(), capture = s.adapter.capture; s.adapter.capture = async (...args) => { const i = await capture(...args); s.current.guestAttached = false; return i; }; const r = await s.run(); refused(r, 'unavailable'); assert.equal(r.captures.length, 1); assert.deepEqual(s.calls, ['GUEST']); assert.equal(r.stateReads.at(-1).state.guestAttached, false); assert.equal(s.timers.size, 0); });
test('host capture followed by guest replacement cannot publish', async () => { const s = setup(), capture = s.adapter.capture; s.adapter.capture = async (...args) => { const i = await capture(...args); if (args[0] === 'HOST')
    s.current.binding.guestId = 99; return i; }; const r = await s.run(); refused(r, 'stale'); assert.equal(r.captures.length, 2); });
test('navigation renderer and frame incarnation changes reject', async () => { for (const key of ['documentGeneration', 'renderGeneration', 'frameInstanceId', 'hostWebContentsId', 'windowInstanceId']) {
    const s = setup(), capture = s.adapter.capture;
    s.adapter.capture = async (...args) => { const i = await capture(...args); s.current.binding[key] = typeof s.current.binding[key] === 'number' ? s.current.binding[key] + 1 : 'replacement'; return i; };
    refused(await s.run(), 'stale');
    assert.deepEqual(s.calls, ['GUEST']);
} });
test('projection clip scroll transform mode sequence and nonce changes reject', async () => { for (const change of [p => p.hostRect.x++, p => p.clipRect.width--, p => p.guestViewport.scrollY++, p => p.guestToSurface[0] = 1, p => p.scaleNonce = 'new-request', p => p.scaleRevision++, p => p.scaleSequence++, p => p.scaleMode = 'public-terminal-font', p => p.devicePixelRatio = 1, p => p.opacity = .5]) {
    const s = setup(), capture = s.adapter.capture;
    s.adapter.capture = async (...args) => { const i = await capture(...args); change(s.current.projection); return i; };
    refused(await s.run(), 'stale');
    assert.deepEqual(s.calls, ['GUEST']);
} });
test('wrong capture target guest or lineage cannot be relabeled', async () => { for (const change of [i => i.target = 'HOST', i => i.binding.guestId = 99, i => i.binding.paneLineageId = 'other']) {
    const s = setup(), capture = s.adapter.capture;
    s.adapter.capture = async (...args) => { const i = await capture(...args); change(i); return i; };
    const r = await s.run();
    refused(r, 'stale');
    assert.equal(r.captures.length, 0);
} });
test('corrupt CRC dimension mismatch missing and oversized PNG refuse', async () => { for (const change of [i => i.pixelWidth = 3, i => i.png[29] ^= 1, i => i.png = Buffer.alloc(1), i => i.png = Buffer.alloc(100000)]) {
    const s = setup(), capture = s.adapter.capture;
    s.adapter.capture = async (...args) => { const i = await capture(...args); change(i); return i; };
    refused(await s.run({ maxImageBytes: 1000 }), 'invalid-image');
} });
test('unknown state coordinate space or detached host refuse without capture', async () => { for (const change of [s => s.hostAttached = false, s => s.projection.coordinateSpace = 'unknown', s => s.projection.guestToSurface[0] = NaN, s => s.guestDocument.navigationUrlSha256 = 'missing']) {
    const s = setup();
    change(s.current);
    refused(await s.run(), 'unavailable');
    assert.equal(s.calls.length, 0);
} });
test('invalid requests and limits refuse without adapter reads', async () => { for (const options of [{ timeoutMs: 0 }, { timeoutMs: 5001 }, { maxImageBytes: 1 }]) {
    const s = setup();
    s.adapter.readState = async () => { throw Error('must not read'); };
    refused(await s.run(options), 'invalid-request');
} const s = setup(), bad = structuredClone(s.current.binding); bad.paneLineageId = ''; refused(await observePanePaint(bad, s.adapter, { clock: s.clock }), 'invalid-request'); });
test('read and host capture failures retain partial evidence and clear timers', async () => { const s = setup(); s.adapter.readState = async () => { throw Error('read failed'); }; refused(await s.run(), 'read-failed'); assert.equal(s.timers.size, 0); const t = setup(), capture = t.adapter.capture; t.adapter.capture = async (...args) => { if (args[0] === 'HOST')
    throw Error('capture failed'); return capture(...args); }; const r = await t.run(); refused(r, 'capture-failed'); assert.equal(r.captures.length, 1); assert.equal(t.timers.size, 0); });
test('timeout aborts and late completion never starts host or adopts image', async () => { const s = setup(); let release, signal; s.adapter.capture = async (target, frame, seen) => { s.calls.push(target); signal = seen; return new Promise(resolve => release = () => resolve({ target, binding: frame.binding, png: png(), pixelWidth: 2, pixelHeight: 1 })); }; const pending = s.run({ timeoutMs: 20 }); while (!release)
    await Promise.resolve(); s.advance(20); s.fire(); const r = await pending; refused(r, 'timeout'); assert.equal(signal.aborted, true); release(); await Promise.resolve(); await Promise.resolve(); assert.deepEqual(s.calls, ['GUEST']); assert.equal(r.captures.length, 0); assert.equal(s.timers.size, 0); });
test('expired completion and backward clock cannot publish a pair', async () => { const s = setup(), capture = s.adapter.capture; s.adapter.capture = async (...args) => { const i = await capture(...args); s.advance(30); return i; }; refused(await s.run({ timeoutMs: 20 }), 'timeout'); const t = setup(), capture2 = t.adapter.capture; t.adapter.capture = async (...args) => { const i = await capture2(...args); t.advance(-10); return i; }; refused(await t.run(), 'timeout'); });
test('mutable adapter references do not hide geometry change or rewrite saved bytes', async () => { const s = setup(), capture = s.adapter.capture; let first; s.adapter.capture = async (...args) => { const i = await capture(...args); if (args[0] === 'GUEST')
    first = i.png;
else
    first.fill(0); return i; }; const r = await s.run(); assert.equal(r.kind, 'observed'); assert.equal(r.captures[0].sha256, createHash('sha256').update(r.captures[0].png).digest('hex')); assert.notEqual(r.captures[0].png[0], 0); const t = setup(), capture2 = t.adapter.capture; t.adapter.capture = async (...args) => { const i = await capture2(...args); t.current.projection.clipRect.width = 1; return i; }; refused(await t.run(), 'stale'); });
test('dynamic document facts remain per-read without claiming same paint', async () => { const s = setup(), capture = s.adapter.capture; s.adapter.capture = async (...args) => { const i = await capture(...args); s.current.guestDocument.backgroundColor = 'rgb(255,255,255)'; return i; }; const r = await s.run(); assert.equal(r.kind, 'observed'); assert.equal(r.stateReads[0].state.guestDocument.backgroundColor, 'rgb(16,25,35)'); assert.equal(r.stateReads.at(-1).state.guestDocument.backgroundColor, 'rgb(255,255,255)'); assert.equal(r.atomic, false); assert.equal(r.paintFreshness, 'not-established'); });
test('default monotonic clock times out a hung capture and aborts without host work', async () => {
    const current = state();
    const calls = [];
    let signal;
    const result = await observePanePaint(current.binding, {
        readState: async () => current,
        capture: async (target, _frame, observedSignal) => {
            calls.push(target);
            signal = observedSignal;
            return new Promise(() => {});
        },
    }, { timeoutMs: 20 });
    refused(result, 'timeout');
    assert.equal(signal.aborted, true);
    assert.deepEqual(calls, ['GUEST']);
    assert.equal(result.captures.length, 0);
});

function orderedPng(kind) {
    const base = png(), compressed = deflateSync(Buffer.from([0, 16, 25, 35, 16, 25, 35]));
    const palette = chunk('PLTE', Buffer.from([16, 25, 35]));
    const first = chunk('IDAT', compressed.subarray(0, 4)), second = chunk('IDAT', compressed.subarray(4));
    const text = chunk('tEXt', Buffer.from('key\0value'));
    const variants = {
        single: [chunk('IDAT', compressed)], consecutive: [first, second],
        palette: [palette, first, second], trailingText: [first, second, text],
        latePalette: [chunk('IDAT', compressed), palette],
        duplicatePalette: [palette, palette, chunk('IDAT', compressed)],
        interruptedIdat: [first, text, second],
    };
    return Buffer.concat([base.subarray(0, 33), ...variants[kind], chunk('IEND', Buffer.alloc(0))]);
}
for (const kind of ['single', 'consecutive', 'palette', 'trailingText']) {
    test(`observer accepts valid PNG chunk sequence ${kind}`, async () => {
        const s = setup(), capture = s.adapter.capture;
        s.adapter.capture = async (...args) => ({ ...await capture(...args), png: orderedPng(kind) });
        const r = await s.run();
        assert.equal(r.kind, 'observed');
        assert.deepEqual(s.calls, ['GUEST', 'HOST']);
        assert.equal(r.captures.length, 2);
        for (const image of r.captures) assert.deepEqual(Buffer.from(image.png), orderedPng(kind));
        assert.equal(s.timers.size, 0);
    });
}
for (const kind of ['latePalette', 'duplicatePalette', 'interruptedIdat']) {
    for (const badTarget of ['GUEST', 'HOST']) {
        test(`observer refuses ${kind} in ${badTarget} with correct partial evidence`, async () => {
            const s = setup(), capture = s.adapter.capture;
            s.adapter.capture = async (...args) => {
                const image = await capture(...args);
                return args[0] === badTarget ? { ...image, png: orderedPng(kind) } : image;
            };
            const r = await s.run();
            refused(r, 'invalid-image');
            assert.equal(r.stage, `${badTarget}:png`);
            assert.deepEqual(s.calls, badTarget === 'GUEST' ? ['GUEST'] : ['GUEST', 'HOST']);
            assert.equal(r.captures.length, badTarget === 'GUEST' ? 0 : 1);
            if (badTarget === 'HOST') {
                assert.equal(r.captures[0].target, 'GUEST');
                assert.deepEqual(Buffer.from(r.captures[0].png), png());
                assert.equal(r.captures[0].sha256, createHash('sha256').update(png()).digest('hex'));
            }
            assert.equal(s.timers.size, 0);
        });
    }
}
