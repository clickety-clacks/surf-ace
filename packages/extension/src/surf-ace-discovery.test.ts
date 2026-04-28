import assert from "node:assert/strict";
import test from "node:test";
import type { SurfAceDiscoveryEndpoint } from "./surf-ace-discovery.js";
import { __test } from "./surf-ace-discovery.js";

function endpoint(params?: Partial<SurfAceDiscoveryEndpoint>): SurfAceDiscoveryEndpoint {
  return {
    busy: false,
    capabilitiesBitmask: 31,
    endpointId: "emanator.local:19001/ws",
    fingerprintPrefix: "e305802b",
    host: "emanator.local",
    instanceName: "Emanator Surf Ace",
    lastSeenAt: 1234,
    name: "Emanator",
    port: 19001,
    protocolVersion: 1,
    viewport: {
      height: 1024,
      scale: 2,
      width: 768,
    },
    wsPath: "/ws",
    ...params,
  };
}

test("discoveryDiagnostic formats concise structured fields", () => {
  assert.equal(
    __test.discoveryDiagnostic("reconcile", {
      adopted_count: 1,
      endpoint_id: "eezo.local:19001/ws",
      note: "name changed",
      skipped: undefined,
    }),
    '[surf-ace:discovery] event=reconcile adopted_count=1 endpoint_id=eezo.local:19001/ws note="name changed"',
  );
});

test("parseDnsSdBrowseOutput decodes instance names", () => {
  const output = `Browsing for _surf-ace._tcp.local.
DATE: ---Sat 21 Mar 2026---
 9:31:11.907  Add        3   1 local.               _surf-ace._tcp.      Surf Ace - iPad Pro 13-inch (M5)
 9:31:12.046  Add        2  15 local.               _surf-ace._tcp.      eezo Surf Ace (eezo)
`;

  assert.deepEqual(__test.parseDnsSdBrowseOutput(output), [
    "Surf Ace - iPad Pro 13-inch (M5)",
    "eezo Surf Ace (eezo)",
  ]);
});

test("parseDnsSdLookupOutput resolves host, port, and txt payload", () => {
  const output = `Lookup Surf\\032Ace\\032-\\032iPad\\032Pro\\03213-inch\\032(M5)._surf-ace._tcp.local.
DATE: ---Sat 21 Mar 2026---
 9:36:04.926  Surf\\032Ace\\032-\\032iPad\\032Pro\\03213-inch\\032(M5)._surf-ace._tcp.local. can be reached at eezo.local.:55386 (interface 15) Flags: 1
 s=2.0 h=1024 tls=0 cap=31 w=768 pk=e305802b name=Surf\\ Ace\\ -\\ iPad\\ Pro\\ 13-inch\\ \\(M5\\) busy=1 ws=/ws v=1
`;

  const endpoint = __test.parseDnsSdLookupOutput(
    "Surf Ace - iPad Pro 13-inch (M5)",
    output,
    () => 1234,
  );

  assert.deepEqual(endpoint, {
    busy: true,
    capabilitiesBitmask: 31,
    endpointId: "eezo.local:55386/ws#e305802b",
    fingerprintPrefix: "e305802b",
    host: "eezo.local",
    instanceName: "Surf Ace - iPad Pro 13-inch (M5)",
    lastSeenAt: 1234,
    name: "Surf Ace - iPad Pro 13-inch (M5)",
    port: 55386,
    protocolVersion: 1,
    viewport: {
      height: 1024,
      scale: 2,
      width: 768,
    },
    wsPath: "/ws",
  });
});

test("parseDnsSdLookupOutput gives same host and port distinct service identities", () => {
  const electron = __test.parseDnsSdLookupOutput(
    "eezo Surf Ace (eezo)",
    `Lookup eezo\\032Surf\\032Ace\\032\\(eezo\\)._surf-ace._tcp.local.
DATE: ---Mon 27 Apr 2026---
 21:52:00.000  eezo\\032Surf\\032Ace\\032\\(eezo\\)._surf-ace._tcp.local. can be reached at eezo.local.:19001 (interface 15) Flags: 1
 s=1 h=1410 tls=0 cap=31 w=5120 pk=b0ddd36d name=eezo\\ Surf\\ Ace busy=1 ws=/ws v=1
`,
    () => 1234,
  );
  const simulator = __test.parseDnsSdLookupOutput(
    "Surf Ace - iPad Pro 13-inch (M5) (eezo)",
    `Lookup Surf\\032Ace\\032-\\032iPad\\032Pro\\03213-inch\\032\\(M5\\)\\032\\(eezo\\)._surf-ace._tcp.local.
DATE: ---Mon 27 Apr 2026---
 21:52:00.000  Surf\\032Ace\\032-\\032iPad\\032Pro\\03213-inch\\032\\(M5\\)\\032\\(eezo\\)._surf-ace._tcp.local. can be reached at eezo.local.:19001 (interface 15) Flags: 1
 s=2 h=1024 tls=0 cap=31 w=768 pk=2bb97f09 name=Surf\\ Ace\\ -\\ iPad\\ Pro\\ 13-inch\\ \\(M5\\)\\ \\(eezo\\) busy=0 ws=/ws v=1
`,
    () => 1234,
  );

  assert.ok(electron);
  assert.ok(simulator);
  assert.equal(electron.host, "eezo.local");
  assert.equal(simulator.host, "eezo.local");
  assert.equal(electron.port, simulator.port);
  assert.notEqual(electron.endpointId, simulator.endpointId);
  assert.equal(electron.endpointId, "eezo.local:19001/ws#b0ddd36d");
  assert.equal(simulator.endpointId, "eezo.local:19001/ws#2bb97f09");
});

test("refreshNow clears stale endpoints when a full refresh returns no advertisements", async () => {
  const discovery = new __test.BonjourSurfAceDiscoveryService({
    logger: {},
    now: () => 1234,
  }) as any;
  const notifications: SurfAceDiscoveryEndpoint[][] = [];
  discovery.subscribe((endpoints: SurfAceDiscoveryEndpoint[]) => {
    notifications.push(endpoints);
  });
  discovery.started = true;
  discovery.browser = { update() {} };
  discovery.snapshot.set("emanator.local:19001/ws", endpoint());
  discovery.queryCurrentEndpoints = async () => [];

  await discovery.refreshNow();

  assert.deepEqual(discovery.getSnapshot(), []);
  assert.deepEqual(notifications, [[]]);
});

test("refreshNow removes endpoints missing from the refreshed snapshot", async () => {
  const discovery = new __test.BonjourSurfAceDiscoveryService({
    logger: {},
    now: () => 1234,
  }) as any;
  const retained = endpoint({ endpointId: "emanator.local:19001/ws", instanceName: "Emanator Surf Ace" });
  const stale = endpoint({
    endpointId: "emanator.local:29001/ws",
    fingerprintPrefix: "deadbeef",
    host: "emanator.local",
    instanceName: "Old Emanator Surf Ace",
    lastSeenAt: 1200,
    name: "Old Emanator",
    port: 29001,
  });
  discovery.started = true;
  discovery.browser = { update() {} };
  discovery.snapshot.set(retained.endpointId, retained);
  discovery.snapshot.set(stale.endpointId, stale);
  discovery.queryCurrentEndpoints = async () => [endpoint({ lastSeenAt: 5678 })];

  await discovery.refreshNow();

  assert.deepEqual(discovery.getSnapshot(), [retained]);
});
