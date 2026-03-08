const assert = require('node:assert/strict');
const test = require('node:test');

const { createHttpHarness } = require('./helpers/httpHarness');
const { delay } = require('./helpers/network');

async function withHarness(t, options, run) {
  const harness = await createHttpHarness(options);
  t.after(async () => {
    await harness.close();
  });
  await run(harness);
}

async function pairWithConfig(harness, drawingFlushConfig, eventProfile = 'minimum_deep') {
  const paired = await harness.pairClient({
    connectionId: `cn_${Math.random().toString(16).slice(2, 10)}`,
    drawingFlushConfig,
    eventProfile,
    providerId: 'pv_draw_provider'
  });

  assert.equal(paired.pairResponse.ok, true);
  return paired;
}

test('PENCIL-E-01 PENCIL-E-05 drawing flush fires after idle gate with stable stroke ids', async (t) => {
  await withHarness(t, {}, async (harness) => {
    const paired = await pairWithConfig(harness, {
      idleWindowMs: 5000,
      maxIntervalMs: 10000
    });

    const client = paired.client;
    t.after(() => client.close(1000, 'provider_shutdown'));

    await client.sendRequest('frame.set', {
      content: { html: '<p>draw</p>' },
      contentType: 'html',
      frameId: 'fr_a0000001',
      revision: 1
    });

    await harness.sendRendererStroke({
      points: [{ timestamp: Date.now(), x: 1, y: 1 }],
      strokeId: 'stroke_aaaaaa',
      tool: 'mouse'
    });

    await harness.sendRendererStroke({
      points: [{ timestamp: Date.now(), x: 2, y: 2 }],
      strokeId: 'stroke_bbbbbb',
      tool: 'mouse'
    });

    const flushEvent = await client.waitForEvent(
      (event) => event.op === 'event.drawing_flush',
      { timeoutMs: 7000 }
    );

    assert.equal(flushEvent.payload.frameId, 'fr_a0000001');
    assert.equal(flushEvent.payload.flushReason, 'idle_window');
    assert.deepEqual(
      flushEvent.payload.strokes.map((stroke) => stroke.strokeId),
      ['stroke_aaaaaa', 'stroke_bbbbbb']
    );
  });
});

test('PENCIL-E-10 dirty gate prevents redundant flush when no new strokes', async (t) => {
  await withHarness(t, {}, async (harness) => {
    const paired = await pairWithConfig(harness, {
      idleWindowMs: 5000,
      maxIntervalMs: 10000
    });

    const client = paired.client;
    t.after(() => client.close(1000, 'provider_shutdown'));

    await client.sendRequest('frame.set', {
      content: { html: '<p>draw</p>' },
      contentType: 'html',
      frameId: 'fr_a0000002',
      revision: 1
    });

    await harness.sendRendererStroke({
      points: [{ timestamp: Date.now(), x: 5, y: 5 }],
      strokeId: 'stroke_cccccc',
      tool: 'mouse'
    });

    await client.waitForEvent((event) => event.op === 'event.drawing_flush', {
      timeoutMs: 7000
    });

    const flushCountAfterFirst = client.events.filter((event) => event.op === 'event.drawing_flush').length;
    await delay(2500);
    const flushCountAfterIdle = client.events.filter((event) => event.op === 'event.drawing_flush').length;

    assert.equal(flushCountAfterIdle, flushCountAfterFirst);
  });
});

test('PENCIL-E-11 annotations.remove reports removed and not found stroke ids', async (t) => {
  await withHarness(t, {}, async (harness) => {
    const paired = await pairWithConfig(harness, {
      idleWindowMs: 5000,
      maxIntervalMs: 10000
    });

    const client = paired.client;
    t.after(() => client.close(1000, 'provider_shutdown'));

    await client.sendRequest('frame.set', {
      content: { html: '<p>draw</p>' },
      contentType: 'html',
      frameId: 'fr_a0000003',
      revision: 1
    });

    await harness.sendRendererStroke({
      points: [{ timestamp: Date.now(), x: 10, y: 10 }],
      strokeId: 'stroke_dddddd',
      tool: 'mouse'
    });

    const remove = await client.sendRequest('annotations.remove', {
      frameId: 'fr_a0000003',
      strokeIds: ['stroke_dddddd', 'stroke_ffffff']
    });

    assert.equal(remove.ok, true);
    assert.deepEqual(remove.payload.removedStrokeIds, ['stroke_dddddd']);
    assert.deepEqual(remove.payload.notFoundStrokeIds, ['stroke_ffffff']);
    assert.equal(remove.payload.remainingStrokeCount, 0);
  });
});

test('CB-E-01 event.tap and event.selection are emitted from renderer inputs', async (t) => {
  await withHarness(t, {}, async (harness) => {
    const paired = await pairWithConfig(harness, {
      idleWindowMs: 5000,
      maxIntervalMs: 10000
    });

    const client = paired.client;
    t.after(() => client.close(1000, 'provider_shutdown'));

    await client.sendRequest('frame.set', {
      content: { html: '<p>events</p>' },
      contentType: 'html',
      frameId: 'fr_a0000004',
      revision: 1
    });

    await harness.sendRendererEvent({
      event: 'tap',
      kind: 'tap',
      nearestContent: 'button text',
      position: { x: 100, y: 120 }
    });

    await harness.sendRendererEvent({
      event: 'selection',
      selection: {
        boundingRect: { height: 10, width: 20, x: 2, y: 3 },
        kind: 'text',
        text: 'picked text'
      }
    });

    const tapEvent = await client.waitForEvent((event) => event.op === 'event.tap', {
      timeoutMs: 1500
    });
    const selectionEvent = await client.waitForEvent((event) => event.op === 'event.selection', {
      timeoutMs: 1500
    });

    assert.equal(tapEvent.payload.frameId, 'fr_a0000004');
    assert.equal(tapEvent.payload.kind, 'tap');
    assert.equal(selectionEvent.payload.selection.kind, 'text');
  });
});

test('CB-E-03 deep_plus_scroll profile enables event.scroll', async (t) => {
  await withHarness(t, {}, async (harness) => {
    const paired = await pairWithConfig(
      harness,
      {
        idleWindowMs: 5000,
        maxIntervalMs: 10000
      },
      'deep_plus_scroll'
    );

    const client = paired.client;
    t.after(() => client.close(1000, 'provider_shutdown'));

    await client.sendRequest('frame.set', {
      content: { html: '<p>scroll</p>' },
      contentType: 'html',
      frameId: 'fr_a0000005',
      revision: 1
    });

    await harness.sendRendererEvent({
      event: 'scroll',
      viewport: {
        contentSize: { height: 1000, width: 800 },
        scrollOffset: { x: 0, y: 50 },
        visibleRect: { height: 300, width: 400, x: 0, y: 50 },
        zoomLevel: 1
      },
      visibleText: 'viewport content'
    });

    const scrollEvent = await client.waitForEvent((event) => event.op === 'event.scroll', {
      timeoutMs: 1500
    });

    assert.equal(scrollEvent.payload.phase, 'settled');
    assert.equal(scrollEvent.payload.frameId, 'fr_a0000005');
  });
});

test('CB-E-04 event.navigation is emitted in minimum_deep profile', async (t) => {
  await withHarness(t, {}, async (harness) => {
    const paired = await pairWithConfig(harness, {
      idleWindowMs: 5000,
      maxIntervalMs: 10000
    });

    const client = paired.client;
    t.after(() => client.close(1000, 'provider_shutdown'));

    await client.sendRequest('frame.set', {
      content: { html: '<p>nav</p>' },
      contentType: 'html',
      frameId: 'fr_a0000007',
      revision: 1
    });

    await harness.sendRendererEvent({
      event: 'navigation',
      url: 'https://example.com/surface'
    });

    const navigationEvent = await client.waitForEvent((event) => event.op === 'event.navigation', {
      timeoutMs: 1500
    });

    assert.equal(navigationEvent.payload.frameId, 'fr_a0000007');
    assert.equal(navigationEvent.payload.url, 'https://example.com/surface');
  });
});

test('CB-E-10 flush indicator toggles during drawing flush send', async (t) => {
  await withHarness(t, {}, async (harness) => {
    const paired = await pairWithConfig(harness, {
      idleWindowMs: 5000,
      maxIntervalMs: 10000
    });

    const client = paired.client;
    t.after(() => client.close(1000, 'provider_shutdown'));

    await client.sendRequest('frame.set', {
      content: { html: '<p>indicator</p>' },
      contentType: 'html',
      frameId: 'fr_a0000006',
      revision: 1
    });

    await harness.sendRendererStroke({
      points: [{ timestamp: Date.now(), x: 9, y: 9 }],
      strokeId: 'stroke_eeeeee',
      tool: 'mouse'
    });

    await client.waitForEvent((event) => event.op === 'event.drawing_flush', {
      timeoutMs: 7000
    });

    const states = harness.flushIndicatorStates;
    assert.ok(states.includes(true));
    assert.ok(states.includes(false));
  });
});
