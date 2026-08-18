#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalJson, parseArgs, sha256, writeCanonicalJson } from "./release-lib.mjs";

async function expectedSmokeReceipt(options) {
  const manifest = JSON.parse(await fs.readFile(options.manifest, "utf8"));
  const files = {};
  for (const file of options.files) files[path.basename(file)] = await sha256(file);
  return {
    channel: options.channel,
    files,
    formatVersion: 1,
    manifestSha256: await sha256(options.manifest),
    product: manifest.source,
    smoke: { result: "passed" },
    tooling: manifest.tooling,
  };
}

export async function writeSmokeReceipt(options) {
  await writeCanonicalJson(options.output, await expectedSmokeReceipt(options));
}

export async function verifySmokeReceipt(options) {
  const expected = canonicalJson(await expectedSmokeReceipt(options));
  const actual = await fs.readFile(options.receipt, "utf8");
  if (actual !== expected) throw new Error(`smoke_receipt_mismatch:${options.receipt}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2), ["channel", "manifest", "files"], ["output", "receipt"]);
  if (Boolean(args.output) === Boolean(args.receipt)) throw new Error("exactly_one_of_output_or_receipt_required");
  const options = {
    channel: args.channel,
    files: args.files.split(",").map(path.resolve),
    manifest: path.resolve(args.manifest),
  };
  if (args.output) await writeSmokeReceipt({ ...options, output: path.resolve(args.output) });
  else await verifySmokeReceipt({ ...options, receipt: path.resolve(args.receipt) });
}
