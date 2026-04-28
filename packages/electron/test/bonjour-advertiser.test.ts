import assert from "node:assert/strict";
import type { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import test from "node:test";

import type { Service } from "bonjour-service";

import { BonjourAdvertiser, __test } from "../src/bonjour-advertiser.js";

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
  findError: Error | null = null;
  publishError: Error | null = null;

  constructor(discoveredNames: string[][] = []) {
    this.discoveredNames = discoveredNames;
  }

  find(
    _options: { protocol: "tcp"; type: "surf-ace" },
    listener?: (service: { name: string }) => void,
  ) {
    if (this.findError) {
      throw this.findError;
    }
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
    if (this.publishError) {
      throw this.publishError;
    }
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

class FakeChildProcess extends EventEmitter {
  killed = false;

  kill(): boolean {
    this.killed = true;
    return true;
  }
}

test("bonjour advertiser republishes with a suffixed name after a name conflict", async () => {
  const bonjour = new FakeBonjour([
    ["TARS Surf Ace"],
    ["TARS Surf Ace (2)"],
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

  assert.deepEqual(bonjour.publishNames, ["TARS Surf Ace (2)"]);
  assert.equal(bonjour.findCalls, 1);
  await advertiser.stop();
});

test("bonjour advertiser diagnostics format concise structured fields", () => {
  assert.equal(
    __test.bonjourDiagnostic("publish_attempt", {
      name: "TARS Surf Ace",
      port: 19001,
      txt_keys: "busy,name,pk",
    }),
    '[surf-ace:bonjour] event=publish_attempt name="TARS Surf Ace" port=19001 txt_keys="busy,name,pk"',
  );
});

test("bonjour advertiser uses the default binding on macOS", () => {
  const addresses = __test.bonjourBindingAddressesForPlatform("darwin", {
    en0: [
      { address: "192.168.50.240", family: "IPv4", internal: false },
      { address: "fe80::1", family: "IPv6", internal: false },
    ] as never,
    lo0: [
      { address: "127.0.0.1", family: "IPv4", internal: true },
    ] as never,
    utun4: [
      { address: "100.71.19.27", family: "IPv4", internal: false },
    ] as never,
  });

  assert.deepEqual(addresses, []);
});

test("bonjour advertiser uses the isolated publisher on macOS", () => {
  assert.equal(__test.useIsolatedBonjourPublisherByDefault("darwin"), true);
  assert.equal(__test.useIsolatedBonjourPublisherByDefault("linux"), false);
});

test("bonjour advertiser ignores loopback/internal IPv4 bindings on non-macOS hosts", () => {
  const addresses = __test.bonjourBindingAddressesForPlatform("linux", {
    en0: [
      { address: "192.168.50.240", family: "IPv4", internal: false },
      { address: "fe80::1", family: "IPv6", internal: false },
    ] as never,
    lo0: [
      { address: "127.0.0.1", family: "IPv4", internal: true },
    ] as never,
    utun4: [
      { address: "100.71.19.27", family: "IPv4", internal: false },
    ] as never,
  });

  assert.deepEqual(addresses, ["192.168.50.240", "100.71.19.27"]);
});

test("bonjour advertiser keeps incrementing the suffix across repeated conflicts", async () => {
  const bonjour = new FakeBonjour([
    ["TARS Surf Ace"],
    ["TARS Surf Ace (2)"],
    ["TARS Surf Ace", "TARS Surf Ace (2)"],
    ["TARS Surf Ace (3)"],
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
  await advertiser.stop();
});

test("bonjour advertiser disables mDNS when publish throws EADDRNOTAVAIL", async () => {
  const bonjour = new FakeBonjour();
  const publishError = new Error("send EADDRNOTAVAIL 224.0.0.251:5353") as Error & { code?: string };
  publishError.code = "EADDRNOTAVAIL";
  bonjour.publishError = publishError;
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };

  try {
    const advertiser = new BonjourAdvertiser({
      bonjour,
      name: "TARS Surf Ace",
      port: 18791,
      txtProvider: () => ({ pk: "sf_test" }),
    });

    advertiser.start();
    await new Promise((resolve) => {
      setTimeout(resolve, 850);
    });

    assert.equal(bonjour.publishNames.length, 0);
    assert.equal(bonjour.destroyed, true);
    assert.match(warnings.join("\n"), /\[surf-ace:bonjour\] event=binding_disabled .*interface=default .*reason=multicast_unavailable/);
    await advertiser.stop();
  } finally {
    console.warn = originalWarn;
  }
});

test("bonjour advertiser disables mDNS when discovery throws ENETUNREACH", async () => {
  const bonjour = new FakeBonjour();
  const findError = new Error("send ENETUNREACH 224.0.0.251:5353") as Error & { code?: string };
  findError.code = "ENETUNREACH";
  bonjour.findError = findError;
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };

  try {
    const advertiser = new BonjourAdvertiser({
      bonjour,
      name: "TARS Surf Ace",
      port: 18791,
      txtProvider: () => ({ pk: "sf_test" }),
    });

    advertiser.start();
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });

    assert.equal(bonjour.publishNames.length, 0);
    assert.equal(bonjour.destroyed, true);
    assert.match(warnings.join("\n"), /\[surf-ace:bonjour\] event=binding_disabled .*interface=default .*reason=multicast_unavailable/);
    await advertiser.stop();
  } finally {
    console.warn = originalWarn;
  }
});

test("bonjour advertiser handles missing dns-sd isolated publisher without crashing", async () => {
  const warnings: string[] = [];
  const originalWarn = console.warn;
  const child = new FakeChildProcess();
  const fakeSpawn: typeof spawn = (() => child) as never;
  const advertiser = new BonjourAdvertiser({
    bonjour: new FakeBonjour(),
    isolatedPublisherSpawn: fakeSpawn,
    name: "TARS Surf Ace",
    port: 18791,
    txtProvider: () => ({ pk: "sf_test" }),
  });

  console.warn = (message?: unknown) => {
    warnings.push(String(message));
  };
  try {
    await (advertiser as unknown as {
      publishWithIsolatedPublisher(name: string): Promise<void>;
    }).publishWithIsolatedPublisher("TARS Surf Ace");
    child.emit("error", Object.assign(new Error("spawn dns-sd ENOENT"), { code: "ENOENT" }));
    await advertiser.stop();
  } finally {
    console.warn = originalWarn;
  }

  assert.match(warnings.join("\n"), /\[surf-ace:bonjour\] event=publish_isolated_error .*error=ENOENT/);
});
