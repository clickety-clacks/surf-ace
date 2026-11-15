#!/usr/bin/env node

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createRuntime, readPrivateConfig } from "./skill-delivery-runtime.mjs";

export async function run() {
  const configIndex = process.argv.indexOf("--config");
  const configPath = configIndex >= 0
    ? process.argv[configIndex + 1]
    : process.env.SURF_ACE_SKILL_DELIVERY_CONFIG;
  if (configIndex >= 0 && !configPath) throw new Error("delivery_config_path_required");
  const config = await readPrivateConfig(configPath);
  return createRuntime(config);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.stdout.write(`${JSON.stringify(await run())}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
