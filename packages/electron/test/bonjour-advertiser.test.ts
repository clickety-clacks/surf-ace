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

type FakeDiscoveredService = {
  name: string;
  port?: number;
  txt?: Record<string, unknown>;
};

class FakeBonjour {
  private readonly discoveredServices: Array<Array<string | FakeDiscoveredService>>;
  readonly publishNames: string[] = [];
  readonly services: FakeService[] = [];
  findCalls = 0;
  unpublishCalls = 0;
  destroyed = false;
  findError: Error | null = null;
  publishError: Error | null = null;

  constructor(discoveredServices: Array<Array<string | FakeDiscoveredService>> = []) {
    this.discoveredServices = discoveredServices;
  }

  find(
    _options: { protocol: "tcp"; type: "surf-ace" },
    listener?: (service: { name: string }) => void,
  ) {
    if (this.findError) {
      throw this.findError;
    }
    const browser = new EventEmitter() as EventEmitter & { stop(): void };
    const services = this.discoveredServices[this.findCalls] ?? [];
    this.findCalls += 1;
    queueMicrotask(() => {
      for (const service of services) {
        const discoveredService = typeof service === "string" ? { name: service } : service;
        listener?.(discoveredService);
        browser.emit("up", discoveredService);
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
    [{ name: "TARS Surf Ace", port: 18791, txt: { pk: "other" } }],
  ]);
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
  await (advertiser as unknown as {
    verifyPublishedService(): Promise<void>;
  }).verifyPublishedService();

  assert.deepEqual(bonjour.publishNames, ["TARS Surf Ace", "TARS Surf Ace (2)"]);
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

test("bonjour advertiser uses the default binding on non-macOS hosts", () => {
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

  assert.deepEqual(addresses, []);
});

test("bonjour advertiser keeps incrementing the suffix across repeated conflicts", async () => {
  const bonjour = new FakeBonjour([
    [{ name: "TARS Surf Ace", port: 18791, txt: { pk: "other" } }],
    [{ name: "TARS Surf Ace (2)", port: 18791, txt: { pk: "other" } }],
  ]);
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
  await (advertiser as unknown as {
    verifyPublishedService(): Promise<void>;
  }).verifyPublishedService();
  await (advertiser as unknown as {
    verifyPublishedService(): Promise<void>;
  }).verifyPublishedService();

  assert.deepEqual(bonjour.publishNames, [
    "TARS Surf Ace",
    "TARS Surf Ace (2)",
    "TARS Surf Ace (3)",
  ]);
  assert.equal(bonjour.unpublishCalls, 2);
  await advertiser.stop();
});

test("bonjour advertiser only republishes TXT when the advertised payload changes", async () => {
  const bonjour = new FakeBonjour();
  let busy = "0";
  const advertiser = new BonjourAdvertiser({
    bonjour,
    name: "TARS Surf Ace",
    port: 18791,
    txtProvider: () => ({ busy, pk: "sf_test" }),
  });

  advertiser.start();
  await new Promise((resolve) => {
    setTimeout(resolve, 800);
  });

  advertiser.refreshTxt();
  await new Promise((resolve) => {
    setTimeout(resolve, 50);
  });
  assert.deepEqual(bonjour.publishNames, ["TARS Surf Ace"]);
  assert.equal(bonjour.unpublishCalls, 0);

  busy = "1";
  advertiser.refreshTxt();
  await new Promise((resolve) => {
    setTimeout(resolve, 800);
  });

  assert.deepEqual(bonjour.publishNames, ["TARS Surf Ace", "TARS Surf Ace"]);
  assert.equal(bonjour.unpublishCalls, 1);
  await advertiser.stop();
});

test("bonjour advertiser publishes promptly without name preflight", async () => {
  const bonjour = new FakeBonjour();
  bonjour.findError = new Error("preflight failed");
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

  assert.deepEqual(bonjour.publishNames, ["TARS Surf Ace"]);
  assert.equal(bonjour.findCalls, 0);
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
    await (advertiser as unknown as {
      verifyPublishedService(): Promise<void>;
    }).verifyPublishedService();

    assert.deepEqual(bonjour.publishNames, ["TARS Surf Ace"]);
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

test("bonjour advertiser reaps only stale orphaned isolated publishers with the same identity", async () => {
  const killedPids: number[] = [];
  const advertiser = new BonjourAdvertiser({
    bonjour: new FakeBonjour(),
    isolatedPublisherKill: (pid) => {
      killedPids.push(pid);
    },
    isolatedPublisherProcessList: async () => [
      "101 1 dns-sd -R eezo Surf Ace (eezo) _surf-ace._tcp local. 19001 busy=1 pk=b0ddd36d ws=/ws",
      "102 1 dns-sd -R eezo Surf Ace (eezo) _surf-ace._tcp local. 19001 busy=1 pk=ffffffff ws=/ws",
      "103 1 dns-sd -R eezo Surf Ace (eezo) _surf-ace._tcp local. 19002 busy=1 pk=b0ddd36d ws=/ws",
      "104 999 dns-sd -R eezo Surf Ace (eezo) _surf-ace._tcp local. 19001 busy=1 pk=b0ddd36d ws=/ws",
      "105 1 dns-sd -R Other Surf Ace _surf-ace._tcp local. 19001 busy=1 pk=b0ddd36d ws=/ws",
      "106 1 dns-sd -R eezo Surf Ace (eezo) _other._tcp local. 19001 busy=1 pk=b0ddd36d ws=/ws",
    ].join("\n"),
    name: "eezo Surf Ace (eezo)",
    platform: "darwin",
    port: 19001,
    txtProvider: () => ({ pk: "b0ddd36d" }),
  });

  await (advertiser as unknown as {
    cleanupOrphanedIsolatedPublishers(name: string): Promise<void>;
  }).cleanupOrphanedIsolatedPublishers("eezo Surf Ace (eezo)");

  assert.deepEqual(killedPids, [101]);
});

test("bonjour advertiser does not reap the current isolated publisher child", async () => {
  const killedPids: number[] = [];
  const advertiser = new BonjourAdvertiser({
    bonjour: new FakeBonjour(),
    isolatedPublisherKill: (pid) => {
      killedPids.push(pid);
    },
    isolatedPublisherProcessList: async () =>
      "201 98793 dns-sd -R eezo Surf Ace (eezo) _surf-ace._tcp local. 19001 busy=1 pk=b0ddd36d ws=/ws",
    name: "eezo Surf Ace (eezo)",
    platform: "darwin",
    port: 19001,
    txtProvider: () => ({ pk: "b0ddd36d" }),
  });

  (advertiser as unknown as { isolatedPublisher: { pid: number } }).isolatedPublisher = { pid: 201 };
  await (advertiser as unknown as {
    cleanupOrphanedIsolatedPublishers(name: string): Promise<void>;
  }).cleanupOrphanedIsolatedPublishers("eezo Surf Ace (eezo)");

  assert.deepEqual(killedPids, []);
});

test("bonjour advertiser isolated publisher matcher requires same service name port and fingerprint", () => {
  assert.equal(
    __test.isolatedPublisherCommandMatches(
      "dns-sd -R eezo Surf Ace (eezo) _surf-ace._tcp local. 19001 busy=1 pk=b0ddd36d ws=/ws",
      { name: "eezo Surf Ace (eezo)", port: 19001, publicKeyFingerprint: "b0ddd36d" },
    ),
    true,
  );
  assert.equal(
    __test.isolatedPublisherCommandMatches(
      "dns-sd -R eezo Surf Ace (eezo) _surf-ace._tcp local. 19001 busy=1 pk=b0ddd36e ws=/ws",
      { name: "eezo Surf Ace (eezo)", port: 19001, publicKeyFingerprint: "b0ddd36d" },
    ),
    false,
  );
});
