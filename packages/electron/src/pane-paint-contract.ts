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
