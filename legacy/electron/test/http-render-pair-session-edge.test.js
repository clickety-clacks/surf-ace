const assert = require('node:assert/strict');
const test = require('node:test');

const { CONTENT_LIMITS } = require('../src/constants');
const { connectClient, createHttpHarness } = require('./helpers/httpHarness');
const { buildSimplePdfBase64 } = require('./helpers/pdf');
const { delay } = require('./helpers/network');

const PNG_1X1_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4////fwAJ+wP9qNfzmQAAAABJRU5ErkJggg==';

async function withHarness(t, options, run) {
  const harness = await createHttpHarness(options);
  t.after(async () => {
    await harness.close();
  });
  await run(harness);
}

async function pair(harness, overrides = {}) {
  const { client, pairResponse } = await harness.pairClient(overrides);
  assert.equal(pairResponse.ok, true, JSON.stringify(pairResponse));
  return { client, pairResponse };
}

async function discoverSurfaceId(client) {
  const list = await client.sendRequest('surfaces.list', {});
  assert.equal(list.ok, true, JSON.stringify(list));
  const surfaceId = list.payload?.surfaces?.[0]?.surfaceId;
  assert.ok(surfaceId, 'Expected at least one surfaceId');
  return surfaceId;
}

function frameSetHtml(frameId, revision, html) {
  return {
    content: { html },
    contentType: 'html',
    frameId,
    revision
  };
}

function contentSetHtml(contentId, revision, html) {
  return {
    content: { html },
    contentId,
    contentType: 'html',
    revision
  };
}

function frameSetTerminal(frameId, revision, lines = ['line 1', 'line 2']) {
  return {
    content: { lines, scrollback: 1000 },
    contentType: 'terminal',
    frameId,
    revision
  };
}

function frameSetMarkdown(frameId, revision, markdown) {
  return {
    content: { markdown },
    contentType: 'markdown',
    frameId,
    revision
  };
}

function frameSetImage(frameId, revision, data = PNG_1X1_BASE64, alt = 'image') {
  return {
    content: { alt, data, mediaType: 'image/png' },
    contentType: 'image',
    frameId,
    revision
  };
}

function frameSetPdf(frameId, revision, text = 'Hello PDF') {
  return {
    content: { data: buildSimplePdfBase64(text) },
    contentType: 'pdf',
    frameId,
    revision
  };
}

test('HTTP-E-01 health endpoint exists and reports ws path', async (t) => {
  await withHarness(t, {}, async (harness) => {
    const health = await harness.requestHealth();
    assert.equal(health.status, 200);
    assert.equal(health.json.status, 'ok');
    assert.equal(health.json.wsPath, '/ws');
  });
});

test('WS-E-01 pair-first rule blocks frame operations before pair', async (t) => {
  await withHarness(t, {}, async (harness) => {
    const client = await connectClient(harness.wsUrl);
    t.after(() => client.close(1000, 'provider_shutdown'));

    const response = await client.sendRequest('frame.set', frameSetHtml('fr_deadbeef', 1, '<p>x</p>'));
    assert.equal(response.ok, false);
    assert.equal(response.error.code, 'not_paired');
  });
});

test('WS-E-01b surfaces.list is allowed before pair and returns active surface descriptor', async (t) => {
  await withHarness(t, {}, async (harness) => {
    const client = await connectClient(harness.wsUrl);
    t.after(() => client.close(1000, 'provider_shutdown'));

    const list = await client.sendRequest('surfaces.list', {});
    assert.equal(list.ok, true);
    assert.equal(Array.isArray(list.payload.surfaces), true);
    assert.equal(list.payload.surfaces.length, 1);
    assert.match(list.payload.surfaces[0].surfaceId, /^sf_/);
    assert.equal(typeof list.payload.surfaces[0].name, 'string');
  });
});

test('WS-E-01c pair.request requires a valid surfaceId from surfaces.list', async (t) => {
  await withHarness(t, {}, async (harness) => {
    const client = await connectClient(harness.wsUrl);
    t.after(() => client.close(1000, 'provider_shutdown'));

    const missing = await client.sendRequest('pair.request', {
      connectionId: 'cn_pair_missing_surface',
      protocolVersion: 1,
      providerId: 'pv_provider_a'
    });
    assert.equal(missing.ok, false);
    assert.equal(missing.error.code, 'invalid_payload');

    const wrong = await client.sendRequest('pair.request', {
      connectionId: 'cn_pair_wrong_surface',
      protocolVersion: 1,
      providerId: 'pv_provider_a',
      surfaceId: 'sf_not_here'
    });
    assert.equal(wrong.ok, false);
    assert.equal(wrong.error.code, 'invalid_payload');
  });
});

test('WS-E-02 pair handshake returns session, limits, and event config', async (t) => {
  await withHarness(t, {}, async (harness) => {
    const { client, pairResponse } = await pair(harness, {
      connectionId: 'cn_pair_01',
      providerId: 'pv_provider_a'
    });
    t.after(() => client.close(1000, 'provider_shutdown'));

    const payload = pairResponse.payload;
    assert.match(payload.sessionId, /^sa_/);
    assert.equal(payload.resumed, false);
    assert.equal(payload.state.currentRevision, 0);
    assert.deepEqual(payload.eventConfig.profile, 'minimum_deep');
    assert.equal(typeof payload.limits.maxMessageBytes, 'number');
    assert.equal(harness.state.getTxtRecords().busy, '1');
  });
});

test('WS-E-03 busy pairing rejected for different provider', async (t) => {
  await withHarness(t, {}, async (harness) => {
    const first = await pair(harness, {
      connectionId: 'cn_busy_1',
      providerId: 'pv_owner'
    });
    t.after(() => first.client.close(1000, 'provider_shutdown'));

    const secondClient = await connectClient(harness.wsUrl);
    t.after(() => secondClient.close(1000, 'provider_shutdown'));
    const surfaceId = await discoverSurfaceId(secondClient);

    const response = await secondClient.sendRequest('pair.request', {
      connectionId: 'cn_busy_2',
      protocolVersion: 1,
      providerId: 'pv_other',
      surfaceId
    });

    assert.equal(response.ok, false);
    assert.equal(response.error.code, 'busy');
  });
});

test('WS-E-04 same-provider takeover supersedes old socket', async (t) => {
  await withHarness(t, {}, async (harness) => {
    const first = await pair(harness, {
      connectionId: 'cn_takeover_1',
      providerId: 'pv_owner'
    });

    const secondClient = await connectClient(harness.wsUrl);
    const surfaceId = await discoverSurfaceId(secondClient);
    const takeover = await secondClient.sendRequest('pair.request', {
      connectionId: 'cn_takeover_2',
      protocolVersion: 1,
      providerId: 'pv_owner',
      surfaceId,
      takeover: true
    });

    assert.equal(takeover.ok, true);
    assert.equal(takeover.payload.resumed, true);

    first.client.close(1000, 'provider_shutdown');
    secondClient.close(1000, 'provider_shutdown');
  });
});

test('WS-E-05 frame.set revision gating enforces monotonic sequence', async (t) => {
  await withHarness(t, {}, async (harness) => {
    const { client } = await pair(harness);
    t.after(() => client.close(1000, 'provider_shutdown'));

    const one = await client.sendRequest('frame.set', frameSetHtml('fr_abcdef01', 1, '<p>one</p>'));
    assert.equal(one.ok, true);
    assert.equal(one.payload.currentRevision, 1);

    const stale = await client.sendRequest('frame.set', frameSetHtml('fr_abcdef02', 1, '<p>stale</p>'));
    assert.equal(stale.ok, false);
    assert.equal(stale.error.code, 'stale_revision');
    assert.equal(stale.error.details.expectedRevision, 2);

    const two = await client.sendRequest('frame.set', frameSetHtml('fr_abcdef03', 2, '<p>two</p>'));
    assert.equal(two.ok, true);
    assert.equal(two.payload.currentRevision, 2);
  });
});

test('WS-E-05b content.set/content.clear aliases return content-scoped summary fields', async (t) => {
  await withHarness(t, {}, async (harness) => {
    const { client } = await pair(harness);
    t.after(() => client.close(1000, 'provider_shutdown'));

    const set = await client.sendRequest('content.set', contentSetHtml('ct_abcdef01', 1, '<p>one</p>'));
    assert.equal(set.ok, true);
    assert.equal(set.payload.currentContentId, 'ct_abcdef01');
    assert.equal(set.payload.currentRevision, 1);

    const snapshot = await client.sendRequest('snapshot.get', {});
    assert.equal(snapshot.ok, true);
    assert.equal(snapshot.payload.contentId, 'ct_abcdef01');

    const clear = await client.sendRequest('content.clear', { revision: 2 });
    assert.equal(clear.ok, true);
    assert.equal(clear.payload.currentContentId, null);
    assert.equal(clear.payload.currentRevision, 2);
  });
});

test('WS-E-06 frame.append terminal only and stale_frame checks', async (t) => {
  await withHarness(t, {}, async (harness) => {
    const { client } = await pair(harness);
    t.after(() => client.close(1000, 'provider_shutdown'));

    await client.sendRequest('frame.set', frameSetTerminal('fr_dead0001', 1, ['start']));

    const appendOk = await client.sendRequest('frame.append', {
      frameId: 'fr_dead0001',
      lines: ['next'],
      revision: 2
    });
    assert.equal(appendOk.ok, true);

    const staleFrame = await client.sendRequest('frame.append', {
      frameId: 'fr_dead9999',
      lines: ['nope'],
      revision: 3
    });
    assert.equal(staleFrame.ok, false);
    assert.equal(staleFrame.error.code, 'stale_frame');

    await client.sendRequest('frame.set', frameSetHtml('fr_dead0002', 3, '<p>html</p>'));
    const wrongType = await client.sendRequest('frame.append', {
      frameId: 'fr_dead0002',
      lines: ['bad'],
      revision: 4
    });
    assert.equal(wrongType.ok, false);
    assert.equal(wrongType.error.code, 'unsupported_operation_for_content_type');
  });
});

test('WS-E-07 frame.patch html-only operations', async (t) => {
  await withHarness(t, {}, async (harness) => {
    const { client } = await pair(harness);
    t.after(() => client.close(1000, 'provider_shutdown'));

    await client.sendRequest('frame.set', frameSetHtml('fr_abcd0001', 1, '<div id="status">old</div>'));

    const patch = await client.sendRequest('frame.patch', {
      frameId: 'fr_abcd0001',
      patch: {
        action: 'replace_inner',
        html: 'new',
        selector: '#status'
      },
      revision: 2
    });

    assert.equal(patch.ok, true);

    await client.sendRequest('frame.set', frameSetTerminal('fr_abcd0002', 3, ['x']));
    const wrongType = await client.sendRequest('frame.patch', {
      frameId: 'fr_abcd0002',
      patch: {
        action: 'remove',
        selector: '#status'
      },
      revision: 4
    });

    assert.equal(wrongType.ok, false);
    assert.equal(wrongType.error.code, 'unsupported_operation_for_content_type');
  });
});

test('WS-E-08 frame.clear keeps session and advances revision', async (t) => {
  await withHarness(t, {}, async (harness) => {
    const { client } = await pair(harness);
    t.after(() => client.close(1000, 'provider_shutdown'));

    await client.sendRequest('frame.set', frameSetHtml('fr_abcd0003', 1, '<p>x</p>'));

    const clear = await client.sendRequest('frame.clear', { revision: 2 });
    assert.equal(clear.ok, true);
    assert.equal(clear.payload.currentFrameId, null);
    assert.equal(clear.payload.currentRevision, 2);

    const stillActive = await client.sendRequest('frame.set', frameSetHtml('fr_abcd0004', 3, '<p>after</p>'));
    assert.equal(stillActive.ok, true);
  });
});

test('WS-E-09 snapshot.get reports current state and 4KB text cap', async (t) => {
  await withHarness(t, {}, async (harness) => {
    const { client } = await pair(harness);
    t.after(() => client.close(1000, 'provider_shutdown'));

    await client.sendRequest('frame.set', frameSetHtml('fr_abcd0005', 1, `<p>${'a'.repeat(7000)}</p>`));

    const snapshot = await client.sendRequest('snapshot.get', {
      includeDrawings: true,
      includeImage: false,
      includeVisibleText: true
    });

    assert.equal(snapshot.ok, true);
    assert.equal(snapshot.payload.frameId, 'fr_abcd0005');
    assert.ok(snapshot.payload.visibleText.length <= 4096);
  });
});

test('WS-E-10 snapshot/get render contracts across content types', async (t) => {
  await withHarness(t, {}, async (harness) => {
    const { client } = await pair(harness);
    t.after(() => client.close(1000, 'provider_shutdown'));

    await client.sendRequest('frame.set', frameSetHtml('fr_abcd0006', 1, '<p>Hello</p>'));
    let snapshot = await client.sendRequest('snapshot.get', {});
    assert.match(snapshot.payload.visibleText, /Hello/);

    await client.sendRequest('frame.set', frameSetImage('fr_abcd0007', 2, PNG_1X1_BASE64, 'img alt'));
    snapshot = await client.sendRequest('snapshot.get', {});
    assert.equal(snapshot.payload.visibleText, 'img alt');

    await client.sendRequest('frame.set', frameSetPdf('fr_abcd0008', 3, 'Known PDF Text'));
    snapshot = await client.sendRequest('snapshot.get', {});
    assert.match(snapshot.payload.visibleText, /Known PDF Text/);

    await client.sendRequest('frame.set', frameSetTerminal('fr_abcd0009', 4, ['line 1', 'line 2']));
    snapshot = await client.sendRequest('snapshot.get', {});
    assert.match(snapshot.payload.visibleText, /line 1/);

    await client.sendRequest('frame.set', frameSetMarkdown('fr_abcd000a', 5, '# Hello\n\nWorld'));
    snapshot = await client.sendRequest('snapshot.get', {});
    assert.match(snapshot.payload.visibleText, /Hello/);
    assert.match(snapshot.payload.visibleText, /World/);
  });
});

test('WS-E-11 annotations.remove removes by stroke id and is idempotent', async (t) => {
  await withHarness(t, {}, async (harness) => {
    const { client } = await pair(harness);
    t.after(() => client.close(1000, 'provider_shutdown'));

    await client.sendRequest('frame.set', frameSetHtml('fr_abcd000b', 1, '<p>draw</p>'));

    await harness.sendRendererStroke({
      points: [{ timestamp: Date.now(), x: 1, y: 1 }],
      strokeId: 'stroke_abc123',
      tool: 'mouse'
    });
    await harness.sendRendererStroke({
      points: [{ timestamp: Date.now(), x: 2, y: 2 }],
      strokeId: 'stroke_def456',
      tool: 'mouse'
    });

    const removeOne = await client.sendRequest('annotations.remove', {
      frameId: 'fr_abcd000b',
      strokeIds: ['stroke_abc123']
    });

    assert.equal(removeOne.ok, true);
    assert.deepEqual(removeOne.payload.removedStrokeIds, ['stroke_abc123']);
    assert.equal(removeOne.payload.remainingStrokeCount, 1);

    const removeAgain = await client.sendRequest('annotations.remove', {
      frameId: 'fr_abcd000b',
      strokeIds: ['stroke_abc123']
    });
    assert.equal(removeAgain.ok, true);
    assert.deepEqual(removeAgain.payload.removedStrokeIds, []);
    assert.deepEqual(removeAgain.payload.notFoundStrokeIds, ['stroke_abc123']);
  });
});

test('WS-E-12 heartbeat.ping echoes nonce in heartbeat.pong response', async (t) => {
  await withHarness(t, {}, async (harness) => {
    const { client } = await pair(harness);
    t.after(() => client.close(1000, 'provider_shutdown'));

    const pong = await client.sendRequest('heartbeat.ping', { nonce: 'nonce-123' });
    assert.equal(pong.ok, true);
    assert.equal(pong.op, 'heartbeat.ping');
    assert.equal(pong.payload.nonce, 'nonce-123');
  });
});

test('WS-E-13 request id replay returns cached response; changed payload is rejected', async (t) => {
  await withHarness(t, {}, async (harness) => {
    const { client } = await pair(harness);
    t.after(() => client.close(1000, 'provider_shutdown'));

    const requestId = 'req_same_id';
    const first = await client.sendRequest('frame.set', frameSetHtml('fr_abcd000c', 1, '<p>a</p>'), requestId);
    assert.equal(first.ok, true);

    const replay = await client.sendRequest('frame.set', frameSetHtml('fr_abcd000c', 1, '<p>a</p>'), requestId);
    assert.equal(replay.ok, true);
    assert.deepEqual(replay.payload, first.payload);

    const mismatch = await client.sendRequest('frame.set', frameSetHtml('fr_abcd000d', 2, '<p>b</p>'), requestId);
    assert.equal(mismatch.ok, false);
    assert.equal(mismatch.error.code, 'invalid_request_id_reuse');
  });
});

test('WS-E-14 reconnect grace resumes same session and preserves frame state', async (t) => {
  await withHarness(t, { resumeGraceMs: 250 }, async (harness) => {
    const paired = await pair(harness, {
      connectionId: 'cn_resume_1',
      providerId: 'pv_resume'
    });

    await paired.client.sendRequest('frame.set', frameSetHtml('fr_abcd000e', 1, '<p>persist</p>'));

    const firstSessionId = paired.pairResponse.payload.sessionId;
    paired.client.terminate();

    await delay(30);

    const resumedClient = await connectClient(harness.wsUrl);
    const resumedSurfaceId = await discoverSurfaceId(resumedClient);
    const resumed = await resumedClient.sendRequest('pair.request', {
      connectionId: 'cn_resume_2',
      protocolVersion: 1,
      providerId: 'pv_resume',
      resume: {
        sessionId: firstSessionId
      },
      surfaceId: resumedSurfaceId,
      takeover: true
    });

    assert.equal(resumed.ok, true);
    assert.equal(resumed.payload.sessionId, firstSessionId);
    assert.equal(resumed.payload.resumed, true);
    assert.equal(resumed.payload.state.currentFrameId, 'fr_abcd000e');

    resumedClient.close(1000, 'provider_shutdown');
  });
});

test('EDGE-E-01 validation and size errors map to protocol error codes', async (t) => {
  await withHarness(t, {}, async (harness) => {
    const { client } = await pair(harness);
    t.after(() => client.close(1000, 'provider_shutdown'));

    const unsupported = await client.sendRequest('frame.set', {
      content: {},
      contentType: 'video',
      frameId: 'fr_abcd000f',
      revision: 1
    });
    assert.equal(unsupported.ok, false);
    assert.equal(unsupported.error.code, 'unsupported_content_type');

    const tooLargeHtml = await client.sendRequest('frame.set', {
      content: { html: `<p>${'x'.repeat(CONTENT_LIMITS.htmlBytes + 1)}</p>` },
      contentType: 'html',
      frameId: 'fr_abcd0010',
      revision: 1
    });
    assert.equal(tooLargeHtml.ok, false);
    assert.equal(tooLargeHtml.error.code, 'content_too_large');

    const badImage = await client.sendRequest('frame.set', {
      content: { data: '!!notbase64!!', mediaType: 'image/png' },
      contentType: 'image',
      frameId: 'fr_abcd0011',
      revision: 1
    });
    assert.equal(badImage.ok, false);
    assert.equal(badImage.error.code, 'invalid_payload');
  });
});
