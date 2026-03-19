import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import type { Service } from "bonjour-service";

import { BonjourAdvertiser } from "../src/bonjour-advertiser.js";

class FakeService extends EventEmitter {
  triggerError(message: string): void {
    this.emit("error", new Error(message));
  }
}

class FakeBonjour {
  private readonly discoveredNames: string[][];
  readonly publishNames: string[] = [];
  readonly services: FakeService[] = [];
  findCalls = 0;
  unpublishCalls = 0;
  destroyed = false;

  constructor(discoveredNames: string[][] = []) {
    this.discoveredNames = discoveredNames;
  }

  find(
    _options: { protocol: "tcp"; type: "surf-ace" },
    listener?: (service: { name: string }) => void,
  ) {
    const browser = new EventEmitter() as EventEmitter & { stop(): void };
    const names = this.discoveredNames[this.findCalls] ?? [];
    this.findCalls += 1;
    queueMicrotask(() => {
      for (const name of names) {
        listener?.({ name });
        browser.emit("up", { name });
      }
    });
    browser.stop = () => {};
    return browser;
  }

  publish(options: {
    name: string;
    port: number;
    probe?: boolean;
    protocol: "tcp";
    txt: Record<string, string>;
    type: "surf-ace";
  }): Service {
    void options.port;
    void options.protocol;
    void options.txt;
    void options.type;
    this.publishNames.push(options.name);
    const service = new FakeService();
    this.services.push(service);
    return service as unknown as Service;
  }

  unpublishAll(callback: () => void): void {
    this.unpublishCalls += 1;
    queueMicrotask(callback);
  }

  destroy(): void {
    this.destroyed = true;
  }
}

test("bonjour advertiser republishes with a suffixed name after a name conflict", async () => {
  const bonjour = new FakeBonjour([["TARS Surf Ace"]]);
  const advertiser = new BonjourAdvertiser({
    bonjour,
    name: "TARS Surf Ace",
    port: 18791,
    txtProvider: () => ({ pk: "sf_test" }),
  });

  advertiser.start();
  await new Promise((resolve) => {
    setTimeout(resolve, 800);
  });

  assert.deepEqual(bonjour.publishNames, ["TARS Surf Ace (2)"]);
  assert.equal(bonjour.findCalls, 1);
});

test("bonjour advertiser keeps incrementing the suffix across repeated conflicts", async () => {
  const bonjour = new FakeBonjour([
    ["TARS Surf Ace"],
    ["TARS Surf Ace", "TARS Surf Ace (2)"],
  ]);
  const advertiser = new BonjourAdvertiser({
    bonjour,
    name: "TARS Surf Ace",
    port: 18791,
    txtProvider: () => ({ pk: "sf_test" }),
  });

  advertiser.start();
  await new Promise((resolve) => {
    setTimeout(resolve, 800);
  });
  advertiser.refresh();
  await new Promise((resolve) => {
    setTimeout(resolve, 800);
  });

  assert.deepEqual(bonjour.publishNames, [
    "TARS Surf Ace (2)",
    "TARS Surf Ace (3)",
  ]);
  assert.equal(bonjour.unpublishCalls, 1);
});
