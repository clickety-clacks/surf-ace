export const pairRequestSchema = {
  $id: "surf-ace/pair.request",
  type: "object",
  additionalProperties: false,
  required: ["v", "type", "op", "id", "sentAt", "payload"],
  properties: {
    v: { const: 1 },
    type: { const: "request" },
    op: { const: "pair.request" },
    id: { type: "string", pattern: "^[A-Za-z0-9._:-]{1,64}$" },
    sentAt: { type: "integer", minimum: 0 },
    payload: {
      type: "object",
      additionalProperties: false,
      required: ["providerId", "connectionId", "surfaceId", "protocolVersion"],
      properties: {
        providerId: { type: "string", pattern: "^pv_[A-Za-z0-9._:-]{3,64}$" },
        connectionId: { type: "string", pattern: "^cn_[A-Za-z0-9._:-]{3,64}$" },
        surfaceId: { type: "string", pattern: "^sf_[A-Za-z0-9._:-]{3,64}$" },
        providerName: { type: "string" },
        protocolVersion: { const: 1 },
        takeover: { type: "boolean" },
        eventProfile: { enum: ["minimum_deep", "deep_plus_scroll"] },
        drawingFlushConfig: {
          type: "object",
          additionalProperties: false,
          required: ["idleWindowMs", "maxIntervalMs"],
          properties: {
            idleWindowMs: { type: "integer", minimum: 0 },
            maxIntervalMs: { type: "integer", minimum: 0 },
          },
        },
        resume: {
          type: "object",
          additionalProperties: false,
          required: ["sessionId"],
          properties: {
            sessionId: { type: "string", pattern: "^sa_[A-Za-z0-9._:-]{8,128}$" },
          },
        },
      },
    },
  },
} as const;

export const contentSetRequestSchema = {
  $id: "surf-ace/content.set",
  type: "object",
  additionalProperties: false,
  required: ["v", "type", "op", "id", "sentAt", "payload"],
  properties: {
    v: { const: 1 },
    type: { const: "request" },
    op: { const: "content.set" },
    id: { type: "string", pattern: "^[A-Za-z0-9._:-]{1,64}$" },
    sentAt: { type: "integer", minimum: 0 },
    payload: {
      type: "object",
      additionalProperties: false,
      required: ["paneId", "contentId", "revision", "contentType", "content"],
      properties: {
        paneId: { type: "integer", minimum: 1 },
        contentId: { type: "string", pattern: "^ct_[0-9a-f]{8}$" },
        revision: { type: "integer", minimum: 0 },
        contentType: {
          enum: ["html", "image", "pdf", "terminal", "markdown", "video", "canvas"],
        },
        content: {},
        display: {
          type: "object",
          additionalProperties: false,
          properties: {
            interactive: { type: "boolean" },
            scrollable: { type: "boolean" },
            title: { type: "string" },
          },
        },
      },
    },
  },
} as const;

export const snapshotGetRequestSchema = {
  $id: "surf-ace/snapshot.get",
  type: "object",
  additionalProperties: false,
  required: ["v", "type", "op", "id", "sentAt", "payload"],
  properties: {
    v: { const: 1 },
    type: { const: "request" },
    op: { const: "snapshot.get" },
    id: { type: "string", pattern: "^[A-Za-z0-9._:-]{1,64}$" },
    sentAt: { type: "integer", minimum: 0 },
    payload: {
      type: "object",
      additionalProperties: false,
      required: ["paneId"],
      properties: {
        paneId: { type: "integer", minimum: 1 },
        includeVisibleText: { type: "boolean" },
        includeDrawings: { type: "boolean" },
        includeImage: { type: "boolean" },
      },
    },
  },
} as const;

export const pairResponseSchema = {
  $id: "surf-ace/pair.response",
  type: "object",
  additionalProperties: false,
  required: ["v", "type", "op", "id", "ok", "sentAt", "payload"],
  properties: {
    v: { const: 1 },
    type: { const: "response" },
    op: { const: "pair.request" },
    id: { type: "string", pattern: "^[A-Za-z0-9._:-]{1,64}$" },
    ok: { const: true },
    sentAt: { type: "integer", minimum: 0 },
    payload: {
      type: "object",
      additionalProperties: false,
      required: [
        "surfaceId",
        "surfaceName",
        "sessionId",
        "resumed",
        "viewport",
        "capabilities",
        "limits",
        "eventConfig",
        "state",
      ],
      properties: {
        surfaceId: { type: "string", pattern: "^sf_[A-Za-z0-9._:-]{3,64}$" },
        surfaceName: { type: "string" },
        sessionId: { type: "string", pattern: "^sa_[A-Za-z0-9._:-]{8,128}$" },
        resumed: { type: "boolean" },
        viewport: {
          type: "object",
          additionalProperties: false,
          required: ["width", "height", "scale"],
          properties: {
            width: { type: "integer", minimum: 0 },
            height: { type: "integer", minimum: 0 },
            scale: { type: "number", minimum: 1 },
          },
        },
        capabilities: {
          type: "object",
          additionalProperties: false,
          required: ["contentTypes", "eventTypes"],
          properties: {
            contentTypes: { type: "array", items: { type: "string" } },
            eventTypes: { type: "array", items: { type: "string" } },
          },
        },
        limits: {
          type: "object",
          additionalProperties: false,
          required: [
            "maxMessageBytes",
            "maxFrameBytes",
            "maxVisibleTextBytes",
            "maxStrokePointsPerFlush",
            "maxDrawingFlushBytes",
            "resumeGraceMs",
          ],
          properties: {
            maxMessageBytes: { type: "integer", minimum: 1 },
            maxFrameBytes: { type: "integer", minimum: 1 },
            maxVisibleTextBytes: { type: "integer", minimum: 1 },
            maxStrokePointsPerFlush: { type: "integer", minimum: 1 },
            maxDrawingFlushBytes: { type: "integer", minimum: 1 },
            resumeGraceMs: { type: "integer", minimum: 0 },
          },
        },
        eventConfig: {
          type: "object",
          additionalProperties: false,
          required: ["profile", "activeEvents", "drawingFlushConfig"],
          properties: {
            profile: { enum: ["minimum_deep", "deep_plus_scroll"] },
            activeEvents: { type: "array", items: { type: "string" } },
            drawingFlushConfig: {
              type: "object",
              additionalProperties: false,
              required: ["idleWindowMs", "maxIntervalMs"],
              properties: {
                idleWindowMs: { type: "integer", minimum: 0 },
                maxIntervalMs: { type: "integer", minimum: 0 },
              },
            },
          },
        },
        state: {
          type: "object",
          additionalProperties: false,
          required: ["panes"],
          properties: {
            panes: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["paneId", "currentContentId", "currentRevision", "contentType"],
                properties: {
                  paneId: { type: "integer", minimum: 1 },
                  currentContentId: {
                    oneOf: [
                      { type: "string", pattern: "^ct_[0-9a-f]{8}$" },
                      { type: "null" },
                    ],
                  },
                  currentRevision: { type: "integer", minimum: 0 },
                  contentType: {
                    oneOf: [
                      { enum: ["html", "image", "pdf", "terminal", "markdown", "video", "canvas"] },
                      { type: "null" },
                    ],
                  },
                },
              },
            },
          },
        },
      },
    },
  },
} as const;

export const drawingFlushEventSchema = {
  $id: "surf-ace/event.drawing_flush",
  type: "object",
  additionalProperties: false,
  required: ["v", "type", "op", "eventId", "sentAt", "payload"],
  properties: {
    v: { const: 1 },
    type: { const: "event" },
    op: { const: "event.drawing_flush" },
    eventId: { type: "string", pattern: "^ev_[A-Za-z0-9._:-]{3,96}$" },
    sentAt: { type: "integer", minimum: 0 },
    payload: {
      type: "object",
      additionalProperties: false,
      required: [
        "paneId",
        "contentId",
        "revision",
        "flushId",
        "flushReason",
        "firstStrokeAt",
        "lastStrokeAt",
        "idleWindowMs",
        "maxIntervalMs",
        "strokeCount",
        "pointsCount",
        "strokes",
      ],
      properties: {
        paneId: { type: "integer", minimum: 1 },
        contentId: { type: "string", pattern: "^ct_[0-9a-f]{8}$" },
        revision: { type: "integer", minimum: 0 },
        flushId: { type: "string", pattern: "^fl_[A-Za-z0-9._:-]{3,96}$" },
        flushReason: { enum: ["idle_window", "max_interval", "done", "context_switch"] },
        firstStrokeAt: { type: "integer", minimum: 0 },
        lastStrokeAt: { type: "integer", minimum: 0 },
        idleWindowMs: { type: "integer", minimum: 0 },
        maxIntervalMs: { type: "integer", minimum: 0 },
        strokeCount: { type: "integer", minimum: 0 },
        pointsCount: { type: "integer", minimum: 0 },
        strokes: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["strokeId", "points"],
            properties: {
              strokeId: { type: "string", pattern: "^stroke_[0-9a-f]{6,64}$" },
              points: {
                type: "array",
                minItems: 1,
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["x", "y", "timestamp"],
                  properties: {
                    x: { type: "number" },
                    y: { type: "number" },
                    timestamp: { type: "integer", minimum: 0 },
                    pressure: { type: "number" },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
} as const;
