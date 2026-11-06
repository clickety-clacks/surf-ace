import assert from "node:assert/strict";
import { isIP } from "node:net";
import test from "node:test";

import { tailnetEndpointForListener, type NetworkInterfaceMap } from "./tailnet-endpoint.js";

type NetworkInfo = NonNullable<NetworkInterfaceMap[string]>[number];

function networks(records: Record<string, string[]>): NetworkInterfaceMap {
  return Object.fromEntries(Object.entries(records).map(([name, addresses]) => [
    name,
    addresses.map((address): NetworkInfo => {
      const family = isIP(address);
      return {
        address,
        family: family === 6 ? "IPv6" : "IPv4",
        internal: false,
        mac: "00:00:00:00:00:00",
        netmask: family === 6 ? "ffff:ffff:ffff:ffff::" : "255.255.255.0",
        cidr: null,
      };
    }),
  ]));
}

test("selects a listener-reachable VPN address and prefers IPv4", () => {
  const interfaces = networks({
    en0: ["100.90.1.3", "192.168.1.10"],
    pdp_ip0: ["100.70.1.2"],
    tailscale0: ["100.101.102.103"],
    utun4: ["fd7a:115c:a1e0::1"],
  });

  assert.equal(
    tailnetEndpointForListener({ address: "0.0.0.0", port: 19_001 }, interfaces),
    "ws://100.101.102.103:19001/ws",
  );
});

test("selects an IPv6 unique-local address for an IPv6 listener", () => {
  const interfaces = networks({ utun5: ["fd7a:115c:a1e0::1234"] });

  assert.equal(
    tailnetEndpointForListener({ address: "::", port: 19_001 }, interfaces),
    "ws://[fd7a:115c:a1e0::1234]:19001/ws",
  );
});

test("does not treat carrier CGNAT or other non-VPN addresses as tailnet", () => {
  const interfaces = networks({
    en0: ["100.90.1.3"],
    pdp_ip0: ["100.70.1.2"],
  });

  assert.equal(tailnetEndpointForListener({ address: "0.0.0.0", port: 19_001 }, interfaces), null);
});

test("omits an endpoint when interface provenance or listener reachability is unproven", () => {
  const unrecognizedTunnelName = networks({ vpn_adapter: ["100.101.102.103"] });
  const knownTunnelAddress = networks({ tailscale0: ["100.101.102.103"] });

  assert.equal(tailnetEndpointForListener({ address: "0.0.0.0", port: 19_001 }, unrecognizedTunnelName), null);
  assert.equal(tailnetEndpointForListener({ address: "127.0.0.1", port: 19_001 }, knownTunnelAddress), null);
  assert.equal(tailnetEndpointForListener({ address: "0.0.0.0", port: 19_001 }, null), null);
  assert.equal(tailnetEndpointForListener(null, knownTunnelAddress), null);
});
