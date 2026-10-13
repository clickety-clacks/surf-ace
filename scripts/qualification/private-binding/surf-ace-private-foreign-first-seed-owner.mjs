#!/usr/bin/env node
// Seed only a disposable owner registry from a reviewed, copied-profile claim
// manifest. The enclosing vehicle must first prove a lo-only network namespace
// and verify both private PostgreSQL identities. Never use on a live endpoint.
import fs from "node:fs";
import os from "node:os";
import { execFileSync } from "node:child_process";

const fail = (code) => { throw new Error(code); };
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

function privateEndpoint(raw) {
  const endpoint = new URL(raw);
  const port = Number(endpoint.port);
  if (endpoint.protocol !== "ws:" || endpoint.hostname !== "127.0.0.1" ||
      endpoint.pathname !== "/ws" || endpoint.search || endpoint.hash ||
      endpoint.username || endpoint.password || !Number.isSafeInteger(port) ||
      port < 20000 || port > 60999) fail("owner_endpoint_not_private");
  if (Object.keys(os.networkInterfaces()).some((name) => name !== "lo")) fail("non_loopback_interface_present");
  const route4 = fs.readFileSync("/proc/net/route", "utf8").split("\n").slice(1);
  if (route4.some((line) => line.trim() && line.split(/\s+/)[1] === "00000000")) fail("ipv4_default_route_present");
  // /proc/net/ipv6_route also lists an unusable ::/0 reject entry on lo.
  // Ask the kernel's route tool for an actual default route, as the driver does.
  if (execFileSync("/usr/sbin/ip", ["-6", "route", "show", "default"],
                   { encoding: "utf8", timeout: 3000 }).trim()) fail("ipv6_default_route_present");
  return endpoint.toString();
}

async function seed(endpoint, manifest) {
  if (!/^[a-f0-9]{64}$/.test(manifest?.clientId ?? "") ||
      !Array.isArray(manifest.confirmedClaims) || manifest.confirmedClaims.length !== 1 ||
      manifest.confirmedClaims[0]?.windowLabel !== "d" ||
      manifest.confirmedClaims[0]?.panes?.length !== 1 ||
      manifest.confirmedClaims[0].panes[0]?.paneLabel !== 3) fail("unsupported_profile_claim_shape");
  const socket = new WebSocket(endpoint);
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("owner_socket_open_timeout")), 5000);
      socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("owner_socket_open_failed")); }, { once: true });
    });
    let counter = 0;
    const request = async (payload) => {
      const id = `rq_private_seed_${++counter}`;
      const response = new Promise((resolve, reject) => {
        const timer = setTimeout(() => { socket.removeEventListener("message", onMessage); reject(new Error("owner_seed_timeout")); }, 10000);
        const onMessage = (event) => {
          let parsed;
          try { parsed = JSON.parse(String(event.data)); } catch { return; }
          if (parsed.id !== id) return;
          clearTimeout(timer);
          socket.removeEventListener("message", onMessage);
          resolve(parsed);
        };
        socket.addEventListener("message", onMessage);
      });
      socket.send(JSON.stringify({ type: "request", v: 1, id, op: "client.register", payload,
        sentAt: Date.now() }));
      const result = await response;
      if (result.ok !== true || result.op !== "client.register") fail("owner_seed_rejected");
      return result.payload;
    };
    const dummyClaims = [
      { clientId: "d".repeat(64), surfaceId: "sf_fixture_dummy_1", windowLabel: "a", paneLabel: 1 },
      { clientId: "e".repeat(64), surfaceId: "sf_fixture_dummy_2", windowLabel: "b", paneLabel: 2 },
      { clientId: "f".repeat(64), surfaceId: "sf_fixture_dummy_3", windowLabel: "c", paneLabel: null },
    ];
    for (const [index, dummy] of dummyClaims.entries()) {
      const panes = dummy.paneLabel === null ? [] :
        [{ paneId: "1", paneLabel: 0, paneLineageId: `pl_fixture_dummy_${index + 1}` }];
      const result = await request({ clientId: dummy.clientId, surfaces: [
        { surfaceId: dummy.surfaceId, panes },
      ] });
      const actual = result?.surfaces?.[0];
      if (result.clientId !== dummy.clientId || result.surfaces?.length !== 1 ||
          actual?.surfaceId !== dummy.surfaceId || actual.windowLabel !== dummy.windowLabel ||
          actual.panes?.length !== panes.length ||
          (dummy.paneLabel !== null && actual.panes[0]?.paneLabel !== dummy.paneLabel)) {
        fail("dummy_ordinals_unexpected");
      }
    }
    const claim = manifest.confirmedClaims[0];
    const real = await request({ clientId: manifest.clientId, surfaces: [{ surfaceId: claim.surfaceId,
      panes: claim.panes.map((pane) => ({ paneId: pane.paneId, paneLabel: pane.paneLabel,
        paneLineageId: pane.paneLineageId })) }] });
    const actual = real?.surfaces?.[0];
    if (real?.clientId !== manifest.clientId || real.surfaces?.length !== 1 ||
        actual?.surfaceId !== claim.surfaceId || actual.windowLabel !== claim.windowLabel ||
        actual.panes?.length !== 1 || actual.panes[0]?.paneId !== claim.panes[0].paneId ||
        actual.panes[0]?.paneLineageId !== claim.panes[0].paneLineageId ||
        actual.panes[0]?.paneLabel !== claim.panes[0].paneLabel) fail("owner_claims_not_exact");
    return { dummyClaims: dummyClaims.map(({ surfaceId, windowLabel, paneLabel }) =>
      ({ surfaceId, windowLabel, paneLabel })), ownerWindowLabel: actual.windowLabel,
      ownerPaneLabel: actual.panes[0].paneLabel, clientId: manifest.clientId,
      registryIdentity: real.registryIdentity };
  } finally {
    socket.close();
  }
}

try {
  if (process.argv.length !== 4) fail("usage: SEED_OWNER PRIVATE_OWNER_WS_URL MANIFEST_JSON");
  const endpoint = privateEndpoint(process.argv[2]);
  const result = await seed(endpoint, readJson(process.argv[3]));
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`foreign_first_owner_seed_failed=${error instanceof Error ? error.message : "unknown"}\n`);
  process.exitCode = 1;
}
