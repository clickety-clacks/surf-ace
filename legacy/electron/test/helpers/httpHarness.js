const assert = require('node:assert/strict');
const { parseHTML } = require('linkedom');
const WebSocket = require('ws');

const { SurfAceState } = require('../../src/surfAceState');
const { createSurfAceWsServer } = require('../../src/httpServer');
const { getFreePort } = require('./network');

function markdownToVisibleText(markdown) {
  return String(markdown)
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^[-*+]\s+/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .replace(/\[(.+?)\]\((.+?)\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 4096);
}

function htmlToVisibleText(html) {
  const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  return String(document.body.textContent || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 4096);
}

function snapshotForFrame(frame, viewport) {
  const base = {
    frameId: frame.frameId,
    selection: null,
    viewport: {
      contentSize: {
        height: viewport.height,
        width: viewport.width
      },
      scrollOffset: { x: 0, y: 0 },
      visibleRect: {
        height: viewport.height,
        width: viewport.width,
        x: 0,
        y: 0
      },
      zoomLevel: 1
    }
  };

  if (frame.contentType === 'html') {
    return {
      ...base,
      visibleText: htmlToVisibleText(frame.content.html)
    };
  }

  if (frame.contentType === 'image') {
    return {
      ...base,
      visibleText: String(frame.content.alt || '').slice(0, 4096)
    };
  }

  if (frame.contentType === 'pdf') {
    return {
      ...base,
      visibleText: String(frame.content.extractedText || '').slice(0, 4096)
    };
  }

  if (frame.contentType === 'terminal') {
    return {
      ...base,
      visibleText: frame.content.lines.join('\n').slice(0, 4096)
    };
  }

  return {
    ...base,
    visibleText: markdownToVisibleText(frame.content.markdown)
  };
}

function createClient(ws) {
  const pending = new Map();
  const events = [];
  const eventWaiters = [];

  ws.on('message', (raw) => {
    const message = JSON.parse(raw.toString('utf8'));

    if (message.type === 'response') {
      const resolver = pending.get(message.id);
      if (resolver) {
        pending.delete(message.id);
        resolver.resolve(message);
      }
      return;
    }

    if (message.type === 'event') {
      events.push(message);
      for (const waiter of eventWaiters) {
        waiter();
      }
    }
  });

  function sendRequest(op, payload, id = `req_${Math.random().toString(36).slice(2, 10)}`) {
    const body = {
      id,
      op,
      payload,
      sentAt: Date.now(),
      type: 'request',
      v: 1
    };

    const promise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timed out waiting for ${op} response`));
      }, 3000);

      pending.set(id, {
        resolve: (response) => {
          clearTimeout(timeout);
          resolve(response);
        }
      });
    });

    ws.send(JSON.stringify(body));
    return promise;
  }

  async function waitForEvent(predicate, { timeoutMs = 5000 } = {}) {
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      const match = events.find(predicate);
      if (match) {
        return match;
      }

      await new Promise((resolve) => {
        const wake = () => {
          const index = eventWaiters.indexOf(wake);
          if (index >= 0) {
            eventWaiters.splice(index, 1);
          }
          resolve();
        };

        eventWaiters.push(wake);
        setTimeout(wake, 20);
      });
    }

    throw new Error('Timed out waiting for event');
  }

  return {
    close: (code = 1000, reason = 'provider_shutdown') => ws.close(code, reason),
    events,
    sendRequest,
    terminate: () => ws.terminate(),
    waitForEvent
  };
}

async function connectClient(url) {
  const ws = await new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });

  return createClient(ws);
}

async function createHttpHarness(options = {}) {
  const port = options.port ?? (await getFreePort());
  const identity = options.identity || {
    fingerprint: 'deadbeef',
    publicKey: 'test-public',
    privateKey: 'test-private'
  };

  const state = new SurfAceState({
    identity,
    screenName: options.screenName || 'Surface Test',
    tlsEnabled: false,
    viewport: options.viewport || { height: 720, scale: 1, width: 1280 },
    wsPath: '/ws'
  });

  const frames = [];
  const removedStrokeIds = [];
  const flushIndicatorStates = [];

  const server = createSurfAceWsServer({
    captureSnapshotImage: async () => options.snapshotImage || null,
    logger: console,
    onAnnotationsRemove: async (strokeIds) => {
      removedStrokeIds.push(...strokeIds);
    },
    onClearFrame: async () => {
      if (typeof options.onClearFrame === 'function') {
        await options.onClearFrame();
      }
    },
    onFlushIndicator: async (visible) => {
      flushIndicatorStates.push(Boolean(visible));
    },
    onFrame: async (frame) => {
      frames.push(frame);
      if (options.autoSnapshot !== false) {
        state.setSnapshot(snapshotForFrame(frame, state.viewport));
      }

      if (typeof options.onFrame === 'function') {
        await options.onFrame(frame);
      }
    },
    onSession: async () => {
      if (typeof options.onSession === 'function') {
        await options.onSession(state.getSessionView());
      }
    },
    port,
    resumeGraceMs: options.resumeGraceMs,
    state,
    wsPath: '/ws'
  });

  await server.start();

  async function requestHealth() {
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    const json = await response.json();
    return {
      json,
      status: response.status
    };
  }

  async function pairClient({
    connectionId = 'cn_test_conn',
    drawingFlushConfig = {
      idleWindowMs: 8000,
      maxIntervalMs: 30000
    },
    eventProfile = 'minimum_deep',
    providerId = 'pv_test_provider',
    surfaceId = null,
    takeover = false,
    resumeSessionId = null
  } = {}) {
    const client = await connectClient(`ws://127.0.0.1:${port}/ws`);
    let resolvedSurfaceId = surfaceId;
    if (!resolvedSurfaceId) {
      const surfacesList = await client.sendRequest('surfaces.list', {});
      assert.equal(surfacesList.ok, true, JSON.stringify(surfacesList));
      const firstSurface = surfacesList.payload?.surfaces?.[0];
      assert.ok(firstSurface?.surfaceId, 'Expected at least one surfaceId from surfaces.list');
      resolvedSurfaceId = firstSurface.surfaceId;
    }

    const pairResponse = await client.sendRequest('pair.request', {
      connectionId,
      drawingFlushConfig,
      eventProfile,
      protocolVersion: 1,
      providerId,
      resume: resumeSessionId ? { sessionId: resumeSessionId } : undefined,
      surfaceId: resolvedSurfaceId,
      takeover
    }, `pair_${Math.random().toString(36).slice(2, 10)}`);

    assert.equal(pairResponse.type, 'response');
    return {
      client,
      pairResponse
    };
  }

  return {
    close: async () => {
      await server.close();
    },
    flushIndicatorStates,
    frames,
    pairClient,
    removedStrokeIds,
    requestHealth,
    sendRendererEvent: async (payload) => {
      await server.handleRendererEvent(payload);
    },
    sendRendererStroke: async (payload) => {
      await server.handleRendererStroke(payload);
    },
    state,
    wsUrl: `ws://127.0.0.1:${port}/ws`
  };
}

module.exports = {
  connectClient,
  createHttpHarness,
  snapshotForFrame
};
