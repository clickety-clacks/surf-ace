import assert from "node:assert/strict";
import test from "node:test";

/*
 * Reference model for DESIGN §§3.1.3, 3.1.4, and 6.0.1 only.
 * It imports no production wire/client/registry code and does not claim that
 * endpoint leases or surface.describe are implemented.
 */

type RegistryIdentity = { fleetId: string; allocatorId: string };
type EndpointLease = {
  leaseGeneration: number;
  registrationObservedAtMs: number;
  leaseExpiresAtMs: number;
};
type SurfaceRegistration = { surfaceId: string; windowLabel: string };
type RegisteredClient = {
  clientId: string;
  directEndpoint: string | null;
  prePairDescribeV1: boolean;
  endpointLease: EndpointLease | null;
  surfaces: SurfaceRegistration[];
};
type RegistryTopology = {
  registryIdentity: RegistryIdentity;
  registryServerTimeMs: number;
  maxEndpointLeaseMs: number;
  clients: RegisteredClient[];
};

const registryUrl = "ws://registry.test:9100/ws";
const endpointUrl = "ws://surface.test:9200/ws";
const clientId = "a".repeat(64);
const identity = { fleetId: "fleet-test", allocatorId: "allocator-test" };
const selectedSurface = { surfaceId: "sf_alpha", windowLabel: "a" };

function registry(overrides: Partial<RegistryTopology> = {}): RegistryTopology {
  return {
    registryIdentity: { ...identity },
    registryServerTimeMs: 10_000,
    maxEndpointLeaseMs: 30_000,
    clients: [
      {
        clientId,
        directEndpoint: endpointUrl,
        prePairDescribeV1: true,
        endpointLease: {
          leaseGeneration: 4,
          registrationObservedAtMs: 9_000,
          leaseExpiresAtMs: 19_000,
        },
        surfaces: [{ ...selectedSurface }],
      },
    ],
    ...overrides,
  };
}

function pane(paneId: number, paneLabel: number | null, revision: number | null) {
  return {
    paneId,
    paneLabel,
    contentObservation: {
      revision,
      source: "client-authority",
      observedAtMs: 9_950 + paneId,
    },
  };
}

function describeResponse(overrides: Record<string, unknown> = {}) {
  return {
    v: 1,
    type: "response",
    id: "request-1",
    op: "surface.describe",
    ok: true,
    payload: {
      nonce: "0123456789abcdef0123456789abcdef",
      clientId,
      registryIdentity: { ...identity },
      surfaceId: selectedSurface.surfaceId,
      endpointLeaseGeneration: 4,
      observedAtMs: 9_990,
      applicationReadiness: { status: "ready", limitationCodes: [] },
      surfaceSetRevision: 3,
      topologyRevision: 8,
      layout: {
        type: "split",
        direction: "vertical",
        children: [
          { type: "pane", paneId: 1 },
          { type: "pane", paneId: 2 },
        ],
      },
      panes: [pane(1, 7, 22), pane(2, null, null)],
    },
    ...overrides,
  };
}

function currentLease(snapshot: RegistryTopology, row: RegisteredClient): boolean {
  const lease = row.endpointLease;
  return lease !== null
    && Number.isSafeInteger(lease.leaseGeneration)
    && lease.leaseGeneration > 0
    && Number.isSafeInteger(lease.registrationObservedAtMs)
    && Number.isSafeInteger(lease.leaseExpiresAtMs)
    && lease.registrationObservedAtMs <= snapshot.registryServerTimeMs
    && lease.leaseExpiresAtMs > snapshot.registryServerTimeMs
    && lease.leaseExpiresAtMs > lease.registrationObservedAtMs
    && lease.leaseExpiresAtMs - snapshot.registryServerTimeMs <= snapshot.maxEndpointLeaseMs;
}

function endpointIsConfigured(value: string | null, registryAddress: string): boolean {
  if (value === null) return false;
  try {
    const endpoint = new URL(value);
    const registry = new URL(registryAddress);
    return (endpoint.protocol === "ws:" || endpoint.protocol === "wss:")
      && endpoint.hostname !== ""
      && endpoint.username === ""
      && endpoint.password === ""
      && endpoint.href !== registry.href;
  } catch {
    return false;
  }
}

function select(
  snapshot: RegistryTopology | null,
  label: string,
  registryAddress: string,
): { status: string; row?: RegisteredClient; registryIdentity?: RegistryIdentity } {
  if (snapshot === null) return { status: "registry_unavailable" };
  if (!snapshot.registryIdentity?.fleetId || !snapshot.registryIdentity?.allocatorId
      || !Number.isSafeInteger(snapshot.registryServerTimeMs)
      || !Number.isSafeInteger(snapshot.maxEndpointLeaseMs)
      || snapshot.maxEndpointLeaseMs <= 0) {
    return { status: "unsupported_protocol" };
  }

  const matches = snapshot.clients.flatMap((row) =>
    row.surfaces
      .filter((surface) => surface.windowLabel === label)
      .map((surface) => ({ row, surface })));
  const current = matches.filter(({ row }) => currentLease(snapshot, row));
  if (current.length === 0) {
    return { status: matches.length > 0 ? "stale_registration" : "not_found" };
  }
  if (current.length > 1) return { status: "ambiguous" };

  const { row, surface } = current[0]!;
  if (!endpointIsConfigured(row.directEndpoint, registryAddress)) {
    return { status: "endpoint_unconfigured" };
  }
  if (row.prePairDescribeV1 !== true) return { status: "unsupported_protocol" };
  if (!surface.surfaceId || !row.clientId) return { status: "unsupported_protocol" };
  return {
    status: "selected",
    row: { ...row, surfaces: [{ ...surface }] },
    registryIdentity: { ...snapshot.registryIdentity },
  };
}

function buildDescribeRequest(
  selected: { row: RegisteredClient; registryIdentity: RegistryIdentity },
  requestId: string,
  nonce: string,
) {
  return {
    v: 1,
    type: "request",
    id: requestId,
    op: "surface.describe",
    payload: {
      clientId: selected.row.clientId,
      registryIdentity: selected.registryIdentity,
      surfaceId: selected.row.surfaces[0]!.surfaceId,
      endpointLeaseGeneration: selected.row.endpointLease!.leaseGeneration,
      nonce,
    },
  };
}

function layoutPaneIds(node: any): number[] | null {
  if (!node || typeof node !== "object") return null;
  if (node.type === "pane") {
    return Number.isSafeInteger(node.paneId) && node.paneId > 0 ? [node.paneId] : null;
  }
  if (node.type !== "split" || !["horizontal", "vertical"].includes(node.direction)
      || !Array.isArray(node.children) || node.children.length < 2) {
    return null;
  }
  const children = node.children.map(layoutPaneIds);
  if (children.some((ids: number[] | null) => ids === null)) return null;
  return children.flat() as number[];
}

function hasForbiddenContent(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, child]) =>
    ["content", "contentBody", "url", "image", "snapshot", "annotationPayload", "historyBody"].includes(key)
      || hasForbiddenContent(child));
}

function hasExactKeys(value: unknown, expected: string[]): boolean {
  return value !== null && typeof value === "object"
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function fail(
  status: string,
  operations: string[],
  transportReachability = "not_attempted",
  applicationReadiness = "unknown",
  identityConsistency = "unknown",
) {
  return {
    status,
    operations,
    writes: [],
    transportReachability,
    applicationReadiness,
    identityConsistency,
  };
}

function discover(input: {
  label: string;
  before: RegistryTopology | null;
  after: RegistryTopology | null;
  registryAddress?: string;
  transport: "reachable" | "unreachable";
  response: any | null;
  requestId?: string;
  nonce?: string;
}) {
  const requestId = input.requestId ?? "request-1";
  const nonce = input.nonce ?? "0123456789abcdef0123456789abcdef";
  const address = input.registryAddress ?? registryUrl;
  const operations = ["fleet.topology"];
  const initial = select(input.before, input.label, address);
  if (initial.status !== "selected" || !initial.row || !initial.registryIdentity) {
    return fail(initial.status, operations);
  }

  const request = buildDescribeRequest(initial as {
    row: RegisteredClient;
    registryIdentity: RegistryIdentity;
  }, requestId, nonce);
  if (!/^[0-9a-f]{32}$/.test(nonce)) {
    return fail("invalid_payload", operations);
  }
  operations.push(request.op);
  if (input.transport === "unreachable") {
    return fail("unreachable", operations, "unreachable");
  }
  if (input.response === null) {
    return fail("application_unresponsive", operations, "reachable");
  }

  const response = input.response;
  if (response.v !== 1 || response.type !== "response" || response.op !== "surface.describe") {
    return fail("unsupported_protocol", operations, "reachable");
  }
  if (response.id !== requestId) {
    return fail("stale_response", operations, "reachable");
  }
  if (response.ok !== true) {
    const errorCode = response.error?.code;
    if (["identity_mismatch", "revision_churn", "not_ready", "surface_not_found",
      "prepair_describe_unsupported"].includes(errorCode)) {
      return fail(errorCode, operations, "reachable",
        errorCode === "not_ready" ? "not_ready" : "unknown",
        errorCode === "identity_mismatch" ? "mismatch" : "unknown");
    }
    return fail("unsupported_protocol", operations, "reachable");
  }

  const payload = response.payload;
  if (!payload || typeof payload !== "object" || payload.nonce !== nonce) {
    return fail("stale_response", operations, "reachable");
  }
  const selectedRow = initial.row;
  const selectedIdentity = initial.registryIdentity;
  const selectedSurface = selectedRow.surfaces[0]!;
  if (payload.clientId !== selectedRow.clientId
      || payload.registryIdentity?.fleetId !== selectedIdentity.fleetId
      || payload.registryIdentity?.allocatorId !== selectedIdentity.allocatorId
      || payload.surfaceId !== selectedSurface.surfaceId
      || payload.endpointLeaseGeneration !== selectedRow.endpointLease?.leaseGeneration) {
    return fail("identity_mismatch", operations, "reachable", "unknown", "mismatch");
  }

  const readiness = payload.applicationReadiness;
  if (!readiness || !["ready", "degraded"].includes(readiness.status)
      || !Array.isArray(readiness.limitationCodes)
      || (readiness.status === "ready" && readiness.limitationCodes.length !== 0)
      || (readiness.status === "degraded" && readiness.limitationCodes.length === 0)) {
    return fail("unsupported_protocol", operations, "reachable");
  }
  if (hasForbiddenContent(payload)) {
    return fail("unsupported_protocol", operations, "reachable", readiness.status, "matched");
  }
  if (!Number.isSafeInteger(payload.observedAtMs) || payload.observedAtMs < 0
      || !Number.isSafeInteger(payload.surfaceSetRevision) || payload.surfaceSetRevision < 0
      || !Number.isSafeInteger(payload.topologyRevision) || payload.topologyRevision < 0
      || !Array.isArray(payload.panes) || payload.panes.length === 0) {
    return fail("unsupported_protocol", operations, "reachable", readiness.status, "matched");
  }

  const paneIds = payload.panes.map((item: any) => item?.paneId);
  const layoutIds = layoutPaneIds(payload.layout);
  const paneIdsValid = payload.panes.every((item: any) =>
    hasExactKeys(item, ["paneId", "paneLabel", "contentObservation"])
      && hasExactKeys(item.contentObservation, ["revision", "source", "observedAtMs"])
      && Number.isSafeInteger(item.paneId) && item.paneId > 0
      && (item.paneLabel === null || (Number.isSafeInteger(item.paneLabel) && item.paneLabel > 0))
      && item.contentObservation
      && (item.contentObservation.revision === null
        || (Number.isSafeInteger(item.contentObservation.revision) && item.contentObservation.revision >= 0))
      && item.contentObservation.source === "client-authority"
      && Number.isSafeInteger(item.contentObservation.observedAtMs)
      && item.contentObservation.observedAtMs >= 0);
  if (!paneIdsValid || new Set(paneIds).size !== paneIds.length
      || layoutIds === null || new Set(layoutIds).size !== layoutIds.length
      || JSON.stringify([...paneIds].sort()) !== JSON.stringify([...layoutIds].sort())) {
    return fail("unsupported_protocol", operations, "reachable", readiness.status, "matched");
  }

  operations.push("fleet.topology");
  const final = select(input.after, input.label, address);
  if (final.status !== "selected" || !final.row || !final.registryIdentity) {
    return fail(final.status === "not_found" ? "stale_registration" : final.status,
      operations, "reachable", readiness.status, "matched");
  }
  const finalSurface = final.row.surfaces[0]!;
  if (final.registryIdentity.fleetId !== selectedIdentity.fleetId
      || final.registryIdentity.allocatorId !== selectedIdentity.allocatorId
      || final.row.clientId !== selectedRow.clientId
      || final.row.directEndpoint !== selectedRow.directEndpoint
      || final.row.endpointLease?.leaseGeneration !== selectedRow.endpointLease?.leaseGeneration
      || finalSurface.surfaceId !== selectedSurface.surfaceId
      || finalSurface.windowLabel !== selectedSurface.windowLabel) {
    return fail("stale_registration", operations, "reachable", readiness.status, "matched");
  }

  return {
    status: readiness.status === "ready" ? "current" : "degraded",
    operations,
    writes: [],
    transportReachability: "reachable",
    applicationReadiness: readiness.status,
    identityConsistency: "matched",
    authenticated: false,
    registryServerTimeMs: input.after!.registryServerTimeMs,
    registrationAgeMs: input.after!.registryServerTimeMs
      - final.row.endpointLease!.registrationObservedAtMs,
    leaseExpiresAtMs: final.row.endpointLease!.leaseExpiresAtMs,
    surfaceSetRevision: payload.surfaceSetRevision,
    topologyRevision: payload.topologyRevision,
    layout: payload.layout,
    panes: payload.panes,
  };
}

function validInput(overrides: Record<string, unknown> = {}) {
  return {
    label: "a",
    before: registry(),
    after: registry(),
    transport: "reachable" as const,
    response: describeResponse(),
    ...overrides,
  };
}

test("current unique lease plus nonce-bound pre-pair describe returns separate evidence", () => {
  const input = validInput();
  const before = structuredClone(input);
  const output = discover(input as any);
  assert.equal(output.status, "current");
  assert.equal(output.transportReachability, "reachable");
  assert.equal(output.applicationReadiness, "ready");
  assert.equal(output.identityConsistency, "matched");
  assert.equal(output.authenticated, false);
  assert.equal(output.registrationAgeMs, 1_000);
  assert.deepEqual(output.operations, ["fleet.topology", "surface.describe", "fleet.topology"]);
  assert.deepEqual(output.writes, []);
  assert.deepEqual(input, before);
});

test("request shape has no pair, controller admission, or registry mutation fields", () => {
  const selection = select(registry(), "a", registryUrl);
  assert.equal(selection.status, "selected");
  const request = buildDescribeRequest(selection as any, "request-1", "0123456789abcdef0123456789abcdef");
  assert.equal(request.op, "surface.describe");
  assert.deepEqual(Object.keys(request.payload).sort(), [
    "clientId",
    "endpointLeaseGeneration",
    "nonce",
    "registryIdentity",
    "surfaceId",
  ]);
  assert.equal(request.payload.clientId, clientId);
  assert.equal(request.payload.endpointLeaseGeneration, 4);
  assert.equal(/^[0-9a-f]{32}$/.test(request.payload.nonce), true);
});

test("renewal horizon is measured from registry server time while generation age remains visible", () => {
  const renewed = registry({
    registryServerTimeMs: 10_000,
    maxEndpointLeaseMs: 10_000,
    clients: [{
      ...registry().clients[0]!,
      endpointLease: {
        leaseGeneration: 4,
        registrationObservedAtMs: 1_000,
        leaseExpiresAtMs: 20_000,
      },
    }],
  });
  const output = discover(validInput({ before: renewed, after: renewed }) as any);
  assert.equal(output.status, "current");
  assert.equal(output.registrationAgeMs, 9_000);
  assert.equal(output.leaseExpiresAtMs, 20_000);
});

test("future registration time and leases beyond the current bounded horizon are stale", () => {
  const futureRegistration = registry({
    clients: [{
      ...registry().clients[0]!,
      endpointLease: {
        leaseGeneration: 4,
        registrationObservedAtMs: 10_001,
        leaseExpiresAtMs: 19_000,
      },
    }],
  });
  const overHorizon = registry({ maxEndpointLeaseMs: 8_999 });
  for (const invalid of [futureRegistration, overHorizon]) {
    const output = discover(validInput({ before: invalid, after: invalid }) as any);
    assert.equal(output.status, "stale_registration");
    assert.deepEqual(output.operations, ["fleet.topology"]);
  }
});

test("missing, expired, and unbounded leases fail before direct connect", () => {
  const noLease = registry({ clients: [{ ...registry().clients[0]!, endpointLease: null }] });
  assert.equal(discover(validInput({ before: noLease, after: noLease }) as any).status,
    "stale_registration");

  const expired = registry({
    registryServerTimeMs: 20_000,
    clients: registry().clients,
  });
  assert.equal(discover(validInput({ before: expired, after: expired }) as any).status,
    "stale_registration");

  const tooLong = registry({
    maxEndpointLeaseMs: 100,
    clients: registry().clients,
  });
  assert.equal(discover(validInput({ before: tooLong, after: tooLong }) as any).status,
    "stale_registration");
  assert.deepEqual(discover(validInput({ before: expired, after: expired }) as any).operations,
    ["fleet.topology"]);
});

test("missing endpoint, unsupported capability, and registry URL substitution fail closed", () => {
  const current = registry();
  const missing = registry({
    clients: [{ ...current.clients[0]!, directEndpoint: null }],
  });
  assert.equal(discover(validInput({ before: missing, after: missing }) as any).status,
    "endpoint_unconfigured");

  const unsupported = registry({
    clients: [{ ...current.clients[0]!, prePairDescribeV1: false }],
  });
  assert.equal(discover(validInput({ before: unsupported, after: unsupported }) as any).status,
    "unsupported_protocol");

  const substituted = registry({
    clients: [{ ...current.clients[0]!, directEndpoint: registryUrl }],
  });
  assert.equal(discover(validInput({ before: substituted, after: substituted }) as any).status,
    "endpoint_unconfigured");
});

test("zero and duplicate current window matches are explicit and never probed", () => {
  const empty = registry({ clients: [] });
  const notFound = discover(validInput({ before: empty, after: empty }) as any);
  assert.equal(notFound.status, "not_found");
  assert.deepEqual(notFound.operations, ["fleet.topology"]);

  const original = registry().clients[0]!;
  const duplicate = registry({
    clients: [
      original,
      { ...structuredClone(original), clientId: "b".repeat(64), surfaces: [{ ...selectedSurface, surfaceId: "sf_beta" }] },
    ],
  });
  const ambiguous = discover(validInput({ before: duplicate, after: duplicate }) as any);
  assert.equal(ambiguous.status, "ambiguous");
  assert.deepEqual(ambiguous.operations, ["fleet.topology"]);
});

test("unreachable transport and unresponsive application are distinct", () => {
  const unreachable = discover(validInput({ transport: "unreachable", response: null }) as any);
  assert.equal(unreachable.status, "unreachable");
  assert.equal(unreachable.transportReachability, "unreachable");
  assert.equal(unreachable.applicationReadiness, "unknown");

  const unresponsive = discover(validInput({ response: null }) as any);
  assert.equal(unresponsive.status, "application_unresponsive");
  assert.equal(unresponsive.transportReachability, "reachable");
  assert.equal(unresponsive.applicationReadiness, "unknown");
});

test("client, registry, surface, and lease mismatches are not authenticated or selected", () => {
  const cases = [
    { clientId: "b".repeat(64) },
    { registryIdentity: { fleetId: "foreign", allocatorId: identity.allocatorId } },
    { registryIdentity: { fleetId: identity.fleetId, allocatorId: "foreign" } },
    { surfaceId: "sf_other" },
    { endpointLeaseGeneration: 5 },
  ];
  for (const fields of cases) {
    const response = describeResponse({
      payload: { ...describeResponse().payload, ...fields },
    });
    const output = discover(validInput({ response }) as any);
    assert.equal(output.status, "identity_mismatch");
    assert.equal(output.identityConsistency, "mismatch");
    assert.equal(output.authenticated, undefined);
  }
});

test("request id and nonce bind one response and reject cached or cross-request replies", () => {
  const wrongId = discover(validInput({
    response: describeResponse({ id: "old-request" }),
  }) as any);
  assert.equal(wrongId.status, "stale_response");

  const wrongNonce = discover(validInput({
    response: describeResponse({
      payload: { ...describeResponse().payload, nonce: "old-nonce" },
    }),
  }) as any);
  assert.equal(wrongNonce.status, "stale_response");

  const shortNonce = discover(validInput({ nonce: "abcd" }) as any);
  assert.equal(shortNonce.status, "invalid_payload");
  assert.deepEqual(shortNonce.operations, ["fleet.topology"]);
});

test("registry lease replacement or expiry during the probe invalidates the result", () => {
  const changed = registry({
    clients: [{
      ...registry().clients[0]!,
      endpointLease: {
        leaseGeneration: 5,
        registrationObservedAtMs: 10_001,
        leaseExpiresAtMs: 20_000,
      },
    }],
  });
  assert.equal(discover(validInput({ after: changed }) as any).status, "stale_registration");

  const expiredAfter = registry({
    registryServerTimeMs: 19_000,
    clients: registry().clients,
  });
  assert.equal(discover(validInput({ after: expiredAfter }) as any).status, "stale_registration");
});

test("revision churn is a refusal with no partial topology", () => {
  const response = {
    v: 1,
    type: "response",
    id: "request-1",
    op: "surface.describe",
    ok: false,
    error: { code: "revision_churn" },
  };
  const output = discover(validInput({ response }) as any);
  assert.equal(output.status, "revision_churn");
  assert.equal("panes" in output, false);
});

test("layout mismatch, missing pane provenance, and nested body/image output are refused", () => {
  const base = describeResponse();
  const wrongLayout = describeResponse({
    payload: { ...base.payload, layout: { type: "pane", paneId: 1 } },
  });
  assert.equal(discover(validInput({ response: wrongLayout }) as any).status,
    "unsupported_protocol");

  const missingProvenance = describeResponse({
    payload: {
      ...base.payload,
      panes: [pane(1, 7, 22), { ...pane(2, null, null), contentObservation: { revision: null } }],
    },
  });
  assert.equal(discover(validInput({ response: missingProvenance }) as any).status,
    "unsupported_protocol");

  const withBody = describeResponse({
    payload: {
      ...base.payload,
      panes: [pane(1, 7, 22), {
        ...pane(2, null, null),
        content: { html: "<p>must not be returned</p>" },
      }],
    },
  });
  assert.equal(discover(validInput({ response: withBody }) as any).status,
    "unsupported_protocol");
});

test("degraded readiness remains distinct from reachable transport and current topology", () => {
  const base = describeResponse();
  const response = describeResponse({
    payload: {
      ...base.payload,
      applicationReadiness: { status: "degraded", limitationCodes: ["allocator_unavailable"] },
    },
  });
  const output = discover(validInput({ response }) as any);
  assert.equal(output.status, "degraded");
  assert.equal(output.transportReachability, "reachable");
  assert.equal(output.applicationReadiness, "degraded");
  assert.equal(output.topologyRevision, 8);
});

test("transport success cannot infer application readiness when response version is unsupported", () => {
  const output = discover(validInput({
    response: describeResponse({ v: 2 }),
  }) as any);
  assert.equal(output.status, "unsupported_protocol");
  assert.equal(output.transportReachability, "reachable");
  assert.equal(output.applicationReadiness, "unknown");
});
