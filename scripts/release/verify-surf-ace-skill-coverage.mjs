#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyTightbeamSkillDescribesCli } from "./build-tightbeam-release.mjs";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const [binaryArgument] = process.argv.slice(2);
if (!binaryArgument) throw new Error("usage: verify-surf-ace-skill-coverage.mjs <built-surf-ace-cli>");

const commandNames = await verifyTightbeamSkillDescribesCli(path.resolve(binaryArgument), repository);
process.stdout.write(`Verified ${commandNames.length} built CLI commands against the canonical operating skill.\n`);
