#!/usr/bin/env node
"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const configKeys = ["custody", "hostLockPath", "listenHost", "listenPort", "name"];
const custodyKeys = [
  "expectedClusterSystemId",
  "fleetId",
  "primaryUrl",
  "recoveryUrl",
  "witnessApplicationName",
  "witnessPhysicalSlot",
  "witnessServerId",
  "witnessUrl",
];

function publicError(code) {
  const error = new Error(code);
  error.publicCode = code;
  return error;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  return isPlainObject(value) && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function validDnsName(value) {
  if (value.length > 253 || value.length === 0) return false;
  return value.split(".").every((label) =>
    label.length > 0 && label.length <= 63 && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label),
  );
}

function validateServerConfig(config) {
  if (!hasExactKeys(config, configKeys) && !hasExactKeys(config, configKeys.filter((key) => key !== "name"))) {
    throw publicError("server_config_shape_invalid");
  }
  if (typeof config.listenHost !== "string" || config.listenHost.trim() !== config.listenHost ||
      !(require("node:net").isIP(config.listenHost) || validDnsName(config.listenHost))) {
    throw publicError("server_config_listen_host_invalid");
  }
  if (!Number.isSafeInteger(config.listenPort) || config.listenPort < 1 || config.listenPort > 65535) {
    throw publicError("server_config_listen_port_invalid");
  }
  if (typeof config.hostLockPath !== "string" || !path.isAbsolute(config.hostLockPath) || config.hostLockPath.includes("\0")) {
    throw publicError("server_config_host_lock_path_invalid");
  }
  if (config.name !== undefined && (typeof config.name !== "string" || !config.name.trim() || /[\r\n\0]/.test(config.name))) {
    throw publicError("server_config_name_invalid");
  }
  const custody = config.custody;
  if (!hasExactKeys(custody, custodyKeys)) throw publicError("server_config_custody_shape_invalid");
  if (typeof custody.expectedClusterSystemId !== "string" || !/^[0-9]{1,32}$/.test(custody.expectedClusterSystemId)) {
    throw publicError("server_config_cluster_identity_invalid");
  }
  if (typeof custody.fleetId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(custody.fleetId)) {
    throw publicError("server_config_fleet_id_invalid");
  }
  if (custody.witnessApplicationName !== "surf_ace_witness") {
    throw publicError("server_config_witness_application_invalid");
  }
  if (typeof custody.witnessPhysicalSlot !== "string" || !/^[a-z0-9_]{1,63}$/.test(custody.witnessPhysicalSlot)) {
    throw publicError("server_config_witness_slot_invalid");
  }
  if (typeof custody.witnessServerId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(custody.witnessServerId)) {
    throw publicError("server_config_witness_id_invalid");
  }
  for (const key of ["primaryUrl", "recoveryUrl", "witnessUrl"]) {
    if (typeof custody[key] !== "string") throw publicError(`server_config_${key}_invalid`);
    let url;
    try {
      url = new URL(custody[key]);
    } catch {
      throw publicError(`server_config_${key}_invalid`);
    }
    if (!(["postgres:", "postgresql:"].includes(url.protocol) && url.hostname && !url.hash)) {
      throw publicError(`server_config_${key}_invalid`);
    }
  }
  return config;
}

async function readServerConfig(configPath) {
  let stat;
  try {
    stat = await fs.lstat(configPath);
  } catch {
    throw publicError("server_config_file_unavailable");
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw publicError("server_config_file_invalid");
  if (process.platform === "linux" && (stat.mode & 0o077) !== 0) {
    throw publicError("server_config_permissions_too_open");
  }
  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(configPath, "utf8"));
  } catch {
    throw publicError("server_config_json_invalid");
  }
  return validateServerConfig(parsed);
}

function healthUrl(endpoint) {
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    throw publicError("health_endpoint_invalid");
  }
  if (!["ws:", "wss:"].includes(url.protocol) || !url.hostname || url.username || url.password ||
      url.search || url.hash || url.pathname !== "/ws") {
    throw publicError("health_endpoint_invalid");
  }
  return url;
}

function defaultDiagnosticLogPath(config, environment = process.env) {
  const configured = environment.SURF_ACE_CLIENT_DIAGNOSTIC_LOG;
  if (configured !== undefined) {
    if (typeof configured !== "string" || !path.isAbsolute(configured) || configured.includes("\0")) {
      throw publicError("server_diagnostic_log_path_invalid");
    }
    return configured;
  }
  return path.join(path.dirname(config.hostLockPath), "client-flight-recorder.log");
}

function parseForegroundOutputLine(line) {
  const invalid = (outputIssue) => {
    const error = publicError("server_output_line_invalid");
    error.outputIssue = outputIssue;
    throw error;
  };
  if (typeof line !== "string") invalid("not_string");
  if (line.length === 0) invalid("empty_line");
  if (/[\r\n\0]/.test(line)) invalid("framing_control_character");
  const diagnostic = line.match(/^\[surf-ace:(server|bonjour)\] event=([a-z0-9_]+)(?: .*)?$/);
  if (diagnostic) {
    return { event: diagnostic[2], kind: "diagnostic", scope: diagnostic[1] };
  }
  const productDiagnostic = line.match(/^\[surf-ace:([a-z0-9_-]{1,32})\]/);
  if (productDiagnostic) invalid(`product_diagnostic_scope_${productDiagnostic[1]}`);
  if (line.startsWith("[")) invalid("unexpected_bracketed_output");
  if (/^(?:\d{4}-\d{2}-\d{2}T|Warning:|Error:|DeprecationWarning:|ExperimentalWarning:)/.test(line)) {
    invalid("unexpected_runtime_prefixed_output");
  }
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    invalid("not_json_or_server_diagnostic");
  }
  if (!isPlainObject(event)) invalid("lifecycle_event_not_object");
  if (!["ready", "stopped"].includes(event.event)) invalid("lifecycle_event_unexpected");
  return { event, kind: "lifecycle" };
}

async function checkHealth(endpoint, timeoutMs = 5000) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) {
    throw publicError("health_timeout_invalid");
  }
  const url = healthUrl(endpoint);
  const WebSocketClient = globalThis.WebSocket;
  if (typeof WebSocketClient !== "function") throw publicError("health_websocket_unavailable");
  return new Promise((resolve, reject) => {
    let settled = false;
    let opened = false;
    let phase = "connect";
    const id = `rq_server_health_${randomUUID()}`;
    const socket = new WebSocketClient(url);
    let timer;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) {
        try { socket.close(); } catch { /* Connection may already be closed. */ }
        reject(error);
        return;
      }
      resolve(result);
      try { socket.close(1000, "health_probe"); } catch { /* Connection may already be closing. */ }
    };
    const failureReason = (error) => typeof error?.code === "string" ? error.code
      : typeof error?.message === "string" ? error.message : "unknown";
    socket.addEventListener("open", () => {
      opened = true;
      phase = "topology";
      try {
        socket.send(JSON.stringify({
          id,
          op: "fleet.topology",
          payload: {},
          sentAt: Date.now(),
          type: "request",
          v: 1,
        }));
      } catch (error) {
        finish(publicError(`health_fleet_topology_send_failed:${failureReason(error)}`));
      }
    }, { once: true });
    socket.addEventListener("message", (event) => {
      let response;
      try {
        if (typeof event.data !== "string") throw new Error("response_not_text");
        response = JSON.parse(event.data);
      } catch (error) {
        finish(publicError(`health_fleet_topology_response_invalid:${failureReason(error)}`));
        return;
      }
      if (!isPlainObject(response) || response.id !== id || response.op !== "fleet.topology" ||
          response.type !== "response" || response.v !== 1) {
        finish(publicError("health_fleet_topology_response_mismatch"));
        return;
      }
      if (response.ok !== true) {
        const reason = isPlainObject(response.error) && typeof response.error.code === "string"
          ? response.error.code
          : isPlainObject(response.error) && typeof response.error.message === "string"
            ? response.error.message : "request_rejected";
        finish(publicError(`health_fleet_topology_rejected:${reason}`));
        return;
      }
      if (!isPlainObject(response.payload) || !Array.isArray(response.payload.clients)) {
        finish(publicError("health_fleet_topology_payload_invalid"));
        return;
      }
      finish(null, { endpoint: url.origin, status: "healthy", transport: "fleet.topology" });
    });
    socket.addEventListener("error", (event) => {
      const reason = failureReason(event.error);
      const prefix = phase === "connect" ? "health_websocket_connect_failed" : "health_fleet_topology_transport_failed";
      finish(publicError(`${prefix}:${reason}`));
    }, { once: true });
    socket.addEventListener("close", (event) => {
      if (settled) return;
      const reason = event.reason ? `:${event.reason}` : "";
      finish(publicError(opened
        ? `health_fleet_topology_closed:${event.code}${reason}`
        : `health_websocket_closed_before_open:${event.code}${reason}`));
    }, { once: true });
    timer = setTimeout(() => finish(publicError(phase === "connect"
      ? "health_websocket_connect_timeout" : "health_fleet_topology_timeout")), timeoutMs);
  });
}

function parseCommand(argv) {
  const [command, ...rest] = argv;
  if (!["validate", "start", "health"].includes(command)) throw publicError("server_command_invalid");
  const values = new Map();
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (!flag?.startsWith("--") || value === undefined || values.has(flag)) throw publicError("server_arguments_invalid");
    values.set(flag, value);
  }
  const required = (flag) => {
    const value = values.get(flag);
    if (typeof value !== "string" || !value) throw publicError("server_arguments_invalid");
    return value;
  };
  if (command === "health") {
    if (values.size !== 1 || !values.has("--endpoint")) throw publicError("server_arguments_invalid");
    return { command, endpoint: required("--endpoint") };
  }
  if (values.size !== 1 || !values.has("--config")) throw publicError("server_arguments_invalid");
  return { command, configPath: path.resolve(required("--config")) };
}

async function startForeground(config, options = {}) {
  const launcherDirectory = options.launcherDirectory ?? __dirname;
  const modulePath = options.serverModulePath ?? path.resolve(launcherDirectory, "../server/central-server.cjs");
  if (process.env.SURF_ACE_CLIENT_DIAGNOSTIC_LOG === undefined) {
    process.env.SURF_ACE_CLIENT_DIAGNOSTIC_LOG = defaultDiagnosticLogPath(config);
  }
  let service;
  try {
    const serverModule = require(modulePath);
    if (typeof serverModule.startCentralServer !== "function") throw publicError("callable_server_missing");
    service = await serverModule.startCentralServer(config, config.name ?? "Surf Ace Server");
  } catch {
    throw publicError("server_start_failed");
  }
  const write = options.write ?? ((line) => process.stdout.write(`${line}\n`));
  let readyWritten = false;
  const stopHealthSubscription = service.health.subscribe((health) => {
    if (readyWritten || health.status !== "healthy" || typeof health.endpoint !== "string") return;
    let endpoint;
    try {
      endpoint = healthUrl(health.endpoint);
    } catch {
      return;
    }
    readyWritten = true;
    const port = endpoint.port ? Number(endpoint.port) : endpoint.protocol === "wss:" ? 443 : 80;
    write(JSON.stringify({
      event: "ready",
      host: endpoint.hostname,
      pid: process.pid,
      port,
      endpoint: health.endpoint,
    }));
  });
  const signalSource = options.signalSource ?? process;
  return new Promise((resolve, reject) => {
    let closing = false;
    const close = async (signal) => {
      if (closing) return;
      closing = true;
      stopHealthSubscription();
      signalSource.removeListener("SIGTERM", onTerm);
      signalSource.removeListener("SIGINT", onInt);
      try {
        await service.close();
        write(JSON.stringify({ event: "stopped", pid: process.pid, signal, status: "clean" }));
        resolve({ endpoint: service.health.snapshot().endpoint, status: "stopped" });
      } catch {
        reject(publicError("server_shutdown_failed"));
      }
    };
    const onTerm = () => { void close("SIGTERM"); };
    const onInt = () => { void close("SIGINT"); };
    signalSource.once("SIGTERM", onTerm);
    signalSource.once("SIGINT", onInt);
  });
}

async function main(argv = process.argv.slice(2)) {
  let parsed;
  try {
    parsed = parseCommand(argv);
    if (parsed.command === "health") {
      const result = await checkHealth(parsed.endpoint);
      process.stdout.write(`${JSON.stringify({ event: "health", ...result })}\n`);
      return;
    }
    const config = await readServerConfig(parsed.configPath);
    if (parsed.command === "validate") {
      process.stdout.write(`${JSON.stringify({ event: "config-valid", fleetId: config.custody.fleetId })}\n`);
      return;
    }
    await startForeground(config);
  } catch (error) {
    const code = typeof error?.publicCode === "string" ? error.publicCode : "server_operation_failed";
    process.stderr.write(`${JSON.stringify({ event: "error", code })}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  checkHealth,
  defaultDiagnosticLogPath,
  healthUrl,
  parseCommand,
  parseForegroundOutputLine,
  readServerConfig,
  startForeground,
  validateServerConfig,
};

if (require.main === module) void main();
