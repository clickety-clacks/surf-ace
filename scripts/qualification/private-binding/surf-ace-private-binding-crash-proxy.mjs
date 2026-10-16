#!/usr/bin/env node
// One-connection recording proxy for a private, loopback-only fixture.
// It logs operation names, never payloads, and fails closed on unsupported
// frames. In foreign mode it forwards fleet.topology only.
import fs from "node:fs";
import net from "node:net";
import os from "node:os";

const [mode, listenText, upstreamText, log] = process.argv.slice(2);
const port = Number(listenText), upstreamPort = Number(upstreamText);
const fail = (code) => { process.stderr.write(`foreign_first_proxy_failed=${code}\n`); process.exit(1); };
if (!["foreign", "owner"].includes(mode) || !Number.isSafeInteger(port) ||
    !Number.isSafeInteger(upstreamPort) || port < 20000 || upstreamPort < 20000 ||
    port > 60999 || upstreamPort > 60999 || port === upstreamPort || !log?.startsWith("/tmp/surf-ace-private-crash-fixture-inputs/")) {
  fail("arguments_invalid");
}
if (Object.keys(os.networkInterfaces()).some((name) => name !== "lo")) fail("non_loopback_interface_present");
if (fs.readFileSync("/proc/net/route", "utf8").split("\n").slice(1)
  .some((line) => line.trim() && line.split(/\s+/)[1] === "00000000")) fail("default_route_present");
const record = (event) => fs.appendFileSync(log, `${new Date().toISOString()} ${event}\n`, { mode: 0o600 });
record(`proxy_started mode=${mode} listen=127.0.0.1:${port} upstream=127.0.0.1:${upstreamPort}`);

function frameLength(buffer, requireMasked) {
  if (buffer.length < 2) return null;
  const masked = (buffer[1] & 0x80) !== 0;
  if (masked !== requireMasked) throw new Error("frame_mask_invalid");
  let length = buffer[1] & 0x7f, header = 2;
  if (length === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2); header = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return null;
    const big = buffer.readBigUInt64BE(2);
    if (big > 1024n * 1024n) throw new Error("frame_too_large");
    length = Number(big); header = 10;
  }
  if (length > 1024 * 1024) throw new Error("frame_too_large");
  const maskLength = masked ? 4 : 0;
  return buffer.length < header + maskLength + length ? null :
    { header, length, total: header + maskLength + length };
}

const server = net.createServer((client) => {
  const upstream = net.connect({ host: "127.0.0.1", port: upstreamPort });
  let buffer = Buffer.alloc(0), upgraded = false;
  let serverBuffer = Buffer.alloc(0), serverUpgraded = false;
  const registrations = new Set(), topologies = new Set();
  const stop = (reason) => {
    record(`proxy_stop reason=${reason}`);
    client.destroy(); upstream.destroy();
  };
  upstream.on("data", (chunk) => {
    try {
      serverBuffer = Buffer.concat([serverBuffer, chunk]);
      if (serverBuffer.length > 2 * 1024 * 1024) throw new Error("server_buffer_too_large");
      if (!serverUpgraded) {
        const end = serverBuffer.indexOf("\r\n\r\n");
        if (end < 0) { client.write(chunk); return; }
        const response = serverBuffer.subarray(0, end + 4).toString("ascii");
        if (!/^HTTP\/1\.1 101 /i.test(response)) throw new Error("upgrade_response_invalid");
        serverBuffer = serverBuffer.subarray(end + 4);
        serverUpgraded = true;
      }
      while (serverBuffer.length > 0) {
        const frame = frameLength(serverBuffer, false);
        if (!frame) break;
        const raw = serverBuffer.subarray(0, frame.total);
        serverBuffer = serverBuffer.subarray(frame.total);
        const opcode = raw[0] & 0x0f;
        if ((raw[0] & 0x80) === 0 || ![1, 8, 9, 10].includes(opcode)) {
          throw new Error("server_frame_type_unsupported");
        }
        if (opcode !== 1) continue;
        const message = JSON.parse(raw.subarray(frame.header).toString("utf8"));
        if (mode === "owner" && message?.type === "response" &&
            message.op === "fleet.topology" && topologies.has(message.id)) {
          topologies.delete(message.id);
          const identity = message.payload?.registryIdentity;
          if (message.ok === true && typeof identity?.fleetId === "string" &&
              typeof identity?.allocatorId === "string" &&
              /^[A-Za-z0-9_-]{1,128}$/.test(identity.fleetId) &&
              /^[A-Za-z0-9_-]{1,128}$/.test(identity.allocatorId)) {
            record(`response op=fleet.topology ok=true fleetId=${identity.fleetId} allocatorId=${identity.allocatorId}`);
          } else record("response op=fleet.topology ok=false");
        }
        if (mode === "owner" && message?.type === "response" &&
            message.op === "client.register" && registrations.has(message.id)) {
          registrations.delete(message.id);
          const registered = message.payload;
          const surface = registered?.surfaces?.[0];
          const pane = surface?.panes?.[0];
          if (message.ok === true && registered?.surfaces?.length === 1 &&
              surface?.panes?.length === 1 &&
              /^[0-9a-f]{64}$/.test(registered.clientId) &&
              /^sf_[A-Za-z0-9._:-]{3,64}$/.test(surface.surfaceId) &&
              /^[a-z]+$/.test(surface.windowLabel) &&
              /^[A-Za-z0-9._:-]{1,64}$/.test(pane.paneId) &&
              Number.isSafeInteger(pane.paneLabel) &&
              /^pl_[A-Za-z0-9._:-]{3,128}$/.test(pane.paneLineageId)) {
            record(`response op=client.register ok=true clientId=${registered.clientId} surfaceId=${surface.surfaceId} windowLabel=${surface.windowLabel} paneId=${pane.paneId} paneLabel=${pane.paneLabel} paneLineageId=${pane.paneLineageId}`);
          } else {
            record("response op=client.register ok=false");
          }
        }
      }
      client.write(chunk);
    } catch (error) {
      stop(error instanceof Error ? error.message : "server_frame_invalid");
    }
  });
  upstream.on("error", () => stop("upstream_error"));
  client.on("error", () => stop("client_error"));
  client.on("close", () => upstream.destroy());
  client.on("data", (chunk) => {
    try {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > 2 * 1024 * 1024) throw new Error("buffer_too_large");
      if (!upgraded) {
        const end = buffer.indexOf("\r\n\r\n");
        if (end < 0) return;
        const request = buffer.subarray(0, end + 4).toString("ascii");
        if (!request.startsWith("GET /ws HTTP/1.1\r\n") ||
            !/^Host: 127\.0\.0\.1:[0-9]+\r?$/mi.test(request)) throw new Error("upgrade_request_invalid");
        upstream.write(buffer.subarray(0, end + 4));
        buffer = buffer.subarray(end + 4);
        upgraded = true;
      }
      while (buffer.length > 0) {
        const frame = frameLength(buffer, true);
        if (!frame) return;
        const raw = buffer.subarray(0, frame.total);
        buffer = buffer.subarray(frame.total);
        const opcode = raw[0] & 0x0f;
        if ((raw[0] & 0x80) === 0 || ![1, 8, 9, 10].includes(opcode)) throw new Error("frame_type_unsupported");
        if (opcode === 1) {
          const mask = raw.subarray(frame.header, frame.header + 4);
          const bytes = raw.subarray(frame.header + 4);
          const decoded = Buffer.alloc(frame.length);
          for (let i = 0; i < frame.length; i += 1) decoded[i] = bytes[i] ^ mask[i % 4];
          const message = JSON.parse(decoded.toString("utf8"));
          if (message?.type !== "request" || typeof message.op !== "string" ||
              !/^[a-z.]+$/.test(message.op)) throw new Error("request_shape_invalid");
          record(`request op=${message.op}`);
          if (mode === "owner" && message.op === "fleet.topology") {
            if (typeof message.id !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(message.id)) {
              throw new Error("topology_id_invalid");
            }
            topologies.add(message.id);
          }
          if (mode === "owner" && message.op === "client.register") {
            if (typeof message.id !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(message.id)) {
              throw new Error("registration_id_invalid");
            }
            registrations.add(message.id);
          }
          if (mode === "foreign" && message.op !== "fleet.topology") {
            record(`forbidden_request op=${message.op}`);
            throw new Error("foreign_mutation_attempt");
          }
        }
        upstream.write(raw);
      }
    } catch (error) {
      stop(error instanceof Error ? error.message : "unknown");
    }
  });
});
server.listen(port, "127.0.0.1", () => record("proxy_listening"));
process.on("SIGTERM", () => server.close());
