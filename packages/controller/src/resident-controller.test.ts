import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { ControllerInstanceId, LocklessScopeId } from "@surf-ace/protocol";

import type {
  SurfAceDiscoveryEndpoint,
  SurfAceDiscoveryService,
} from "./discovery.js";
import { ControllerIdentity } from "./identity.js";
import { ResidentControllerLocalServer } from "./local-server.js";
import {
  ResidentController,
  type ResidentEndpointController,
} from "./resident-controller.js";
import type { ControllerStateStore } from "./state-store.js";

class MemoryStore implements ControllerStateStore {
  value: unknown = null;

  async load(): Promise<unknown | null> {
    return structuredClone(this.value);
  }

  async save(value: unknown): Promise<void> {
    this.value = structuredClone(value);
  }
}

class FakeDiscovery implements SurfAceDiscoveryService {
  private readonly listeners = new Set<
    (endpoints: SurfAceDiscoveryEndpoint[]) => void
  >();

  constructor(private endpoints: SurfAceDiscoveryEndpoint[]) {}

  getSnapshot(): SurfAceDiscoveryEndpoint[] {
    return structuredClone(this.endpoints);
  }

  async refreshNow(): Promise<void> {}
  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  subscribe(listener: (endpoints: SurfAceDiscoveryEndpoint[]) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(endpoints: SurfAceDiscoveryEndpoint[]): void {
    this.endpoints = structuredClone(endpoints);
    for (const listener of this.listeners) {
      listener(this.getSnapshot());
    }
  }
}

class FakeEndpointController implements ResidentEndpointController {
  readonly calls: string[] = [];
  stopped = false;

  constructor(private readonly listed: unknown) {}

  async start(): Promise<void> {
    this.calls.push("start");
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.calls.push("stop");
  }

  async listSurfaces(): Promise<unknown> {
    this.calls.push("surfaces.list");
    return structuredClone(this.listed);
  }

  async requestSurface(surfaceId: string, op: string): Promise<unknown> {
    this.calls.push(`${op}:${surfaceId}`);
    return {
      panes: [{ paneId: 1, paneLabel: "1" }],
      surfaceId,
      topologyRevision: 4,
    };
  }

  async readLocal(scopeId: LocklessScopeId): Promise<unknown> {
    return { cacheStatus: "current", scopeId };
  }

  async push(): Promise<unknown> {
    return { revision: 5 };
  }

  async splitPane(): Promise<unknown> {
    return {};
  }

  async closePane(): Promise<unknown> {
    return {};
  }

  async restorePane(): Promise<unknown> {
    return {};
  }

  async openSurface(): Promise<unknown> {
    return {};
  }

  async closeSurface(): Promise<unknown> {
    return {};
  }

  async restoreSurface(): Promise<unknown> {
    return {};
  }
}

function endpoint(
  host = "shrdlu.local",
  fingerprintPrefix = "c0ffee",
): SurfAceDiscoveryEndpoint {
  return {
    busy: false,
    capabilitiesBitmask: 1,
    endpointId: `${host}:19001/ws#${fingerprintPrefix}`,
    fingerprintPrefix,
    host,
    instanceName: "shrdlu Surf Ace",
    lastSeenAt: 100,
    name: "shrdlu Surf Ace",
    port: 19001,
    protocolVersion: 1,
    viewport: { height: 3840, scale: 1, width: 2160 },
    wsPath: "/ws",
  };
}

async function capturedSurfacesList(): Promise<unknown> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const fixture = JSON.parse(await fs.readFile(
    path.join(here, "../fixtures/shrdlu-surfaces-list-2026-08-11.json"),
    "utf8",
  )) as Record<string, unknown>;
  return (fixture.response as Record<string, unknown>).payload;
}

test("resident controller persists surfaces.list then panes.list across discovery loss and address change", async () => {
  const discovery = new FakeDiscovery([endpoint()]);
  const topologyStore = new MemoryStore();
  const sessions: FakeEndpointController[] = [];
  const controller = new ResidentController({
    controllerProductName: "Surf Ace Linux Controller",
    createEndpointController: () => {
      const session = new FakeEndpointController(awaitedListed);
      sessions.push(session);
      return session;
    },
    discovery,
    identity: new ControllerIdentity(
      new MemoryStore(),
      () => "ci_resident" as ControllerInstanceId,
    ),
    now: () => 200,
    stateDir: "/unused",
    topologyStore,
  });
  const awaitedListed = await capturedSurfacesList();

  await controller.start();
  assert.deepEqual(sessions[0]?.calls.slice(0, 3), [
    "start",
    "surfaces.list",
    "panes.list:sf_0019da33b612",
  ]);
  let listed = (await controller.call("list", {})).result as {
    endpoints: Array<{ discovered: boolean; surfaces: unknown[] }>;
  };
  assert.equal(listed.endpoints[0]?.discovered, true);
  assert.equal(listed.endpoints[0]?.surfaces.length, 1);

  discovery.emit([]);
  listed = (await controller.call("list", {})).result as typeof listed;
  assert.equal(listed.endpoints[0]?.discovered, false);
  assert.equal(
    listed.endpoints[0]?.surfaces.length,
    1,
    "discovery loss retains the durable surfaces and panes projection",
  );

  discovery.emit([endpoint("192.0.2.55")]);
  listed = (await controller.call("list", {})).result as typeof listed;
  assert.equal(listed.endpoints.length, 1, "stable fingerprint prevents duplication");
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0]?.stopped, true);
  assert.deepEqual(sessions[1]?.calls.slice(0, 3), [
    "start",
    "surfaces.list",
    "panes.list:sf_0019da33b612",
  ]);
  await controller.stop();
});

test("resident controller migrates the instance fallback when a fingerprint appears", async () => {
  const discovery = new FakeDiscovery([endpoint("shrdlu.local", "")]);
  const topologyStore = new MemoryStore();
  const sessions: FakeEndpointController[] = [];
  const listedSurfaces = await capturedSurfacesList();
  const controller = new ResidentController({
    controllerProductName: "Surf Ace Linux Controller",
    createEndpointController: () => {
      const session = new FakeEndpointController(listedSurfaces);
      sessions.push(session);
      return session;
    },
    discovery,
    identity: new ControllerIdentity(
      new MemoryStore(),
      () => "ci_resident" as ControllerInstanceId,
    ),
    now: () => 200,
    stateDir: "/unused",
    topologyStore,
  });

  await controller.start();
  discovery.emit([endpoint()]);
  const listed = (await controller.call("list", {})).result as {
    endpoints: Array<{ fingerprintPrefix: string; surfaces: unknown[] }>;
  };

  assert.equal(listed.endpoints.length, 1);
  assert.equal(listed.endpoints[0]?.fingerprintPrefix, "c0ffee");
  assert.equal(listed.endpoints[0]?.surfaces.length, 1);
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0]?.stopped, true);
  assert.equal(sessions[1]?.stopped, false);
  await controller.stop();
});

test("local server returns one versioned response and preserves controller errors", async () => {
  const sessionRoot = path.resolve(process.cwd(), "../../..");
  const directory = await fs.mkdtemp(path.join(sessionRoot, ".resident-test-"));
  const socketPath = path.join(directory, "controller.sock");
  const server = new ResidentControllerLocalServer({
    async call(command, input) {
      assert.equal(command, "list");
      assert.deepEqual(input, {});
      return { ok: true, result: { surfaces: [] } };
    },
  }, socketPath);
  await server.start();
  const response = await new Promise<Record<string, unknown>>((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let encoded = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.end(`${JSON.stringify({
        command: "list",
        id: "local_test",
        input: {},
        v: 1,
      })}\n`);
    });
    socket.on("data", (chunk) => encoded += chunk);
    socket.on("end", () => resolve(JSON.parse(encoded)));
    socket.on("error", reject);
  });
  assert.deepEqual(response, {
    id: "local_test",
    ok: true,
    result: { ok: true, result: { surfaces: [] } },
    v: 1,
  });
  await server.stop();
  await fs.rmdir(directory);
});
