#!/usr/bin/env node
import { createTightBeamSurfAceAdapter } from "./factory.js";
import { runMcpServer } from "./mcp.js";
import type { TightBeamAdapterTool } from "./adapter.js";

function environment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function parseInput(value: string | undefined): unknown {
  return value ? JSON.parse(value) as unknown : {};
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "mcp";
  const adapter = createTightBeamSurfAceAdapter({
    projectionCapacityBytes: Number(
      process.env.SURF_ACE_PROJECTION_CAPACITY_BYTES ?? 16 * 1024 * 1024,
    ),
    stateDir: environment("SURF_ACE_STATE_DIR"),
    url: environment("SURF_ACE_URL"),
  });
  if (command === "mcp") {
    await runMcpServer(adapter);
    return;
  }
  const toolByCommand: Record<string, TightBeamAdapterTool> = {
    list: "surf_ace_list",
    push: "surf_ace_push",
    read: "surf_ace_read",
    topology: "surf_ace_topology_intent",
  };
  const tool = toolByCommand[command];
  if (!tool) {
    throw new Error(`unknown command: ${command}`);
  }
  await adapter.start();
  try {
    process.stdout.write(
      `${JSON.stringify(await adapter.call(tool, parseInput(process.argv[3])), null, 2)}\n`,
    );
  } finally {
    await adapter.stop();
  }
}

await main();
