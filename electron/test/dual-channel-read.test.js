const assert = require('node:assert/strict');
const test = require('node:test');

const { createHttpHarness } = require('./helpers/httpHarness');

async function withHarness(t, options, run) {
  const harness = await createHttpHarness(options);
  t.after(async () => {
    await harness.close();
  });
  await run(harness);
}

async function pair(harness, eventProfile = 'minimum_deep') {
  const paired = await harness.pairClient({
    connectionId: `cn_${Math.random().toString(16).slice(2, 10)}`,
    drawingFlushConfig: {
      idleWindowMs: 5000,
      maxIntervalMs: 10000
    },
    eventProfile,
    providerId: 'pv_dual_channel'
  });

  assert.equal(paired.pairResponse.ok, true, JSON.stringify(paired.pairResponse));
  return paired.client;
}

function htmlSet(contentId, revision, html = '<p>x</p>') {
  return {
    content: { html },
    contentId,
    contentType: 'html',
    revision
  };
}

async function stroke(harness, strokeId, x = 1, y = 1) {
  await harness.sendRendererStroke({
    points: [{ timestamp: Date.now(), x, y }],
    strokeId,
    tool: 'mouse'
  });
}

test('DUAL-E-01 surf_ace_read returns live dirty state and does not force frame finalization', async (t) => {
  await withHarness(t, {}, async (harness) => {
    const client = await pair(harness);
    t.after(() => client.close(1000, 'provider_shutdown'));

    await client.sendRequest('content.set', htmlSet('ct_10000001', 1, '<p>live</p>'));
    await stroke(harness, 'stroke_aaa111', 10, 20);

    const first = await client.sendRequest('surf_ace_read', {
      fingerprint: harness.state.identity.fingerprint
    });

    assert.equal(first.ok, true);
    assert.equal(first.payload.liveFrame.contextKey, 'ct_10000001');
    assert.deepEqual(first.payload.liveDirtyStrokeIds, ['stroke_aaa111']);
    assert.equal(first.payload.liveSeq, 1);
    assert.equal(first.payload.frames.length, 0);

    const second = await client.sendRequest('surf_ace_read', {
      fingerprint: harness.state.identity.fingerprint
    });

    assert.equal(second.ok, true);
    assert.equal(second.payload.liveFrame.frameId, first.payload.liveFrame.frameId);
    assert.deepEqual(second.payload.liveDirtyStrokeIds, []);
    assert.equal(second.payload.frames.length, 0);
  });
});

test('DUAL-E-02 context switch finalizes previous frame only when annotation starts in new context', async (t) => {
  await withHarness(t, {}, async (harness) => {
    const client = await pair(harness);
    t.after(() => client.close(1000, 'provider_shutdown'));

    await client.sendRequest('content.set', htmlSet('ct_20000001', 1, '<p>switch</p>'));
    await stroke(harness, 'stroke_bbb111', 5, 5);

    await harness.sendRendererEvent({
      event: 'navigation',
      url: 'https://example.com/path?x=1#frag'
    });

    const beforeSwitch = await client.sendRequest('surf_ace_read', {});
    assert.equal(beforeSwitch.ok, true);
    assert.equal(beforeSwitch.payload.liveFrame.contextKey, 'ct_20000001');
    assert.equal(beforeSwitch.payload.frames.length, 0);

    await stroke(harness, 'stroke_bbb222', 9, 9);

    const afterSwitch = await client.sendRequest('surf_ace_read', {});
    assert.equal(afterSwitch.ok, true);
    assert.equal(afterSwitch.payload.liveFrame.contextKey, 'https://example.com/path?x=1');
    assert.deepEqual(afterSwitch.payload.liveDirtyStrokeIds, ['stroke_bbb222']);
    assert.equal(afterSwitch.payload.frames.length, 1);
    assert.equal(afterSwitch.payload.frames[0].contextKey, 'ct_20000001');
    assert.equal(afterSwitch.payload.frames[0].strokes[0].strokeId, 'stroke_bbb111');
  });
});

test('DUAL-E-03 content.set and content.clear finalize open live frame without forced segmentation', async (t) => {
  await withHarness(t, {}, async (harness) => {
    const client = await pair(harness);
    t.after(() => client.close(1000, 'provider_shutdown'));

    await client.sendRequest('content.set', htmlSet('ct_30000001', 1, '<p>one</p>'));
    await stroke(harness, 'stroke_ccc111', 11, 11);

    await client.sendRequest('content.set', htmlSet('ct_30000002', 2, '<p>two</p>'));

    const afterSet = await client.sendRequest('surf_ace_read', {});
    assert.equal(afterSet.ok, true);
    assert.equal(afterSet.payload.liveFrame, null);
    assert.equal(afterSet.payload.frames.length, 1);
    assert.equal(afterSet.payload.frames[0].contextKey, 'ct_30000001');

    await stroke(harness, 'stroke_ccc222', 22, 22);
    await client.sendRequest('content.clear', { revision: 3 });

    const afterClear = await client.sendRequest('surf_ace_read', {});
    assert.equal(afterClear.ok, true);
    assert.equal(afterClear.payload.liveFrame, null);
    assert.equal(afterClear.payload.frames.length, 1);
    assert.equal(afterClear.payload.frames[0].contextKey, 'ct_30000002');
    assert.equal(afterClear.payload.frames[0].strokes[0].strokeId, 'stroke_ccc222');
  });
});

test('DUAL-E-04 surf_ace_read drains backlog oldest-first, keeps pendingFrames, and still returns live first', async (t) => {
  await withHarness(t, {}, async (harness) => {
    const client = await pair(harness);
    t.after(() => client.close(1000, 'provider_shutdown'));

    await client.sendRequest('content.set', htmlSet('ct_40000001', 1));
    for (let index = 1; index <= 6; index += 1) {
      await stroke(harness, `stroke_ddd11${index}`, index, index);
      if (index < 6) {
        await client.sendRequest('content.set', htmlSet(`ct_4000000${index + 1}`, index + 1));
      }
    }

    await client.sendRequest('content.clear', { revision: 7 });

    const firstRead = await client.sendRequest('surf_ace_read', {});
    assert.equal(firstRead.ok, true);
    assert.equal(firstRead.payload.frames.length, 5);
    assert.equal(firstRead.payload.frames[0].contextKey, 'ct_40000001');
    assert.equal(firstRead.payload.frames[4].contextKey, 'ct_40000005');
    assert.equal(firstRead.payload.pendingFrames, 1);

    await client.sendRequest('content.set', htmlSet('ct_40000007', 8));
    await stroke(harness, 'stroke_ddd117', 17, 17);

    const secondRead = await client.sendRequest('surf_ace_read', {});
    assert.equal(secondRead.ok, true);
    assert.equal(secondRead.payload.liveFrame.contextKey, 'ct_40000007');
    assert.deepEqual(secondRead.payload.liveDirtyStrokeIds, ['stroke_ddd117']);
    assert.equal(secondRead.payload.frames.length, 1);
    assert.equal(secondRead.payload.frames[0].contextKey, 'ct_40000006');
  });
});

test('DUAL-E-05 surf_ace_read registers are consumed on read and selection filtering keeps text only', async (t) => {
  await withHarness(t, {}, async (harness) => {
    const client = await pair(harness, 'deep_plus_scroll');
    t.after(() => client.close(1000, 'provider_shutdown'));

    await client.sendRequest('content.set', htmlSet('ct_50000001', 1, '<p>registers</p>'));

    await harness.sendRendererEvent({
      event: 'selection',
      selection: {
        kind: 'region',
        rect: { height: 1, width: 1, x: 1, y: 1 },
        text: 'ignore me'
      }
    });

    await harness.sendRendererEvent({
      event: 'selection',
      selection: {
        boundingRect: { height: 10, width: 20, x: 2, y: 3 },
        kind: 'text',
        text: 'picked text'
      }
    });

    await harness.sendRendererEvent({
      event: 'tap',
      kind: 'tap',
      nearestContent: 'button text',
      position: { x: 100, y: 120 }
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

    await harness.sendRendererEvent({
      event: 'page',
      page: 2,
      pageText: 'Page 2',
      totalPages: 10
    });

    await harness.sendRendererEvent({
      event: 'navigation',
      url: 'https://example.com/registers#frag'
    });

    const first = await client.sendRequest('surf_ace_read', {});
    assert.equal(first.ok, true);
    assert.equal(first.payload.taps.length, 1);
    assert.equal(first.payload.taps[0].nearestText, 'button text');
    assert.equal(first.payload.selection.selectedText, 'picked text');
    assert.equal(first.payload.scrollPosition.y, 50);
    assert.equal(first.payload.page.pageNumber, 2);
    assert.equal(first.payload.lastNavigation.url, 'https://example.com/registers');
    assert.equal(first.payload.overflowed, false);

    const second = await client.sendRequest('surf_ace_read', {});
    assert.equal(second.ok, true);
    assert.deepEqual(second.payload.taps, []);
    assert.equal(second.payload.selection, null);
    assert.equal(second.payload.scrollPosition, null);
    assert.equal(second.payload.page, null);
    assert.equal(second.payload.lastNavigation, null);
  });
});

test('DUAL-E-06 surf_ace_read returns screen_not_found for wrong fingerprint', async (t) => {
  await withHarness(t, {}, async (harness) => {
    const client = await pair(harness);
    t.after(() => client.close(1000, 'provider_shutdown'));

    const read = await client.sendRequest('surf_ace_read', { fingerprint: 'not_this_screen' });
    assert.equal(read.ok, false);
    assert.equal(read.error.code, 'screen_not_found');
  });
});
