import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildCompositorGetStatusRequest,
  buildNativePaneHostPlan,
  buildNativePaneHostRequest,
  buildNativePaneUpdateRequest,
  createCompositorNativePaneHostBridge,
  createUnavailableNativePaneHostBridge,
  detectCompositorHostMode,
  nativeStatusFromCompositorStatus,
  serializeCompositorControlRequest,
  UnixSocketCompositorControlTransport,
  type CompositorControlTransport,
} from "../src/native-pane-bridge.js";

test("detectCompositorHostMode reads compositor host environment without requiring it", () => {
  assert.deepEqual(detectCompositorHostMode({}), {
    controlSocketPath: null,
    enabled: false,
    outputRotation: null,
    waylandDisplay: null,
  });
  assert.deepEqual(
    detectCompositorHostMode({
      SURF_ACE_COMPOSITOR: "1",
      SURF_ACE_OUTPUT_ROTATION: "ccw90",
      WAYLAND_DISPLAY: "surf-ace-0",
    }),
    {
      controlSocketPath: "/tmp/surf-ace-compositor.sock",
      enabled: true,
      outputRotation: "ccw90",
      waylandDisplay: "surf-ace-0",
    },
  );
  assert.deepEqual(
    detectCompositorHostMode({
      SURF_ACE_COMPOSITOR_MAIN_APP: "1",
      SURF_ACE_COMPOSITOR_HOST_MODE: "1",
      SURF_ACE_COMPOSITOR_SOCKET: "/tmp/custom.sock",
      WAYLAND_DISPLAY: "wayland-77",
    }),
    {
      controlSocketPath: "/tmp/custom.sock",
      enabled: true,
      outputRotation: null,
      waylandDisplay: "wayland-77",
    },
  );
});

test("buildNativePaneHostPlan keeps Surf Ace pane identity and geometry with process intent", () => {
  const plan = buildNativePaneHostPlan({
    content: {
      process: {
        args: ["--login"],
        command: "zsh",
        cwd: "/tmp",
        env: { TERM: "xterm-256color" },
      },
      targetClass: "terminal",
    },
    contentId: "ct_native",
    geometry: { height: 300, width: 400, x: 10, y: 20 },
    paneId: 7,
    revision: 3,
    surfaceId: "sf_panel",
  });

  assert.deepEqual(plan, {
    contentId: "ct_native",
    geometry: { height: 300, width: 400, x: 10, y: 20 },
    paneId: 7,
    process: {
      args: ["--login"],
      command: "zsh",
      cwd: "/tmp",
      env: { TERM: "xterm-256color" },
    },
    revision: 3,
    surfaceId: "sf_panel",
    targetClass: "terminal",
  });
});

test("unavailable native pane bridge no-ops safely", async () => {
  const bridge = createUnavailableNativePaneHostBridge();
  assert.equal(bridge.available, false);
  assert.equal(await bridge.host({} as never), null);
  assert.equal(await bridge.update({} as never), null);
  await assert.doesNotReject(() => bridge.release({} as never));
});

test("compositor bridge serializes native pane host and update requests", () => {
  const plan = buildNativePaneHostPlan({
    content: {
      process: {
        args: ["-e", "top"],
        command: "ghostty",
        env: { TERM: "xterm-256color" },
      },
      targetClass: "terminal",
    },
    contentId: "ct_native",
    geometry: { height: 300.2, width: 400.7, x: 10.4, y: 20.6 },
    paneId: 7,
    revision: 3,
    surfaceId: "sf_panel",
  });

  assert.equal(
    serializeCompositorControlRequest(buildNativePaneHostRequest(plan)),
    '{"panes":[{"binding_id":"sf_panel:7:ct_native","content_id":"ct_native","geometry":{"height":300,"width":401,"x":10,"y":21},"id":"sf_panel:7","process":{"args":["-e","top"],"command":"ghostty","env":{"TERM":"xterm-256color"}},"revision":3,"target":"terminal"}],"type":"native_pane.host"}\n',
  );
  assert.equal(
    serializeCompositorControlRequest(buildNativePaneUpdateRequest(plan)),
    '{"panes":[{"binding_id":"sf_panel:7:ct_native","content_id":"ct_native","geometry":{"height":300,"width":401,"x":10,"y":21},"id":"sf_panel:7","process":{"args":["-e","top"],"command":"ghostty","env":{"TERM":"xterm-256color"}},"revision":3,"target":"terminal"}],"type":"native_pane.update"}\n',
  );
  assert.equal(
    serializeCompositorControlRequest(buildCompositorGetStatusRequest()),
    '{"type":"get_status"}\n',
  );
});

test("compositor bridge sends host and maps nativeHost lifecycle status", async () => {
  const requests: unknown[] = [];
  const transport: CompositorControlTransport = {
    async send(request) {
      requests.push(request);
      return {
        ok: true,
        status: {
          panes: [
            {
              id: "sf_panel:7",
              nativeHost: {
                bindingId: "sf_panel:7:ct_native",
                contentId: "ct_native",
                lifecycle: { pid: 42, state: "launching" },
                paneId: "sf_panel:7",
                process: { command: "zsh" },
                revision: 3,
              },
            },
          ],
        },
      };
    },
  };
  const bridge = createCompositorNativePaneHostBridge({
    hostMode: {
      controlSocketPath: "/tmp/surf-ace-compositor.sock",
      enabled: true,
      outputRotation: null,
      waylandDisplay: "wayland-77",
    },
    pollAttempts: 0,
    transport,
  });
  const plan = buildNativePaneHostPlan({
    content: {
      process: { command: "zsh" },
      targetClass: "terminal",
    },
    contentId: "ct_native",
    geometry: { height: 300, width: 400, x: 10, y: 20 },
    paneId: 7,
    revision: 3,
    surfaceId: "sf_panel",
  });

  const status = await bridge.host(plan);

  assert.equal(bridge.available, true);
  assert.deepEqual(requests, [
    {
      panes: [
        {
          geometry: { height: 300, width: 400, x: 10, y: 20 },
          binding_id: "sf_panel:7:ct_native",
          content_id: "ct_native",
          id: "sf_panel:7",
          process: { args: [], command: "zsh" },
          revision: 3,
          target: "terminal",
        },
      ],
      type: "native_pane.host",
    },
  ]);
  assert.deepEqual(status, {
    contentId: "ct_native",
    lifecycle: "launching",
    paneId: 7,
    revision: 3,
  });
});

test("compositor bridge polls get_status after host until nativeHost attaches", async () => {
  const requests: unknown[] = [];
  const transport: CompositorControlTransport = {
    async send(request) {
      requests.push(request);
      return {
        ok: true,
        status: {
          panes: [
            {
              id: "sf_panel:7",
              nativeHost: {
                bindingId: "sf_panel:7:ct_native",
                contentId: "ct_native",
                lifecycle: requests.length < 3
                  ? { pid: 42, state: "launching" }
                  : { pid: 42, state: "attached" },
                paneId: "sf_panel:7",
                process: { command: "top" },
                revision: 3,
              },
            },
          ],
        },
      };
    },
  };
  const bridge = createCompositorNativePaneHostBridge({
    hostMode: {
      controlSocketPath: "/tmp/surf-ace-compositor.sock",
      enabled: true,
      outputRotation: null,
      waylandDisplay: "wayland-77",
    },
    pollAttempts: 3,
    pollIntervalMs: 0,
    transport,
  });
  const plan = buildNativePaneHostPlan({
    content: {
      process: { command: "top" },
      targetClass: "terminal",
    },
    contentId: "ct_native",
    geometry: { height: 300, width: 400, x: 10, y: 20 },
    paneId: 7,
    revision: 3,
    surfaceId: "sf_panel",
  });

  const status = await bridge.host(plan);

  assert.deepEqual(requests.map((request) => (request as { type: string }).type), [
    "native_pane.host",
    "get_status",
    "get_status",
  ]);
  assert.deepEqual(status, {
    contentId: "ct_native",
    lifecycle: "attached",
    paneId: 7,
    revision: 3,
  });
});

test("compositor bridge sends update without launch intent", async () => {
  const requests: unknown[] = [];
  const transport: CompositorControlTransport = {
    async send(request) {
      requests.push(request);
      return {
        ok: true,
        status: {
          panes: [
            {
              id: "sf_panel:7",
              nativeHost: {
                bindingId: "sf_panel:7:ct_native",
                contentId: "ct_native",
                lifecycle: { pid: 42, state: "attached" },
                paneId: "sf_panel:7",
                process: { command: "zsh" },
                revision: 4,
              },
            },
          ],
        },
      };
    },
  };
  const bridge = createCompositorNativePaneHostBridge({
    hostMode: {
      controlSocketPath: "/tmp/surf-ace-compositor.sock",
      enabled: true,
      outputRotation: null,
      waylandDisplay: "wayland-77",
    },
    transport,
  });
  const plan = buildNativePaneHostPlan({
    content: {
      process: { command: "zsh" },
      targetClass: "terminal",
    },
    contentId: "ct_native",
    geometry: { height: 320, width: 420, x: 11, y: 22 },
    paneId: 7,
    revision: 4,
    surfaceId: "sf_panel",
  });

  const status = await bridge.update(plan);

  assert.deepEqual(requests, [
    {
      panes: [
        {
          binding_id: "sf_panel:7:ct_native",
          content_id: "ct_native",
          geometry: { height: 320, width: 420, x: 11, y: 22 },
          id: "sf_panel:7",
          process: { args: [], command: "zsh" },
          revision: 4,
          target: "terminal",
        },
      ],
      type: "native_pane.update",
    },
  ]);
  assert.deepEqual(status, {
    contentId: "ct_native",
    lifecycle: "attached",
    paneId: 7,
    revision: 4,
  });
});

test("compositor bridge release switches pane back to Surf Ace rendering", async () => {
  const requests: unknown[] = [];
  const bridge = createCompositorNativePaneHostBridge({
    hostMode: {
      controlSocketPath: "/tmp/surf-ace-compositor.sock",
      enabled: true,
      outputRotation: null,
      waylandDisplay: "wayland-77",
    },
    transport: {
      async send(request) {
        requests.push(request);
        return { ok: true, status: { panes: [] } };
      },
    },
  });

  await bridge.release({
    contentId: "ct_native" as never,
    paneId: 7 as never,
    revision: 3 as never,
    surfaceId: "sf_panel" as never,
  });

  assert.deepEqual(requests, [
    {
      pane_ids: ["sf_panel:7"],
      type: "native_pane.release",
    },
  ]);
});

test("unix socket compositor transport writes newline JSON and reads one response", async () => {
  const dir = await mkdtemp(join(tmpdir(), "surf-ace-native-pane-"));
  const socketPath = join(dir, "control.sock");
  const received: string[] = [];
  const server = createServer((socket) => {
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      received.push(chunk);
      socket.write('{"ok":true,"status":{"panes":[]}}\n');
      socket.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  try {
    const transport = new UnixSocketCompositorControlTransport(socketPath);
    const response = await transport.send({ pane_ids: ["sf_panel:7"], type: "native_pane.release" });

    assert.deepEqual(response, { ok: true, status: { panes: [] } });
    assert.equal(received.join(""), '{"pane_ids":["sf_panel:7"],"type":"native_pane.release"}\n');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { force: true, recursive: true });
  }
});

test("nativeStatusFromCompositorStatus maps failed attached and exited states", () => {
  const plan = buildNativePaneHostPlan({
    content: {
      process: { command: "zsh" },
      targetClass: "terminal",
    },
    contentId: "ct_native",
    geometry: { height: 300, width: 400, x: 10, y: 20 },
    paneId: 7,
    revision: 3,
    surfaceId: "sf_panel",
  });

  assert.deepEqual(
    nativeStatusFromCompositorStatus(plan, {
      panes: [
        {
          id: "sf_panel:7",
          nativeHost: {
            contentId: "ct_native",
            lifecycle: { pid: 42, state: "attached" },
            paneId: "sf_panel:7",
            process: { command: "zsh" },
            revision: 3,
          },
        },
      ],
    }),
    {
      contentId: "ct_native",
      lifecycle: "attached",
      paneId: 7,
      revision: 3,
    },
  );
  assert.deepEqual(
    nativeStatusFromCompositorStatus(plan, {
      panes: [
        {
          id: "sf_panel:7",
          nativeHost: {
            contentId: "ct_native",
            lifecycle: { reason: "spawn failed", state: "failed" },
            paneId: "sf_panel:7",
            process: { command: "zsh" },
            revision: 3,
          },
        },
      ],
    }),
    {
      contentId: "ct_native",
      errorCode: "render_failed",
      errorMessage: "spawn failed",
      lifecycle: "failed",
      paneId: 7,
      revision: 3,
    },
  );
  assert.deepEqual(
    nativeStatusFromCompositorStatus(plan, {
      panes: [
        {
          id: "sf_panel:7",
          nativeHost: {
            contentId: "ct_native",
            lifecycle: { exit_code: 2, pid: 42, state: "exited" },
            paneId: "sf_panel:7",
            process: { command: "zsh" },
            revision: 3,
          },
        },
      ],
    }),
    {
      contentId: "ct_native",
      exitCode: 2,
      lifecycle: "exited",
      paneId: 7,
      revision: 3,
    },
  );
});

test("nativeStatusFromCompositorStatus rejects stale nativeHost status", () => {
  const plan = buildNativePaneHostPlan({
    content: {
      process: { command: "zsh" },
      targetClass: "terminal",
    },
    contentId: "ct_native",
    geometry: { height: 300, width: 400, x: 10, y: 20 },
    paneId: 7,
    revision: 3,
    surfaceId: "sf_panel",
  });

  assert.equal(
    nativeStatusFromCompositorStatus(plan, {
      panes: [
        {
          id: "sf_panel:7",
          nativeHost: {
            contentId: "ct_old",
            lifecycle: { pid: 42, state: "attached" },
            paneId: "sf_panel:7",
            process: { command: "zsh" },
            revision: 2,
          },
        },
      ],
    }),
    null,
  );
});
