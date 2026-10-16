#!/usr/bin/env node
// Source-only sidecar for the private binding crash fixture. This server uses
// one Unix socket inside a disposable home; it never contacts a registry.
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { verifyBindingCandidate } from "./surf-ace-private-binding-candidate.mjs";

const fail = (reason) => { throw new Error(reason); };
const root = "/tmp/surf-ace-private-crash-fixture-inputs";
const realFile = (file, parent) => {
  if (path.dirname(file) !== parent) fail("file_parent_invalid");
  const info = fs.lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024 * 1024) fail("file_shape_invalid");
  return fs.readFileSync(file);
};

export function classifyRequest(request, options) {
  if (!request || typeof request !== "object" || Array.isArray(request) ||
      request.event !== "candidate" || typeof request.path !== "string" ||
      !/^[0-9a-f]{64}$/.test(request.pendingSha256 ?? "")) fail("request_invalid");
  const { userData, baseline, provisioning } = options;
  if (path.basename(userData) !== "user-data" ||
      !path.resolve(userData).startsWith(`${root}/`) ||
      fs.realpathSync(userData) !== userData || fs.lstatSync(userData).isSymbolicLink()) {
    fail("user_data_not_disposable");
  }
  const basename = path.basename(request.path);
  if (!/^surface-core-state\.json\.[0-9]+\.[0-9]+\.[0-9a-f]+\.tmp$/.test(basename)) {
    fail("candidate_name_invalid");
  }
  const candidate = realFile(request.path, userData);
  const selector = realFile(path.join(userData, "surface-core-state.json.selector"), userData);
  const result = verifyBindingCandidate(candidate, selector, baseline, provisioning);
  if (result.candidateSha256 !== request.pendingSha256) fail("pending_sha_mismatch");
  return result;
}

function main(args) {
  if (args.length !== 4) fail("usage_invalid");
  const [socketPath, userData, baselinePath, provisionedPath] = args;
  const home = path.dirname(userData);
  if (path.dirname(socketPath) !== home || path.basename(socketPath) !== "binding-verifier.sock" ||
      !path.resolve(home).startsWith(`${root}/`) || path.basename(userData) !== "user-data") {
    fail("socket_or_home_invalid");
  }
  if (fs.existsSync(socketPath)) fail("socket_already_exists");
  const baseline = JSON.parse(realFile(baselinePath, home).toString("utf8"));
  const provisioning = JSON.parse(realFile(provisionedPath, userData).toString("utf8"));
  const options = { userData, baseline, provisioning };
  const server = net.createServer((client) => {
    let input = "";
    client.setTimeout(1500, () => client.destroy());
    client.on("data", (chunk) => {
      input += chunk.toString("utf8");
      if (input.length > 4096) { client.destroy(); return; }
      if (!input.includes("\n")) return;
      try {
        const lines = input.split("\n");
        if (lines.length !== 2 || lines[1] !== "") fail("request_framing_invalid");
        const result = classifyRequest(JSON.parse(lines[0]), options);
        client.end(`${JSON.stringify({ ok: true, ...result })}\n`);
      } catch (error) {
        client.end(`${JSON.stringify({ ok: false, reason: error instanceof Error ? error.message : "unknown" })}\n`);
      }
    });
  });
  server.maxConnections = 1;
  server.listen(socketPath, () => fs.chmodSync(socketPath, 0o600));
  process.on("SIGTERM", () => server.close());
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  try { main(process.argv.slice(2)); } catch (error) {
    process.stderr.write(`binding_verifier_failed=${error instanceof Error ? error.message : "unknown"}\n`);
    process.exitCode = 1;
  }
}
