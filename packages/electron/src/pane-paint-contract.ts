// Exact reviewed PR97 schema reference9d90dc5; private implementation, not wire registration.
const schema: Record<string, unknown> = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "Surf Ace pane paint diagnostic v1 contract; not registered in production protocol",
  "oneOf": [
    {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "v": {
          "const": 1
        },
        "type": {
          "const": "request"
        },
        "op": {
          "const": "diagnostics.pane_paint.get"
        },
        "id": {
          "$ref": "#/$defs/RequestId"
        },
        "sentAt": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "payload": {
          "$ref": "#/$defs/RequestPayload"
        }
      },
      "required": [
        "v",
        "type",
        "op",
        "id",
        "sentAt",
        "payload"
      ]
    },
    {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "v": {
          "const": 1
        },
        "type": {
          "const": "response"
        },
        "op": {
          "const": "diagnostics.pane_paint.get"
        },
        "id": {
          "$ref": "#/$defs/RequestId"
        },
        "sentAt": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "ok": {
          "const": true
        },
        "payload": {
          "oneOf": [
            {
              "type": "object",
              "additionalProperties": false,
              "properties": {
                "outcome": {
                  "const": "described"
                },
                "request": {
                  "$ref": "#/$defs/RequestPayload"
                },
                "configuredBudgetMs": {
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 2000
                },
                "expectation": {
                  "$ref": "#/$defs/Expectation"
                },
                "expiresAfterMs": {
                  "const": 5000
                },
                "elapsedMs": {
                  "type": "number",
                  "minimum": 0,
                  "maximum": 9007199254740991
                },
                "atomic": {
                  "const": false
                },
                "paintFreshness": {
                  "const": "not-established"
                },
                "physicalDisplay": {
                  "const": "not-observed"
                }
              },
              "required": [
                "outcome",
                "request",
                "configuredBudgetMs",
                "expectation",
                "expiresAfterMs",
                "elapsedMs",
                "atomic",
                "paintFreshness",
                "physicalDisplay"
              ]
            },
            {
              "type": "object",
              "additionalProperties": false,
              "properties": {
                "outcome": {
                  "const": "observed"
                },
                "request": {
                  "$ref": "#/$defs/RequestPayload"
                },
                "configuredBudgetMs": {
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 2000
                },
                "captures": {
                  "type": "array",
                  "items": {
                    "$ref": "#/$defs/Image"
                  },
                  "minItems": 2,
                  "maxItems": 2
                },
                "checks": {
                  "type": "array",
                  "items": {
                    "$ref": "#/$defs/Read"
                  },
                  "minItems": 6,
                  "maxItems": 6
                },
                "midpointSkewMs": {
                  "type": "number",
                  "minimum": 0,
                  "maximum": 9007199254740991
                },
                "elapsedMs": {
                  "type": "number",
                  "minimum": 0,
                  "maximum": 9007199254740991
                },
                "consistency": {
                  "const": "binding-and-projection-stable-at-observation-checks"
                },
                "atomic": {
                  "const": false
                },
                "paintFreshness": {
                  "const": "not-established"
                },
                "physicalDisplay": {
                  "const": "not-observed"
                }
              },
              "required": [
                "outcome",
                "request",
                "configuredBudgetMs",
                "captures",
                "checks",
                "midpointSkewMs",
                "elapsedMs",
                "consistency",
                "atomic",
                "paintFreshness",
                "physicalDisplay"
              ]
            },
            {
              "type": "object",
              "additionalProperties": false,
              "properties": {
                "outcome": {
                  "const": "refused"
                },
                "request": {
                  "$ref": "#/$defs/RequestPayload"
                },
                "configuredBudgetMs": {
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 2000
                },
                "reason": {
                  "enum": [
                    "unsupported",
                    "unavailable",
                    "stale",
                    "read-failed",
                    "capture-failed",
                    "invalid-image",
                    "timeout",
                    "busy",
                    "transport-limit"
                  ]
                },
                "stage": {
                  "enum": [
                    "admission",
                    "describe",
                    "before",
                    "GUEST:before",
                    "GUEST:capture",
                    "GUEST:png",
                    "GUEST:after",
                    "HOST:before",
                    "HOST:capture",
                    "HOST:png",
                    "HOST:after",
                    "publish"
                  ]
                },
                "captures": {
                  "type": "array",
                  "items": {
                    "$ref": "#/$defs/Image"
                  },
                  "maxItems": 2
                },
                "checks": {
                  "type": "array",
                  "items": {
                    "$ref": "#/$defs/Read"
                  },
                  "maxItems": 6
                },
                "elapsedMs": {
                  "type": "number",
                  "minimum": 0,
                  "maximum": 9007199254740991
                },
                "nativeDrain": {
                  "oneOf": [
                    {
                      "type": "object",
                      "additionalProperties": false,
                      "properties": {
                        "state": {
                          "enum": [
                            "not-required",
                            "pending"
                          ]
                        }
                      },
                      "required": [
                        "state"
                      ]
                    },
                    {
                      "type": "object",
                      "additionalProperties": false,
                      "properties": {
                        "state": {
                          "const": "complete"
                        },
                        "completedOffsetMs": {
                          "type": "number",
                          "minimum": 0,
                          "maximum": 9007199254740991
                        }
                      },
                      "required": [
                        "state",
                        "completedOffsetMs"
                      ]
                    }
                  ]
                },
                "atomic": {
                  "const": false
                },
                "paintFreshness": {
                  "const": "not-established"
                },
                "physicalDisplay": {
                  "const": "not-observed"
                }
              },
              "required": [
                "outcome",
                "request",
                "configuredBudgetMs",
                "reason",
                "stage",
                "captures",
                "checks",
                "elapsedMs",
                "nativeDrain",
                "atomic",
                "paintFreshness",
                "physicalDisplay"
              ]
            }
          ]
        }
      },
      "required": [
        "v",
        "type",
        "op",
        "id",
        "sentAt",
        "ok",
        "payload"
      ]
    }
  ],
  "$defs": {
    "RequestId": {
      "type": "string",
      "pattern": "^[A-Za-z0-9._:-]{1,64}$"
    },
    "SurfaceId": {
      "type": "string",
      "pattern": "^sf_[A-Za-z0-9._:-]{3,64}$"
    },
    "ContentId": {
      "type": "string",
      "pattern": "^ct_[0-9a-f]{8}$"
    },
    "Binding": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "surfaceEpoch": {
          "type": "string",
          "minLength": 1,
          "maxLength": 256
        },
        "windowInstanceId": {
          "type": "string",
          "minLength": 1,
          "maxLength": 256
        },
        "paneLineageId": {
          "type": "string",
          "minLength": 1,
          "maxLength": 256
        },
        "frameInstanceId": {
          "type": "string",
          "minLength": 1,
          "maxLength": 256
        },
        "surfaceId": {
          "$ref": "#/$defs/SurfaceId"
        },
        "contentId": {
          "$ref": "#/$defs/ContentId"
        },
        "hostWebContentsId": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "paneId": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "guestId": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "contentRevision": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "topologyRevision": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "geometryRevision": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "renderGeneration": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "documentGeneration": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "contentType": {
          "enum": [
            "html",
            "browser_url"
          ]
        }
      },
      "required": [
        "surfaceEpoch",
        "windowInstanceId",
        "paneLineageId",
        "frameInstanceId",
        "surfaceId",
        "contentId",
        "hostWebContentsId",
        "paneId",
        "guestId",
        "contentRevision",
        "topologyRevision",
        "geometryRevision",
        "renderGeneration",
        "documentGeneration",
        "contentType"
      ]
    },
    "Rect": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "x": {
          "type": "number"
        },
        "y": {
          "type": "number"
        },
        "width": {
          "type": "number",
          "minimum": 0
        },
        "height": {
          "type": "number",
          "minimum": 0
        }
      },
      "required": [
        "x",
        "y",
        "width",
        "height"
      ]
    },
    "Projection": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "coordinateSpace": {
          "const": "surface-css-px"
        },
        "guestCoordinateSpace": {
          "const": "guest-css-px"
        },
        "hostRect": {
          "$ref": "#/$defs/Rect"
        },
        "clipRect": {
          "$ref": "#/$defs/Rect"
        },
        "guestViewport": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "width": {
              "type": "number",
              "exclusiveMinimum": 0
            },
            "height": {
              "type": "number",
              "exclusiveMinimum": 0
            },
            "scrollX": {
              "type": "number"
            },
            "scrollY": {
              "type": "number"
            }
          },
          "required": [
            "width",
            "height",
            "scrollX",
            "scrollY"
          ]
        },
        "guestToSurface": {
          "type": "array",
          "items": {
            "type": "number"
          },
          "minItems": 6,
          "maxItems": 6
        },
        "devicePixelRatio": {
          "type": "number",
          "exclusiveMinimum": 0
        },
        "scaleMode": {
          "enum": [
            "host-transform",
            "public-terminal-font"
          ]
        },
        "scaleSequence": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "scaleNonce": {
          "type": "string",
          "minLength": 1,
          "maxLength": 256
        },
        "scaleRevision": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "hostVisible": {
          "type": "boolean"
        },
        "opacity": {
          "type": "number",
          "minimum": 0,
          "maximum": 1
        }
      },
      "required": [
        "coordinateSpace",
        "guestCoordinateSpace",
        "hostRect",
        "clipRect",
        "guestViewport",
        "guestToSurface",
        "devicePixelRatio",
        "scaleMode",
        "scaleSequence",
        "scaleNonce",
        "scaleRevision",
        "hostVisible",
        "opacity"
      ]
    },
    "Expectation": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "observationToken": {
          "type": "string",
          "pattern": "^[a-f0-9]{32}$"
        },
        "binding": {
          "$ref": "#/$defs/Binding"
        },
        "projection": {
          "$ref": "#/$defs/Projection"
        }
      },
      "required": [
        "observationToken",
        "binding",
        "projection"
      ]
    },
    "State": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "binding": {
          "$ref": "#/$defs/Binding"
        },
        "projection": {
          "$ref": "#/$defs/Projection"
        },
        "hostAttached": {
          "type": "boolean"
        },
        "guestAttached": {
          "type": "boolean"
        }
      },
      "required": [
        "binding",
        "projection",
        "hostAttached",
        "guestAttached"
      ]
    },
    "Read": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "stage": {
          "enum": [
            "before",
            "GUEST:before",
            "GUEST:after",
            "HOST:before",
            "HOST:after",
            "publish"
          ]
        },
        "receivedOffsetMs": {
          "type": "number",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "state": {
          "oneOf": [
            {
              "$ref": "#/$defs/State"
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "required": [
        "stage",
        "receivedOffsetMs",
        "state"
      ]
    },
    "Image": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "target": {
          "enum": [
            "GUEST",
            "HOST"
          ]
        },
        "binding": {
          "$ref": "#/$defs/Binding"
        },
        "coordinateSpace": {
          "enum": [
            "guest-capture-pixels",
            "host-capture-pixels"
          ]
        },
        "pngBase64": {
          "type": "string",
          "minLength": 44,
          "maxLength": 2796204,
          "pattern": "^[A-Za-z0-9+/]*={0,2}$"
        },
        "sha256": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        },
        "pixelWidth": {
          "type": "integer",
          "minimum": 1,
          "maximum": 8192
        },
        "pixelHeight": {
          "type": "integer",
          "minimum": 1,
          "maximum": 8192
        },
        "startedOffsetMs": {
          "type": "number",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "endedOffsetMs": {
          "type": "number",
          "minimum": 0,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "target",
        "binding",
        "coordinateSpace",
        "pngBase64",
        "sha256",
        "pixelWidth",
        "pixelHeight",
        "startedOffsetMs",
        "endedOffsetMs"
      ]
    },
    "RequestPayload": {
      "oneOf": [
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "action": {
              "const": "describe"
            },
            "surfaceId": {
              "$ref": "#/$defs/SurfaceId"
            },
            "paneId": {
              "type": "integer",
              "minimum": 1,
              "maximum": 9007199254740991
            }
          },
          "required": [
            "action",
            "surfaceId",
            "paneId"
          ]
        },
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "action": {
              "const": "observe"
            },
            "expected": {
              "$ref": "#/$defs/Expectation"
            },
            "timeoutMs": {
              "type": "integer",
              "minimum": 1,
              "maximum": 2000
            }
          },
          "required": [
            "action",
            "expected",
            "timeoutMs"
          ]
        }
      ]
    }
  }
};
function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function check(value: unknown, rule: Record<string, unknown>, depth = 0): boolean {
  if (depth > 40) return false;
  if (typeof rule.$ref === "string") {
    const name = rule.$ref.replace(/^#\/\$defs\//, "");
    const def = (schema.$defs as Record<string, Record<string, unknown>>)[name];
    return Boolean(def) && check(value, def, depth + 1);
  }
  if (Array.isArray(rule.oneOf) && rule.oneOf.filter(r => record(r) && check(value, r, depth + 1)).length !== 1) return false;
  if (Object.hasOwn(rule, "const") && value !== rule.const) return false;
  if (Array.isArray(rule.enum) && !rule.enum.includes(value)) return false;
  if (rule.type === "null") return value === null;
  if (rule.type === "boolean" && typeof value !== "boolean") return false;
  if (rule.type === "string") {
    if (typeof value !== "string") return false;
    const length = Array.from(value).length;
    if (typeof rule.minLength === "number" && length < rule.minLength || typeof rule.maxLength === "number" && length > rule.maxLength) return false;
    if (typeof rule.pattern === "string" && !new RegExp(rule.pattern).test(value)) return false;
  }
  if (rule.type === "number" || rule.type === "integer") {
    if (typeof value !== "number" || !Number.isFinite(value) || rule.type === "integer" && !Number.isInteger(value)) return false;
    if (typeof rule.minimum === "number" && value < rule.minimum || typeof rule.maximum === "number" && value > rule.maximum || typeof rule.exclusiveMinimum === "number" && value <= rule.exclusiveMinimum) return false;
  }
  if (rule.type === "array") {
    if (!Array.isArray(value)) return false;
    if (typeof rule.minItems === "number" && value.length < rule.minItems || typeof rule.maxItems === "number" && value.length > rule.maxItems) return false;
    if (record(rule.items) && !value.every(v => check(v, rule.items as Record<string, unknown>, depth + 1))) return false;
  }
  if (rule.type === "object") {
    if (!record(value)) return false;
    const properties = record(rule.properties) ? rule.properties : {};
    if (Array.isArray(rule.required) && !rule.required.every(k => typeof k === "string" && Object.hasOwn(value, k))) return false;
    for (const [key, v] of Object.entries(value)) {
      if (!Object.hasOwn(properties, key)) { if (rule.additionalProperties === false) return false; }
      else if (!record(properties[key]) || !check(v, properties[key] as Record<string, unknown>, depth + 1)) return false;
    }
  }
  return true;
}
export function validPanePaintMessage(value: unknown): boolean { return check(value, schema); }
export function panePaintSchemaReference(): Record<string, unknown> { return structuredClone(schema); }

/** Semantic receipt fence in addition to schema shape; no fabricated time or partial-stage evidence. */
export function validPanePaintOutcome(reply: unknown, request: unknown): boolean {
  try {
    if (!validPanePaintMessage(reply) || !validPanePaintMessage(request) || !record(reply) || !record(request)
      || reply.type !== "response" || request.type !== "request" || reply.ok !== true || reply.id !== request.id) return false;
    const p = reply.payload as Record<string, any>, q = request.payload as Record<string, any>;
    const same = (a: unknown, b: unknown): boolean => {
      if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => same(v, b[i]));
      if (record(a) || record(b)) return record(a) && record(b) && Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(k => Object.hasOwn(b, k) && same(a[k], b[k]));
      return a === b;
    };
    if (!same(p.request, q) || p.configuredBudgetMs !== (q.timeoutMs ?? 2000)) return false;
    const elapsed = p.elapsedMs, budget = p.configuredBudgetMs;
    if (p.outcome === "described") return q.action === "describe" && elapsed <= budget && p.expectation.binding.surfaceId === q.surfaceId && p.expectation.binding.paneId === q.paneId;
    const reads = ["before", "GUEST:before", "GUEST:after", "HOST:before", "HOST:after", "publish"];
    const counts: Record<string, [number, number, number]> = {
      admission: [0, 0, 0], describe: [0, 0, 0], before: [0, 1, 0], "GUEST:before": [1, 2, 0],
      "GUEST:capture": [2, 2, 0], "GUEST:png": [2, 2, 0], "GUEST:after": [2, 3, 1], "HOST:before": [3, 4, 1],
      "HOST:capture": [4, 4, 1], "HOST:png": [4, 4, 1], "HOST:after": [4, 5, 2], publish: [5, 6, 2],
    };
    const matrix: Record<string, string[]> = {
      unsupported: ["admission"], busy: ["admission"], "transport-limit": ["admission"], stale: ["admission", ...reads],
      unavailable: ["describe", ...reads], "read-failed": ["describe", ...reads], "capture-failed": ["GUEST:capture", "HOST:capture"],
      "invalid-image": ["GUEST:png", "HOST:png"], timeout: Object.keys(counts),
    };
    const checks = p.checks as any[], images = p.captures as any[];
    if (p.outcome === "observed") {
      if (q.action !== "observe" || elapsed > budget || checks.length !== 6 || images.length !== 2) return false;
    } else {
      const range = counts[p.stage];
      if (!range || !matrix[p.reason]?.includes(p.stage) || checks.length < range[0] || checks.length > range[1] || images.length !== range[2]) return false;
      if (p.reason === "timeout" && elapsed < budget) return false;
      if (p.nativeDrain.state === "complete" && p.nativeDrain.completedOffsetMs > elapsed) return false;
      if (q.action === "describe") return ["admission", "describe"].includes(p.stage) && checks.length === 0 && images.length === 0;
      if (p.stage === "describe") return false;
    }
    let last = 0;
    for (let i = 0; i < checks.length; i++) {
      const c = checks[i];
      if (c.stage !== reads[i] || c.receivedOffsetMs < last || c.receivedOffsetMs > elapsed) return false;
      last = c.receivedOffsetMs;
      // Only the final refusal read may contain changed/unavailable authority.
      if (p.outcome === "observed" || c.stage !== p.stage) {
        if (!c.state?.hostAttached || !c.state?.guestAttached || !same(c.state.binding, q.expected.binding) || !same(c.state.projection, q.expected.projection)) return false;
      }
    }
    for (let i = 0; i < images.length; i++) {
      const image = images[i], target = i === 0 ? "GUEST" : "HOST";
      const before = checks.find(c => c.stage === target + ":before"), after = checks.find(c => c.stage === target + ":after");
      if (image.target !== target || !same(image.binding, q.expected.binding) || image.startedOffsetMs > image.endedOffsetMs
        || image.endedOffsetMs > Math.min(elapsed, budget) || !before || before.receivedOffsetMs > image.startedOffsetMs
        || (after && image.endedOffsetMs > after.receivedOffsetMs)) return false;
      if (i && (!checks[2] || images[0].endedOffsetMs > checks[2].receivedOffsetMs || checks[2].receivedOffsetMs > before.receivedOffsetMs)) return false;
    }
    if (p.outcome === "observed" && p.midpointSkewMs !== (images[1].startedOffsetMs + images[1].endedOffsetMs - images[0].startedOffsetMs - images[0].endedOffsetMs) / 2) return false;
    return true;
  } catch { return false; }
}
