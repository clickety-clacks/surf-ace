#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import net from "node:net";

import WebSocket from "ws";

const args = parseArgs(process.argv.slice(2));
const port = Number(args.port ?? process.env.SURF_ACE_PORT ?? 19001);
const host = String(args.host ?? "127.0.0.1");
const wsPath = String(args.path ?? "/ws");
const url = String(args.url ?? `ws://${host}:${port}${wsPath}`);
const compositorSocket = String(
  args.compositorSocket ?? process.env.SURF_ACE_COMPOSITOR_SOCKET ?? "/tmp/surf-ace-compositor.sock",
);
const providerId = String(args.providerId ?? "pv_racter_e2e");
const providerName = String(args.providerName ?? "Surf Ace RACTER E2E");
const windowLabel = String(args.windowLabel ?? "RACTER E2E");
const htmlPaneId = Number(args.htmlPaneId ?? 1);
const nativePaneId = Number(args.nativePaneId ?? 2);
const nativeProcess = resolveNativeProcess(args);

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
    initialPaneId: htmlPaneId,
    initialPaneLabel: htmlPaneId,
    protocolVersion: 1,
    providerId,
    providerName,
    surfaceId: surface.surfaceId,
    takeover: true,
    windowLabel,
  });

  await client.request("content.set", {
    content: {
      html: [
        "<main>",
        "<h1>Surf Ace RACTER E2E</h1>",
        "<p>This pane is normal Surf Ace-rendered HTML.</p>",
        "</main>",
      ].join(""),
    },
    contentId: "ct_e2ehtml",
    contentType: "html",
    historyOwnerToken: "hot_e2e_html",
    paneId: htmlPaneId,
    revision: 1,
  });

  const split = await client.request("pane.split", {
    count: 2,
    direction: "horizontal",
    newPaneIds: [nativePaneId],
    newPaneLabels: [nativePaneId],
    paneId: htmlPaneId,
  });

  await client.request("content.set", {
    content: {
      process: {
        args: nativeProcess.args,
        command: nativeProcess.command,
      },
      targetClass: "terminal",
    },
    contentId: "ct_e2etop",
    contentType: "native_surface",
    historyOwnerToken: "hot_e2e_top",
    paneId: nativePaneId,
    revision: 1,
  });

  const nativeStatus = await client.waitForNativeStatus({
    contentId: "ct_e2etop",
    paneId: nativePaneId,
    timeoutMs: Number(args.nativeStatusTimeoutMs ?? 8000),
  });
  const panes = await client.request("panes.list", {});
  const compositorStatus = await getCompositorStatus(compositorSocket).catch((error) => ({
    error: error instanceof Error ? error.message : String(error),
  }));

  console.log(JSON.stringify({
    compositorSocket,
    compositorStatus: summarizeCompositorStatus(compositorStatus, pair.payload.surfaceId, nativePaneId),
    nativeStatus,
    panes: panes.payload.panes.map((pane) => ({
      activeContentId: pane.activeContentId,
      contentType: pane.contentType,
      paneId: pane.paneId,
      viewport: pane.viewport,
    })),
    split: split.payload,
    surfaceId: pair.payload.surfaceId,
    url,
  }, null, 2));
} finally {
  socket.close(1000, "racter_e2e_done");
}

class SurfAceClient {
  constructor(socket) {
    this.next = 1;
    this.pending = new Map();
    this.nativeStatuses = [];
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString("utf8"));
      if (message.type === "response" && this.pending.has(message.id)) {
        const { reject, resolve, timer } = this.pending.get(message.id);
        clearTimeout(timer);
        this.pending.delete(message.id);
        if (message.ok) {
          resolve(message);
        } else {
          reject(new Error(`${message.op} failed: ${message.error?.code ?? "unknown"} ${message.error?.message ?? ""}`.trim()));
        }
        return;
      }
      if (message.op === "event.native_surface_status") {
        this.nativeStatuses.push(message.payload);
      }
    });
    this.socket = socket;
  }

  request(op, payload) {
    const id = `rq_e2e_${this.next++}`;
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
      }, 10000);
      this.pending.set(id, { reject, resolve, timer });
      this.socket.send(JSON.stringify(message));
    });
  }

  async waitForNativeStatus({ contentId, paneId, timeoutMs }) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const status = [...this.nativeStatuses]
        .reverse()
        .find((entry) => entry.contentId === contentId && Number(entry.paneId) === paneId);
      if (status && status.lifecycle !== "launching") {
        return status;
      }
      await sleep(100);
    }
    return this.nativeStatuses.find((entry) => entry.contentId === contentId && Number(entry.paneId) === paneId) ?? null;
  }
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
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(JSON.stringify({ type: "get_status" }) + "\n");
    });
    socket.on("data", (chunk) => {
      response += chunk;
      if (response.includes("\n")) {
        socket.end();
      }
    });
    socket.on("error", reject);
    socket.on("end", () => {
      try {
        resolve(JSON.parse(response.split("\n")[0]));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function summarizeCompositorStatus(response, surfaceId, paneId) {
  if (!response || response.error) {
    return response;
  }
  const compositorPaneId = `${surfaceId}:${paneId}`;
  const pane = response.status?.panes?.find((entry) => entry.id === compositorPaneId);
  if (!pane) {
    return { found: false, paneId: compositorPaneId };
  }
  return {
    found: true,
    nativeHost: pane.nativeHost ?? null,
    paneId: compositorPaneId,
    renderMode: pane.render_mode,
  };
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

function resolveNativeProcess(parsedArgs) {
  if (parsedArgs.command) {
    return {
      args: parsedArgs.commandArgs ? String(parsedArgs.commandArgs).split(" ") : [],
      command: String(parsedArgs.command),
    };
  }

  const top = String(parsedArgs.topCommand ?? "top");
  const appId = "surf-ace-pane-top";
  for (const terminal of ["foot", "ghostty", "kitty", "wezterm", "alacritty"]) {
    if (!commandExists(terminal)) {
      continue;
    }
    switch (terminal) {
      case "foot":
        return { args: ["--app-id", appId, top], command: terminal };
      case "ghostty":
        return { args: [`--class=${appId}`, "-e", top], command: terminal };
      case "kitty":
        return { args: ["--class", appId, top], command: terminal };
      case "wezterm":
        return { args: ["start", "--class", appId, "--", top], command: terminal };
      case "alacritty":
        return { args: ["--class", `${appId},${appId}`, "-e", top], command: terminal };
      default:
        break;
    }
  }
  throw new Error("No supported Wayland terminal found for native top pane; pass --command and --commandArgs explicitly");
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
