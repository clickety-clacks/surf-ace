#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs, sha256 } from "./release-lib.mjs";

export async function compareReleaseBuilds(leftDir, rightDir, filenames) {
  const leftReceipt = await fs.readFile(path.join(leftDir, ".receipts/SHA256SUMS"));
  const rightReceipt = await fs.readFile(path.join(rightDir, ".receipts/SHA256SUMS"));
  if (!leftReceipt.equals(rightReceipt)) throw new Error("release_checksum_records_differ");
  const compared = [];
  for (const filename of [...filenames].sort()) {
    const [left, right] = await Promise.all([
      fs.readFile(path.join(leftDir, filename)),
      fs.readFile(path.join(rightDir, filename)),
    ]);
    if (!left.equals(right)) throw new Error(`release_file_bytes_differ:${filename}`);
    compared.push({ filename, sha256: await sha256(path.join(leftDir, filename)) });
  }
  return compared;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2), ["build-a", "build-b", "files"]);
  const files = args.files.split(",").filter(Boolean);
  if (files.length === 0) throw new Error("empty_release_file_list");
  const result = await compareReleaseBuilds(path.resolve(args["build-a"]), path.resolve(args["build-b"]), files);
  process.stdout.write(`${JSON.stringify({ compared: result }, null, 2)}\n`);
}
