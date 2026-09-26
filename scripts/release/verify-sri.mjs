#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs, sri } from "./release-lib.mjs";

export async function verifySri(file, expected) {
  if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(expected)) throw new Error("invalid_expected_sri");
  const actual = await sri(file, "sha512");
  if (actual !== expected) throw new Error(`sri_mismatch:${actual}:${expected}`);
  return actual;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2), ["file", "expected"]);
  process.stdout.write(`${JSON.stringify({ integrity: await verifySri(path.resolve(args.file), args.expected), verified: true })}\n`);
}
