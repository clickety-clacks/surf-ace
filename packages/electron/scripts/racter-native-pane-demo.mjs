#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import net from "node:net";

import WebSocket from "ws";

class SurfAceClient {
  constructor(socket) {
    this.next = 1;
    this.pending = new Map();
    this.socket = socket;
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString("utf8"));
      if (message.type !== "response" || !this.pending.has(message.id)) {
        return;
      }
      const { reject, resolve, timer } = this.pending.get(message.id);
      clearTimeout(timer);
      this.pending.delete(message.id);
      if (message.ok) {
        resolve(message);
        return;
      }
      reject(new Error(`${message.op} failed: ${message.error?.code ?? "unknown"} ${message.error?.message ?? ""}`.trim()));
    });
  }

  request(op, payload, timeoutMs = 10000) {
    const id = `rq_racter_${this.next++}`;
    const message = {
      id,
      op,
      payload,
      sentAt: Date.now(),
      type: "request",
      v: 1,
    };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${op} timed out`));
      }, timeoutMs);
      this.pending.set(id, { reject, resolve, timer });
      this.socket.send(JSON.stringify(message));
    });
  }
}

const args = parseArgs(process.argv.slice(2));
const port = Number(args.port ?? process.env.SURF_ACE_PORT ?? 19001);
const host = String(args.host ?? "127.0.0.1");
const wsPath = String(args.path ?? "/ws");
const url = String(args.url ?? `ws://${host}:${port}${wsPath}`);
const compositorSocket = String(
  args.compositorSocket ?? args["compositor-socket"] ?? process.env.SURF_ACE_COMPOSITOR_SOCKET ?? "/tmp/surf-ace-compositor.sock",
);
const providerId = String(args.providerId ?? args["provider-id"] ?? "pv_racter_overlay_verify");
const providerName = String(args.providerName ?? args["provider-name"] ?? "Surf Ace Racter Overlay Verify");
const windowLabel = String(args.windowLabel ?? args["window-label"] ?? "RACTER Overlay Verify");
const btopPaneId = Number(args.btopPaneId ?? args["btop-pane-id"] ?? 1);
const topPaneId = Number(args.topPaneId ?? args["top-pane-id"] ?? 2);
const btopProcess = resolveNativeProcess(args, {
  appId: "surf-ace-pane-btop",
  argsKey: "btop-args",
  commandKey: "btop-command",
  commandName: "btop",
  fallbackName: "top",
});
const topProcess = resolveNativeProcess(args, {
  appId: "surf-ace-pane-top",
  argsKey: "top-args",
  commandKey: "top-command",
  commandName: "top",
  fallbackName: "top",
});

const initialStatus = await getCompositorStatus(compositorSocket);
const geometry = resolvePaneGeometries(initialStatus, args);
const socket = await connectWebSocket(url);
const client = new SurfAceClient(socket);

try {
  const surfaces = await client.request("surfaces.list", {});
  const surface = surfaces.payload.surfaces.find((entry) => !entry.paired) ?? surfaces.payload.surfaces[0];
  if (!surface) {
    throw new Error("No Surf Ace surface is available");
  }

  const pair = await client.request("pair.request", {
    connectionId: `conn_${randomId()}`,
    eventProfile: "minimum_deep",
    initialPaneId: btopPaneId,
    initialPaneLabel: btopPaneId,
    protocolVersion: 1,
    providerId,
    providerName,
    surfaceId: surface.surfaceId,
    takeover: true,
    windowLabel,
  });

  const targetCapabilities = pair.payload.capabilities.targetCapabilities ?? [];
  if (!targetCapabilities.includes("target.terminal_app.v1")) {
    throw new Error(`Surface does not advertise target.terminal_app.v1: ${targetCapabilities.join(",")}`);
  }

  await client.request("heartbeat.ping", { nonce: `racter_${randomId()}` });

  const topology = await client.request("topology.apply", {
    layout: {
      children: [
        { paneId: btopPaneId, type: "pane" },
        { paneId: topPaneId, type: "pane" },
      ],
      direction: "horizontal",
      type: "split",
    },
    panes: [
      { name: "btop", paneId: btopPaneId, paneLabel: btopPaneId },
      { name: "top", paneId: topPaneId, paneLabel: topPaneId },
    ],
    topologyRevision: Number(args.topologyRevision ?? args["topology-revision"] ?? 1),
    windowLabel,
  });

  const panesById = new Map(topology.payload.panes.map((pane) => [Number(pane.paneId), pane]));
  const btopPane = requirePane(panesById, btopPaneId);
  const topPane = requirePane(panesById, topPaneId);

  const btopApply = await client.request("target.apply", targetApplyPayload({
    geometry: geometry.btop,
    ownershipSessionId: pair.payload.sessionId,
    pane: btopPane,
    process: btopProcess,
    restoreReason: "initial_apply",
    surfaceId: pair.payload.surfaceId,
    targetEpoch: 1,
    targetId: "target_racter_btop",
    topologyEpoch: topology.payload.topologyRevision,
    windowLabel,
    zIndex: 0,
  }), 15000);
  const topApply = await client.request("target.apply", targetApplyPayload({
    geometry: geometry.top,
    ownershipSessionId: pair.payload.sessionId,
    pane: topPane,
    process: topProcess,
    restoreReason: "initial_apply",
    surfaceId: pair.payload.surfaceId,
    targetEpoch: 1,
    targetId: "target_racter_top",
    topologyEpoch: topology.payload.topologyRevision,
    windowLabel,
    zIndex: 1,
  }), 15000);

  await waitForRendererOverlayRegions({
    client,
    minRegionCount: Number(args.minOverlayRegionCount ?? args["min-overlay-region-count"] ?? 1),
    socketPath: compositorSocket,
    timeoutMs: Number(args.overlayWaitMs ?? args["overlay-wait-ms"] ?? 5000),
  });

  const finalStatus = await getCompositorStatus(compositorSocket);
  const panes = await client.request("panes.list", {});

  console.log(JSON.stringify({
    applies: [
      summarizeApply(btopApply),
      summarizeApply(topApply),
    ],
    compositorSocket,
    finalCompositorStatus: summarizeCompositorStatus(finalStatus, pair.payload.surfaceId),
    initialCompositorStatus: summarizeCompositorStatus(initialStatus, pair.payload.surfaceId),
    panes: panes.payload.panes.map((pane) => ({
      activeContentId: pane.activeContentId,
      contentType: pane.contentType,
      paneId: pane.paneId,
      viewport: pane.viewport,
    })),
    providerId,
    surfaceId: pair.payload.surfaceId,
    topology: topology.payload,
    url,
  }, null, 2));
} finally {
  socket.close(1000, "racter_overlay_verify_done");
}

function targetApplyPayload(options) {
  const paneId = Number(options.pane.paneId);
  const compositorPaneId = String(paneId);
  const targetSummary = options.targetId.includes("btop") ? "btop" : "top";
  return {
    materialization: {
      op: "native_pane.host",
      panes: [
        {
          binding_id: `${compositorPaneId}:${options.targetId}`,
          content_id: options.targetId,
          geometry: {
            ...options.geometry,
            coordinateSpace: "compositor_logical",
          },
          id: compositorPaneId,
          process: {
            args: options.process.args,
            command: options.process.command,
          },
          revision: options.targetEpoch,
          target: "terminal",
        },
      ],
    },
    ownershipEpoch: 1,
    ownershipSessionId: options.ownershipSessionId,
    paneLineageId: options.pane.paneLineageId,
    requestId: `racter_${targetSummary}_${randomId()}`,
    restoreReason: options.restoreReason,
    surfaceId: options.surfaceId,
    targetEpoch: options.targetEpoch,
    targetHeader: {
      payloadSchemaVersion: 1,
      replaySemantics: "launch_equivalent",
      requiredCapabilities: ["target.terminal_app.v1"],
      safeToLogFields: ["command"],
      safetyClass: "process",
      summary: targetSummary,
    },
    targetId: options.targetId,
    targetKind: "terminal_app",
    targetPayload: {
      args: options.process.args,
      command: options.process.command,
    },
  };
}

async function waitForRendererOverlayRegions({ client, minRegionCount, socketPath, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = null;
  let lastDiagnostics = null;
  while (Date.now() < deadline) {
    lastStatus = await getCompositorStatus(socketPath);
    lastDiagnostics = await overlayDiagnostics(client);
    const regionCount = overlayRegionCount(lastStatus);
    if (regionCount >= minRegionCount) {
      return;
    }
    await sleep(100);
  }
  throw new Error([
    `Timed out waiting for renderer overlay regions >= ${minRegionCount}; last compositor count=${overlayRegionCount(lastStatus)}`,
    `overlay diagnostics=${JSON.stringify(lastDiagnostics)}`,
  ].join("; "));
}

async function overlayDiagnostics(client) {
  try {
    const response = await client.request("diagnostics.overlay_regions", {}, 5000);
    return response.payload;
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function overlayRegionCount(response) {
  const status = response?.status ?? response;
  const overlayRegions = status?.overlay_regions ?? status?.overlayRegions;
  if (typeof overlayRegions?.regionCount === "number") {
    return overlayRegions.regionCount;
  }
  if (Array.isArray(overlayRegions?.regions)) {
    return overlayRegions.regions.length;
  }
  if (typeof status?.overlay_region_count === "number") {
    return status.overlay_region_count;
  }
  return 0;
}

function summarizeApply(response) {
  return {
    materializedState: response.payload.materializedState,
    paneLineageId: response.payload.paneLineageId,
    status: response.payload.status,
    targetId: response.payload.targetId,
  };
}

function summarizeCompositorStatus(response, surfaceId) {
  const status = response.status ?? response;
  return {
    logicalSurface: {
      height: status.logical_surface_height ?? null,
      width: status.logical_surface_width ?? null,
    },
    overlayRegions: status.overlay_regions ?? status.overlayRegions ?? null,
    panes: Array.isArray(status.panes)
      ? status.panes
        .filter((pane) => typeof pane.id !== "string" || pane.id.startsWith(`${surfaceId}:`) || pane.id === "1" || pane.id === "2")
        .map((pane) => ({
          id: pane.id,
          nativeHost: pane.nativeHost ?? null,
          renderMode: pane.render_mode ?? pane.renderMode ?? null,
        }))
      : [],
    rawOk: response.ok ?? null,
  };
}

function resolvePaneGeometries(statusResponse, parsedArgs) {
  const status = statusResponse.status ?? statusResponse;
  const logicalWidth = Number(
    parsedArgs.logicalWidth ?? parsedArgs["logical-width"] ?? status.logical_surface_width ?? 2160,
  );
  const logicalHeight = Number(
    parsedArgs.logicalHeight ?? parsedArgs["logical-height"] ?? status.logical_surface_height ?? 3840,
  );
  const paneWidth = logicalWidth / 2;
  return {
    btop: { height: logicalHeight, width: paneWidth, x: 0, y: 0 },
    top: { height: logicalHeight, width: logicalWidth - paneWidth, x: paneWidth, y: 0 },
  };
}

function requirePane(panesById, paneId) {
  const pane = panesById.get(paneId);
  if (!pane?.paneLineageId) {
    throw new Error(`topology.apply did not return paneLineageId for pane ${paneId}`);
  }
  return pane;
}

function connectWebSocket(targetUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(targetUrl);
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

function getCompositorStatus(socketPath) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    let response = "";
    let settled = false;
    const settle = (callback) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      callback();
    };
    socket.setEncoding("utf8");
    socket.setTimeout(10000);
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ type: "get_status" })}\n`);
    });
    socket.on("data", (chunk) => {
      response += chunk;
      const newlineIndex = response.indexOf("\n");
      if (newlineIndex < 0) {
        return;
      }
      settle(() => resolve(JSON.parse(response.slice(0, newlineIndex))));
    });
    socket.on("error", (error) => settle(() => reject(error)));
    socket.on("timeout", () => settle(() => reject(new Error("compositor status request timed out"))));
    socket.on("end", () => {
      if (settled) {
        return;
      }
      settle(() => resolve(JSON.parse(response.trim())));
    });
  });
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      continue;
    }
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = true;
    } else {
      parsed[key] = next;
      index += 1;
    }
  }
  return parsed;
}

function resolveNativeProcess(parsedArgs, options) {
  const commandOverride = parsedArgs[options.commandKey];
  if (commandOverride) {
    return {
      args: parsedArgs[options.argsKey] ? splitArgs(String(parsedArgs[options.argsKey])) : [],
      command: String(commandOverride),
    };
  }

  const commandName = commandExists(options.commandName)
    ? options.commandName
    : options.fallbackName;
  for (const terminal of ["foot", "ghostty", "kitty", "wezterm", "alacritty"]) {
    if (!commandExists(terminal)) {
      continue;
    }
    switch (terminal) {
      case "foot":
        return { args: ["--app-id", options.appId, commandName], command: terminal };
      case "ghostty":
        return { args: [`--class=${options.appId}`, "-e", commandName], command: terminal };
      case "kitty":
        return { args: ["--class", options.appId, commandName], command: terminal };
      case "wezterm":
        return { args: ["start", "--class", options.appId, "--", commandName], command: terminal };
      case "alacritty":
        return { args: ["--class", `${options.appId},${options.appId}`, "-e", commandName], command: terminal };
      default:
        break;
    }
  }
  throw new Error(`No supported Wayland terminal found for ${commandName}; pass --${options.commandKey} and --${options.argsKey}`);
}

function splitArgs(value) {
  return value.length > 0 ? value.split(" ") : [];
}

function commandExists(command) {
  return spawnSync("sh", ["-lc", `command -v ${quoteShell(command)} >/dev/null 2>&1`]).status === 0;
}

function quoteShell(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function randomId() {
  return Math.random().toString(16).slice(2);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
