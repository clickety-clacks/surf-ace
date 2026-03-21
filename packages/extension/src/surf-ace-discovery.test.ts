import assert from "node:assert/strict";
import test from "node:test";
import { __test } from "./surf-ace-discovery.js";

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
    endpointId: "eezo.local:55386/ws",
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
