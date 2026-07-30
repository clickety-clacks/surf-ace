import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import type {
  LocklessPaneCloseIntent,
  LocklessPaneRestoreIntent,
  LocklessPaneSplitIntent,
  LocklessScopeId,
} from "@surf-ace/protocol";

import {
  TightBeamSurfAceAdapter,
  type TightBeamControllerSession,
} from "./adapter.js";
import { runMcpServer } from "./mcp.js";
import { tightBeamSurfAceTools } from "./tools.js";

class FakeSession implements TightBeamControllerSession {
  calls: Array<{ name: string; value?: unknown }> = [];
  stopped = false;

  async start(): Promise<void> {}
  async stop(): Promise<void> {
    this.stopped = true;
  }
  async flushAcknowledgements(): Promise<void> {
    this.calls.push({ name: "flush" });
  }
  async listSurfaces(): Promise<unknown> {
    this.calls.push({ name: "list" });
    return { surfaces: [] };
  }
  async push(surfaceId: string, input: unknown): Promise<unknown> {
    this.calls.push({ name: "push", value: { surfaceId, input } });
    return { revision: 4 };
  }
  async readLocal(scopeId: LocklessScopeId): Promise<any> {
    this.calls.push({ name: "read", value: scopeId });
    return {
      acknowledgement: null,
      cacheStatus: "current",
      consumableLoss: null,
      gap: null,
      records: [],
      repairScheduled: false,
      scopeId,
    };
  }
  async requestLifecycle(op: string, payload: Record<string, unknown>) {
    this.calls.push({ name: op, value: payload });
    return {};
  }
  async openSurface(input: Record<string, unknown>) {
    this.calls.push({ name: "surface.window.open", value: input });
    return {};
  }
  async closeSurface(surfaceId: string, input: Record<string, unknown>) {
    this.calls.push({
      name: "surface.window.close",
      value: { input, surfaceId },
    });
    return {};
  }
  async restoreSurface(tombstoneId: string, input: Record<string, unknown>) {
    this.calls.push({
      name: "surface.window.restore",
      value: { input, tombstoneId },
    });
    return {};
  }
  async requestSurface(
    surfaceId: string,
    op: string,
    payload: Record<string, unknown>,
  ) {
    this.calls.push({ name: op, value: { payload, surfaceId } });
    if (op === "topology.apply") {
      return {
        createdPaneIds: [],
        destroyedPaneIds: [2],
        destroyedPaneTombstones: [{
          closedSequence: 4,
          paneId: 2,
          tombstoneId: "pt_2",
        }],
        panes: [{ paneId: 1 }],
        preservedPaneIds: [1],
        topology: { paneId: 1, type: "pane" },
        topologyRevision: 3,
      };
    }
    return {
      operationReceipt: {
        clientResultIds: {},
        operation: op,
        requestId: `rq_${op}`,
      },
    };
  }
  async splitPane(
    surfaceId: string,
    input: LocklessPaneSplitIntent,
  ): Promise<unknown> {
    this.calls.push({ name: "split", value: { surfaceId, input } });
    return {};
  }
  async closePane(
    surfaceId: string,
    input: LocklessPaneCloseIntent,
  ): Promise<unknown> {
    this.calls.push({ name: "close", value: { surfaceId, input } });
    return {};
  }
  async restorePane(
    surfaceId: string,
    input: LocklessPaneRestoreIntent,
  ): Promise<unknown> {
    this.calls.push({ name: "restore", value: { surfaceId, input } });
    return {};
  }
}

test("adapter exposes agent-side list, push, local read, and topology intent", async () => {
  const session = new FakeSession();
  const adapter = new TightBeamSurfAceAdapter(session);
  assert.deepEqual(await adapter.call("surf_ace_list", {}), { surfaces: [] });
  assert.deepEqual(await adapter.call("surf_ace_push", {
    content: "hello",
    contentId: "ct_1",
    contentType: "markdown",
    friendlyChatName: "Beam",
    paneId: 4,
    surfaceId: "sf_1",
  }), { revision: 4 });
  await adapter.call("surf_ace_read", { scopeId: "pane:sf_1:4" });
  await adapter.call("surf_ace_topology_intent", {
    action: "split",
    count: 2,
    direction: "vertical",
    expectedTopologyRevision: 7,
    paneId: 4,
    surfaceId: "sf_1",
  });
  const clear = await adapter.call("surf_ace_clear", {
    expectedRevision: 4,
    paneId: 4,
    surfaceId: "sf_1",
  });
  assert.equal((clear as any).operationReceipt.requestId, "rq_content.clear");
  await adapter.call("surf_ace_capture_pane", {
    paneId: 4,
    surfaceId: "sf_1",
  });
  await adapter.call("surf_ace_surface_intent", {
    action: "open",
    expectedSurfaceSetRevision: 2,
  });
  await adapter.call("surf_ace_target_register", {
    connectionId: "cn_forbidden",
    idempotencyKey: "idem_1",
    ownershipEpoch: 9,
    ownershipSessionId: "os_forbidden",
    paneId: 4,
    providerId: "pv_forbidden",
    surfaceId: "sf_1",
    targetKind: "native_app",
  });
  const realized = await adapter.call("surf_ace_topology_realize", {
    allowDestroyPaneIds: [2],
    desired: { paneId: 1, type: "pane" },
    expectedTopologyRevision: 2,
    surfaceId: "sf_1",
    target: { root: true },
  }) as any;
  assert.deepEqual(realized.destroyedPaneTombstones, [{
    closedSequence: 4,
    paneId: 2,
    tombstoneId: "pt_2",
  }]);
  assert.deepEqual(session.calls.map((call) => call.name), [
    "list",
    "push",
    "read",
    "split",
    "content.clear",
    "snapshot.get",
    "surface.window.open",
    "target.register",
    "topology.apply",
  ]);
  const push = session.calls[1]!.value as any;
  assert.equal("revision" in push.input, false);
  assert.equal("providerId" in push.input, false);
  const targetRegister = (session.calls.at(-2)!.value as any).payload;
  for (const forbidden of [
    "connectionId",
    "ownershipEpoch",
    "ownershipSessionId",
    "providerId",
    "surfaceId",
  ]) {
    assert.equal(forbidden in targetRegister, false);
  }
});

test("agent schemas require positive pane identity and do not advertise legacy ownership", () => {
  const serialized = JSON.stringify(tightBeamSurfAceTools);
  for (const forbidden of [
    "connectionId",
    "ownershipEpoch",
    "ownershipSessionId",
    "providerId",
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
  for (const tool of tightBeamSurfAceTools) {
    const schema = tool.inputSchema as any;
    assert.notEqual(
      schema.additionalProperties,
      true,
      `${tool.name} must not advertise arbitrary top-level fields`,
    );
    if (schema.properties?.paneId) {
      assert.equal(schema.properties.paneId.minimum, 1, tool.name);
    }
    if (schema.properties?.anchorPaneId) {
      assert.equal(schema.properties.anchorPaneId.minimum, 1, tool.name);
    }
    if (schema.properties?.allowDestroyPaneIds) {
      assert.equal(
        schema.properties.allowDestroyPaneIds.items.minimum,
        1,
        tool.name,
      );
    }
  }
});

test("MCP stdio honors notifications, requests, method errors, shutdown, and EOF", async () => {
  const session = new FakeSession();
  const adapter = new TightBeamSurfAceAdapter(session);
  const messages = [
    { id: 1, jsonrpc: "2.0", method: "initialize", params: {} },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { id: 2, jsonrpc: "2.0", method: "tools/list", params: {} },
    {
      id: 3,
      jsonrpc: "2.0",
      method: "tools/call",
      params: { arguments: {}, name: "surf_ace_list" },
    },
    { id: 4, jsonrpc: "2.0", method: "unknown/method", params: {} },
    { id: 5, jsonrpc: "2.0", method: "shutdown", params: {} },
  ];
  const output: any[] = [];
  await runMcpServer(adapter, {
    input: Readable.from(
      messages.map((message) => `${JSON.stringify(message)}\n`),
    ),
    write: (value) => output.push(value),
  });

  assert.deepEqual(output.map((message) => message.id), [1, 2, 3, 4, 5]);
  assert.equal(output[0].result.serverInfo.name, "tightbeam-surf-ace");
  assert.equal(output[1].result.tools.length, tightBeamSurfAceTools.length);
  assert.equal(
    JSON.parse(output[2].result.content[0].text).surfaces.length,
    0,
  );
  assert.equal(output[3].error.code, -32601);
  assert.equal(output[4].result, null);
  assert.equal(session.stopped, true, "EOF stops the controller session");
});
