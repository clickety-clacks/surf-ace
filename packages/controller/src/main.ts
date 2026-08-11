#!/usr/bin/env node
import { ResidentControllerLocalServer } from "./local-server.js";
import { ResidentController } from "./resident-controller.js";

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

const controller = new ResidentController({
  controllerProductName: process.env.SURF_ACE_PRODUCT_LABEL?.trim() ||
    "Surf Ace Linux Controller",
  stateDir: requiredEnvironment("SURF_ACE_STATE_DIR"),
});
const server = new ResidentControllerLocalServer(
  controller,
  requiredEnvironment("SURF_ACE_SOCKET_PATH"),
);

async function stop(): Promise<void> {
  await server.stop();
  await controller.stop();
}

process.once("SIGINT", () => void stop().then(() => process.exit(0)));
process.once("SIGTERM", () => void stop().then(() => process.exit(0)));

await controller.start();
await server.start();
