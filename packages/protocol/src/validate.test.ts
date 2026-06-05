import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  EVENT_MESSAGES,
  REQUEST_MESSAGES,
} from "./message-names.js";
import { SURF_ACE_PROTOCOL_SCHEMAS } from "./schemas-manifest.js";
import { annotationCommittedEventSchema, drawingFlushEventSchema } from "./schemas.js";
import { validateEnvelopeType } from "./validate.js";

const authorityVectorSet = JSON.parse(
  readFileSync(new URL("../vectors/authority-conformance.json", import.meta.url), "utf8"),
) as {
  vectors: Array<{
    contract: string;
    expected: string;
    id: string;
    requirements: string[];
  }>;
};

test("validateEnvelopeType accepts current request envelopes", () => {
  const result = validateEnvelopeType("pair.request", {
    id: "req_1",
    op: "pair.request",
    payload: {
      connectionId: "cn_1",
      initialPaneId: 1,
      initialPaneLabel: 1,
      protocolVersion: 1,
      providerId: "prov_1",
      providerName: "test-harness",
      surfaceId: "sf_1",
      windowLabel: "a",
    },
    sentAt: Date.now(),
    type: "request",
    v: 1,
  });

  assert.deepEqual(result, { ok: true });
});

test("validateEnvelopeType accepts provider authority state envelopes", () => {
  const request = validateEnvelopeType("authority.state", {
    id: "req_authority_1",
    op: "authority.state",
    payload: {
      actionable: true,
      reason: null,
      ownershipEpoch: 1,
      providerId: "prov_1",
      sessionId: "sa_1",
      surfaceId: "sf_1",
      windowLabel: "a",
      panes: [
        {
          paneId: 41,
          paneLabel: 1,
          paneLineageId: "pl_1",
        },
      ],
    },
    sentAt: Date.now(),
    type: "request",
    v: 1,
  });
  assert.deepEqual(request, { ok: true });

  const response = validateEnvelopeType("authority.state", {
    id: "req_authority_1",
    ok: true,
    op: "authority.state",
    payload: {
      accepted: true,
      reason: null,
    },
    sentAt: Date.now(),
    type: "response",
    v: 1,
  });
  assert.deepEqual(response, { ok: true });
});

test("validateEnvelopeType accepts weighted topology change events", () => {
  const result = validateEnvelopeType("event.topology_changed", {
    eventId: "ev_topology_resize",
    op: "event.topology_changed",
    payload: {
      surfaceId: "sf_1",
      topologyRevision: 2,
      layout: {
        children: [
          { paneId: 1, type: "pane", weight: 1 },
          { paneId: 2, type: "pane", weight: 3 },
        ],
        direction: "vertical",
        type: "split",
      },
      panes: [
        { name: null, paneId: 1, paneLabel: 1 },
        { name: null, paneId: 2, paneLabel: 2 },
      ],
    },
    sentAt: Date.now(),
    type: "event",
    v: 1,
  });

  assert.deepEqual(result, { ok: true });
});

test("validateEnvelopeType rejects pair requests without providerName", () => {
  const result = validateEnvelopeType("pair.request", {
    id: "req_missing_provider_name",
    op: "pair.request",
    payload: {
      connectionId: "cn_1",
      initialPaneId: 1,
      initialPaneLabel: 1,
      protocolVersion: 1,
      providerId: "prov_1",
      surfaceId: "sf_1",
      windowLabel: "a",
    },
    sentAt: Date.now(),
    type: "request",
    v: 1,
  });

  assert.equal(result.ok, false);
});

test("validateEnvelopeType accepts file reload source metadata on content.set", () => {
  const result = validateEnvelopeType("content.set", {
    id: "req_reload_source",
    op: "content.set",
    payload: {
      content: { html: "<p>file</p>" },
      contentId: "ct_11111111",
      contentType: "html",
      historyOwnerToken: "hot_test",
      paneId: 1,
      reloadSource: { kind: "file", path: "/tmp/source.html" },
      revision: 1,
    },
    sentAt: Date.now(),
    type: "request",
    v: 1,
  });

  assert.deepEqual(result, { ok: true });
});

test("manifest covers every spec-defined request, response, and event op", () => {
  const schemaNames = Object.keys(SURF_ACE_PROTOCOL_SCHEMAS).sort();
  const expectedNames = [...new Set([...REQUEST_MESSAGES, ...EVENT_MESSAGES])].sort();

  assert.deepEqual(schemaNames, expectedNames);

  for (const op of REQUEST_MESSAGES) {
    const entry = SURF_ACE_PROTOCOL_SCHEMAS[op];
    assert.ok(entry.request, `${op} request schema missing`);
    assert.ok(entry.response, `${op} response schema missing`);
    assert.ok(entry.errorResponse, `${op} error response schema missing`);
  }

  for (const op of EVENT_MESSAGES) {
    const entry = SURF_ACE_PROTOCOL_SCHEMAS[op];
    assert.ok(entry.event, `${op} event schema missing`);
  }
});

test("authority conformance vector set covers omnibus blocker contracts", () => {
  const vectorsById = new Map(authorityVectorSet.vectors.map((vector) => [vector.id, vector]));
  for (const id of [
    "target-register-quarantine",
    "pair-response-before-commit",
    "same-provider-live-resume-supersedes-after-response",
    "browser-url-visible-history-restart",
    "html-navigation-normalized-browser-url",
    "annotation-mode-freezes-visible-navigation",
    "geometry-from-resolved-snapshot",
    "topology-apply-committed-truth-only",
    "content-apply-strict-revision",
    "ios-user-close-retires-identity",
  ]) {
    const vector = vectorsById.get(id);
    assert.ok(vector, `missing authority vector ${id}`);
    assert.ok(vector.requirements.length > 0, `${id} must name requirement ids`);
    assert.ok(vector.contract.length > 0, `${id} must name the shared contract`);
    assert.ok(vector.expected.length > 0, `${id} must name expected behavior`);
  }
});

test("validateEnvelopeType accepts payloadless list requests and responses", () => {
  const surfacesListRequest = validateEnvelopeType("surfaces.list", {
    id: "req_1",
    op: "surfaces.list",
    sentAt: Date.now(),
    type: "request",
    v: 1,
  });
  assert.deepEqual(surfacesListRequest, { ok: true });

  const surfacesListResponse = validateEnvelopeType("surfaces.list", {
    id: "req_1",
    ok: true,
    op: "surfaces.list",
    payload: {
      surfaces: [
        {
          name: "Surface A",
          paired: false,
          surfaceId: "sf_1",
          viewport: { height: 768, scale: 2, width: 1024 },
        },
      ],
    },
    sentAt: Date.now(),
    type: "response",
    v: 1,
  });
  assert.deepEqual(surfacesListResponse, { ok: true });

  const panesListRequest = validateEnvelopeType("panes.list", {
    id: "req_2",
    op: "panes.list",
    sentAt: Date.now(),
    type: "request",
    v: 1,
  });
  assert.deepEqual(panesListRequest, { ok: true });

  const panesListResponse = validateEnvelopeType("panes.list", {
    id: "req_2",
    ok: true,
    op: "panes.list",
    payload: {
      panes: [
        {
          activeContentId: null,
          contentType: null,
          externalNative: false,
          geometry: {
            contentViewport: { height: 384, width: 1024, x: 0, y: 384 },
            coordinateSpace: "surface_logical",
            geometryRevision: 4,
            paneFrame: { height: 384, width: 1024, x: 0, y: 384 },
            paneId: 1,
            paneInstanceId: "pl_1",
            protocolViewport: {
              coordinateSpace: "protocol_viewport",
              rect: { height: 384, width: 1024, x: 0, y: 384 },
              viewport: { height: 384, scale: 2, width: 1024 },
            },
            safeAreaInsets: { bottom: 0, left: 0, right: 0, top: 0 },
            scale: 2,
            splitSpacingInsets: { bottom: 0, left: 0, right: 0, top: 0 },
            surfaceBounds: { height: 768, width: 1024, x: 0, y: 0 },
            surfaceEpoch: "sf_1:1",
            topologyEpoch: 2,
          },
          name: null,
          paneId: 1,
          paneLabel: 1,
          viewport: { height: 384, scale: 2, width: 1024 },
        },
      ],
    },
    sentAt: Date.now(),
    type: "response",
    v: 1,
  });
  assert.deepEqual(panesListResponse, { ok: true });

  const relinquishRequest = validateEnvelopeType("ownership.relinquish", {
    id: "req_3",
    op: "ownership.relinquish",
    sentAt: Date.now(),
    type: "request",
    v: 1,
  });
  assert.deepEqual(relinquishRequest, { ok: true });

  const pairResponse = validateEnvelopeType("pair.request", {
    id: "req_4",
    ok: true,
    op: "pair.request",
    payload: {
	      capabilities: {
	        contentTypes: ["html"],
	        eventTypes: ["event.drawing_flush"],
	        protocolFeatures: ["authority.state.v1"],
	      },
      eventConfig: {
        activeEvents: ["event.drawing_flush"],
        drawingFlushConfig: {
          idleWindowMs: 8000,
          maxIntervalMs: 30000,
        },
        profile: "minimum_deep",
      },
      limits: {
        maxDrawingFlushBytes: 1024,
        maxFrameBytes: 1024,
        maxMessageBytes: 1024,
        maxStrokePointsPerFlush: 1024,
        maxVisibleTextBytes: 1024,
        resumeGraceMs: 20_000,
      },
      ownershipEpoch: 1,
      resumed: false,
      sessionId: "sa_pair_session",
      state: {
        layout: { paneId: 1, type: "pane" },
        panes: [
          {
            contentType: null,
            currentContentId: null,
            currentRevision: 0,
            paneId: 1,
            paneLineageId: "pl_1",
            paneLabel: 1,
          },
        ],
        topologyRevision: 0,
      },
      surfaceId: "sf_1",
      surfaceName: "Surface A",
      viewport: { height: 768, scale: 2, width: 1024 },
    },
    sentAt: Date.now(),
    type: "response",
    v: 1,
	  });
	  assert.deepEqual(pairResponse, { ok: true });

	  const legacyPairResponseWithoutProtocolFeatures = validateEnvelopeType("pair.request", {
	    id: "req_legacy_pair",
	    ok: true,
	    op: "pair.request",
	    payload: {
	      capabilities: {
	        contentTypes: ["html"],
	        eventTypes: ["event.drawing_flush"],
	      },
	      eventConfig: {
	        activeEvents: ["event.drawing_flush"],
	        drawingFlushConfig: {
	          idleWindowMs: 8000,
	          maxIntervalMs: 30000,
	        },
	        profile: "minimum_deep",
	      },
	      limits: {
	        maxDrawingFlushBytes: 1024,
	        maxFrameBytes: 1024,
	        maxMessageBytes: 1024,
	        maxStrokePointsPerFlush: 1024,
	        maxVisibleTextBytes: 1024,
	        resumeGraceMs: 20_000,
	      },
	      ownershipEpoch: 1,
		      resumed: false,
		      sessionId: "sa_pair_legacy_session",
		      state: {
		        layout: { paneId: 1, type: "pane" },
		        panes: [
		          {
		            contentType: null,
		            currentContentId: null,
	            currentRevision: 0,
	            paneId: 1,
	            paneLineageId: "pl_legacy",
		            paneLabel: 1,
		          },
		        ],
		        topologyRevision: 0,
		      },
	      surfaceId: "sf_legacy",
	      surfaceName: "Legacy Surface",
	      viewport: { height: 768, scale: 2, width: 1024 },
	    },
	    sentAt: Date.now(),
	    type: "response",
	    v: 1,
	  });
	  assert.deepEqual(legacyPairResponseWithoutProtocolFeatures, { ok: true });

	  const emptyPairPanes = validateEnvelopeType("pair.request", {
    id: "req_empty_pair_panes",
    ok: true,
    op: "pair.request",
    payload: {
      capabilities: {
        contentTypes: ["html"],
        eventTypes: ["event.drawing_flush"],
      },
      eventConfig: {
        activeEvents: ["event.drawing_flush"],
        drawingFlushConfig: {
          idleWindowMs: 8000,
          maxIntervalMs: 30000,
        },
        profile: "minimum_deep",
      },
      limits: {
        maxDrawingFlushBytes: 1024,
        maxFrameBytes: 1024,
        maxMessageBytes: 1024,
        maxStrokePointsPerFlush: 1024,
        maxVisibleTextBytes: 1024,
        resumeGraceMs: 20_000,
      },
      ownershipEpoch: 1,
      resumed: false,
      sessionId: "sa_pair_session",
      state: {
        layout: { paneId: 1, type: "pane" },
        panes: [],
        topologyRevision: 0,
      },
      surfaceId: "sf_1",
      surfaceName: "Surface A",
      viewport: { height: 768, scale: 2, width: 1024 },
    },
    sentAt: Date.now(),
    type: "response",
    v: 1,
  });
  assert.equal(emptyPairPanes.ok, false);

  const relinquishResponse = validateEnvelopeType("ownership.relinquish", {
    id: "req_5",
    ok: true,
    op: "ownership.relinquish",
    payload: {
      relinquished: true,
    },
    sentAt: Date.now(),
    type: "response",
    v: 1,
  });
  assert.deepEqual(relinquishResponse, { ok: true });

  const errorResponse = validateEnvelopeType("pair.request", {
    error: {
      code: "internal_error",
      message: "boom",
    },
    id: "req_6",
    ok: false,
    op: "pair.request",
    sentAt: Date.now(),
    type: "response",
    v: 1,
  });
  assert.deepEqual(errorResponse, { ok: true });
});

test("validateEnvelopeType accepts target.apply.result responses", () => {
  const result = validateEnvelopeType("target.apply", {
    id: "req_target",
    ok: true,
    op: "target.apply.result",
    payload: {
      appliedAt: new Date().toISOString(),
      paneLineageId: "pl_1",
      requestId: "tr_1",
      status: "applied",
      targetEpoch: 1,
      targetId: "tg_1",
    },
    sentAt: Date.now(),
    type: "response",
    v: 1,
  });
  assert.deepEqual(result, { ok: true });
});

test("validateEnvelopeType accepts target.apply.result native app proof state", () => {
  const result = validateEnvelopeType("target.apply", {
    id: "req_target",
    ok: true,
    op: "target.apply.result",
    payload: {
      appliedAt: new Date().toISOString(),
      materializedState: {
        authority: {
          ownershipEpoch: 1,
          ownershipSessionId: "sa_1",
          paneLineageId: "pl_1",
          surfaceId: "sf_1",
          targetEpoch: 1,
        },
        nativeHost: "applied",
        nativeTarget: {
          appId: "com.example.App",
          args: ["--new-window"],
          targetKind: "native_app",
        },
        overlayRegions: "applied",
        paneGeometry: {
          coordinateSpace: "compositor_logical",
          geometryRevision: 1,
          height: 100,
          paneInstanceId: "pi_1",
          surfaceEpoch: "se_1",
          topologyEpoch: 1,
          width: 100,
          x: 0,
          y: 0,
        },
        proof: {
          appId: "com.example.App",
          args: ["--new-window"],
          contentId: "tg_1",
          envDigest: "env_digest",
          launchMode: "new_instance",
          paneId: "1",
        },
      },
      paneLineageId: "pl_1",
      requestId: "tr_1",
      status: "applied",
      targetEpoch: 1,
      targetId: "tg_1",
    },
    sentAt: Date.now(),
    type: "response",
    v: 1,
  });
  assert.deepEqual(result, { ok: true });
});

test("validateEnvelopeType rejects compositor fields in target.apply result materializedState", () => {
  const result = validateEnvelopeType("target.apply", {
    id: "req_target",
    ok: true,
    op: "target.apply.result",
    payload: {
      appliedAt: new Date().toISOString(),
      materializedState: {
        nativeHost: "applied",
        overlayRegions: "applied",
        preflightStatusSummary: {
          topologyPaneCount: 1,
        },
      },
      paneLineageId: "pl_1",
      requestId: "tr_1",
      status: "applied",
      targetEpoch: 1,
      targetId: "tg_1",
    },
    sentAt: Date.now(),
    type: "response",
    v: 1,
  });
  assert.deepEqual(result, { ok: false, reason: "unknown_property:preflightStatusSummary" });
});

test("validateEnvelopeType rejects legacy target.apply native materialization payloads", () => {
  const result = validateEnvelopeType("target.apply", {
    id: "req_target_apply",
    op: "target.apply",
    payload: {
      materialization: {
        op: "native_pane.host",
        panes: [{
          geometry: {
            coordinateSpace: "compositor_logical",
            geometryRevision: 1,
            height: 1,
            paneInstanceId: "pl_1",
            surfaceEpoch: "sf_1:1",
            topologyEpoch: 1,
            width: 1,
            x: 0,
            y: 0,
          },
          id: "1",
          revision: 1,
        }],
      },
      ownershipEpoch: 1,
      ownershipSessionId: "sa_1",
      paneLineageId: "pl_1",
      requestId: "tr_1",
      restoreReason: "initial_apply",
      surfaceId: "sf_1",
      targetEpoch: 1,
      targetHeader: {
        payloadSchemaVersion: 1,
        replaySemantics: "launch_equivalent",
        requiredCapabilities: ["target.terminal_app.v1"],
        safeToLogFields: [],
        safetyClass: "process",
        summary: "top",
      },
      targetId: "tg_1",
      targetKind: "terminal_app",
      targetPayload: { args: [], command: "top" },
    },
    sentAt: Date.now(),
    type: "request",
    v: 1,
  });

  assert.deepEqual(result, { ok: false, reason: "unknown_property:materialization" });
});

test("validateEnvelopeType rejects compositor fields in target.apply targetPayload", () => {
  const result = validateEnvelopeType("target.apply", {
    id: "req_target_apply",
    op: "target.apply",
    payload: {
      ownershipEpoch: 1,
      ownershipSessionId: "sa_1",
      paneLineageId: "pl_1",
      requestId: "tr_1",
      restoreReason: "initial_apply",
      surfaceId: "sf_1",
      targetEpoch: 1,
      targetHeader: {
        payloadSchemaVersion: 1,
        replaySemantics: "launch_equivalent",
        requiredCapabilities: ["target.terminal_app.v1"],
        safeToLogFields: [],
        safetyClass: "process",
        summary: "top",
      },
      targetId: "tg_1",
      targetKind: "terminal_app",
      targetPayload: { args: [], command: "top", geometryRevision: 1 },
    },
    sentAt: Date.now(),
    type: "request",
    v: 1,
  });

  assert.deepEqual(result, { ok: false, reason: "forbidden_property:geometryRevision" });
});

test("validateEnvelopeType accepts markdown content set requests", () => {
  const result = validateEnvelopeType("content.set", {
    id: "req_markdown",
    op: "content.set",
    payload: {
      content: { markdown: "# Heading\n\n- one" },
      contentId: "ct_markdown",
      contentType: "markdown",
      historyOwnerToken: "hot_markdown",
      paneId: 1,
      revision: 1,
    },
    sentAt: Date.now(),
    type: "request",
    v: 1,
  });

  assert.deepEqual(result, { ok: true });
});

test("validateEnvelopeType accepts target.register.rejected responses", () => {
  const result = validateEnvelopeType("target.register", {
    id: "req_register",
    ok: true,
    op: "target.register.rejected",
    payload: {
      errorCode: "ownership_epoch_mismatch",
      idempotencyKey: "idem_1",
      message: "target.register ownershipEpoch does not match active ownership",
      status: "rejected",
    },
    sentAt: Date.now(),
    type: "response",
    v: 1,
  });
  assert.deepEqual(result, { ok: true });
});

test("validateEnvelopeType rejects op drift", () => {
  const opMismatch = validateEnvelopeType("pair.request", {
    id: "req_1",
    op: "content.set",
    payload: {},
    sentAt: Date.now(),
    type: "request",
    v: 1,
  });
  assert.deepEqual(opMismatch, { ok: false, reason: "op_mismatch:content.set" });
});

test("validateEnvelopeType rejects unsupported envelope kinds", () => {
  const typeMismatch = validateEnvelopeType("event.drawing_flush", {
    id: "req_1",
    op: "event.drawing_flush",
    payload: {},
    sentAt: Date.now(),
    type: "response",
    v: 1,
  });
  assert.deepEqual(typeMismatch, { ok: false, reason: "type_mismatch:response" });
});

test("validateEnvelopeType requires event ids on current event envelopes", () => {
  const missingEventId = validateEnvelopeType("event.drawing_flush", {
    op: "event.drawing_flush",
    payload: {},
    sentAt: Date.now(),
    type: "event",
    v: 1,
  });
  assert.deepEqual(missingEventId, { ok: false, reason: "event_id_missing" });
});

test("validateEnvelopeType accepts annotation committed events", () => {
  const result = validateEnvelopeType("event.annotation_committed", {
    eventId: "ev_1",
    op: "event.annotation_committed",
    payload: {
      committedAt: Date.now(),
      contentId: "ct_1",
      paneId: 1,
      revision: 2,
    },
    sentAt: Date.now(),
    type: "event",
    v: 1,
  });

  assert.deepEqual(result, { ok: true });
});

test("drawingFlushEventSchema matches the canonical schema bounds", () => {
  const payload = (
    drawingFlushEventSchema as {
      properties: {
        payload: {
          properties: {
            flushReason: { enum: string[] };
            idleWindowMs: { minimum: number };
            maxIntervalMs: { minimum: number };
            strokeCount: { minimum: number };
            pointsCount: { minimum: number };
            strokes: { minItems: number };
          };
        };
      };
    }
  ).properties.payload.properties;

  assert.deepEqual(payload.flushReason.enum, ["idle_window", "max_interval"]);
  assert.equal(payload.idleWindowMs.minimum, 5000);
  assert.equal(payload.maxIntervalMs.minimum, 10000);
  assert.equal(payload.strokeCount.minimum, 1);
  assert.equal(payload.pointsCount.minimum, 1);
  assert.equal(payload.strokes.minItems, 1);
});

test("annotationCommittedEventSchema requires the settlement payload fields", () => {
  const payload = (
    annotationCommittedEventSchema as {
      properties: {
        payload: {
          required: string[];
        };
      };
    }
  ).properties.payload;

  assert.deepEqual(payload.required, ["paneId", "contentId", "revision", "committedAt"]);
});
