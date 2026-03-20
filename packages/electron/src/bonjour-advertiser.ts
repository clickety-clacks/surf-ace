import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

import { Bonjour, type Service } from "bonjour-service";

type BonjourBrowser = {
  on(event: "up", listener: (service: { name: string }) => void): void;
  stop(): void;
};

type BonjourClient = {
  destroy(): void;
  find(
    options: { protocol: "tcp"; type: "surf-ace" },
    listener?: (service: { name: string }) => void,
  ): BonjourBrowser;
  publish(options: {
    name: string;
    port: number;
    probe?: boolean;
    protocol: "tcp";
    txt: Record<string, string>;
    type: "surf-ace";
  }): Service;
  unpublishAll(callback: () => void): void;
};

export class BonjourAdvertiser {
  private static readonly VISIBILITY_CHECK_DELAY_MS = 7_500;
  private static readonly VISIBILITY_CHECK_INTERVAL_MS = 15_000;
  private static readonly VISIBILITY_FAILURES_BEFORE_ISOLATION = 3;
  private readonly baseName: string;
  private readonly bonjour: BonjourClient;
  private readonly port: number;
  private readonly txtProvider: () => Record<string, string>;
  private destroyed = false;
  private isolatedPublisher: ChildProcess | null = null;
  private republishAttempts = 0;
  private publishing = false;
  private restarting = false;
  private service: Service | null = null;
  private serviceName: string;
  private started = false;
  private visibilityFailures = 0;
  private visibilityTimer: NodeJS.Timeout | null = null;

  constructor(options: {
    bonjour?: BonjourClient;
    name: string;
    port: number;
    txtProvider: () => Record<string, string>;
  }) {
    this.baseName = options.name;
    this.bonjour = options.bonjour ?? new Bonjour();
    this.port = options.port;
    this.serviceName = options.name;
    this.txtProvider = options.txtProvider;
  }

  start(): void {
    this.started = true;
    if (this.service || this.publishing) {
      return;
    }
    void this.publishNextAvailableName(this.serviceName);
  }

  refresh(): void {
    if (!this.started) {
      return;
    }
    void this.restart();
  }

  async stop(): Promise<void> {
    this.destroyed = true;
    this.started = false;
    this.clearVisibilityTimer();
    this.stopIsolatedPublisher();
    await new Promise<void>((resolve) => {
      this.bonjour.unpublishAll(() => resolve());
    });
    this.bonjour.destroy();
    this.service = null;
  }

  private async restart(): Promise<void> {
    if (this.destroyed) {
      return;
    }
    this.clearVisibilityTimer();
    await new Promise<void>((resolve) => {
      this.bonjour.unpublishAll(() => resolve());
    });
    this.service = null;
    if (this.isolatedPublisher) {
      await this.publishWithIsolatedPublisher(this.serviceName);
      return;
    }
    await this.publishNextAvailableName(this.serviceName);
  }

  private async publishNextAvailableName(preferredName: string): Promise<void> {
    if (this.publishing) {
      return;
    }
    this.publishing = true;
    try {
      const name = await this.resolveAvailableName(preferredName);
      this.publish(name);
    } finally {
      this.publishing = false;
    }
  }

  private publish(name: string): void {
    if (this.isolatedPublisher) {
      void this.publishWithIsolatedPublisher(name);
      return;
    }
    const service = this.bonjour.publish({
      name,
      port: this.port,
      protocol: "tcp",
      txt: this.txtProvider(),
      type: "surf-ace",
    });
    this.serviceName = name;
    this.service = service;
    this.scheduleVisibilityCheck(BonjourAdvertiser.VISIBILITY_CHECK_DELAY_MS);
    service.on("error", (error: Error) => {
      if (this.service !== service) {
        return;
      }
      if (!this.isNameConflict(error)) {
        console.warn("[surf-ace] bonjour publish failed:", error.message);
        return;
      }
      void this.republishWithFallbackName();
    });
  }

  private scheduleVisibilityCheck(delayMs: number): void {
    this.clearVisibilityTimer();
    if (this.destroyed) {
      return;
    }
    this.visibilityTimer = setTimeout(() => {
      this.visibilityTimer = null;
      void this.verifyPublishedService();
    }, delayMs);
    this.visibilityTimer.unref?.();
  }

  private clearVisibilityTimer(): void {
    if (this.visibilityTimer) {
      clearTimeout(this.visibilityTimer);
      this.visibilityTimer = null;
    }
  }

  private async verifyPublishedService(): Promise<void> {
    if (this.destroyed || !this.service || this.restarting) {
      return;
    }
    const publishedName = this.serviceName;
    const activeNames = await this.discoverPublishedNames();
    if (this.destroyed || !this.service || this.restarting || this.serviceName !== publishedName) {
      return;
    }
    if (!activeNames.has(publishedName)) {
      this.visibilityFailures += 1;
      console.warn(`[surf-ace] bonjour publish not visible for "${publishedName}"; retrying`);
      if (
        !this.isolatedPublisher &&
        this.visibilityFailures >= BonjourAdvertiser.VISIBILITY_FAILURES_BEFORE_ISOLATION
      ) {
        await this.switchToIsolatedPublisher();
        return;
      }
      await this.restart();
      return;
    }
    this.visibilityFailures = 0;
    this.scheduleVisibilityCheck(BonjourAdvertiser.VISIBILITY_CHECK_INTERVAL_MS);
  }

  private isNameConflict(error: Error): boolean {
    return error.message.includes("Service name is already in use on the network");
  }

  private async republishWithFallbackName(): Promise<void> {
    if (this.restarting) {
      return;
    }
    this.restarting = true;
    this.republishAttempts += 1;
    this.serviceName = `${this.baseName} (${this.republishAttempts + 1})`;
    try {
      console.warn(`[surf-ace] bonjour name conflict; retrying as "${this.serviceName}"`);
      await this.restart();
    } finally {
      this.restarting = false;
    }
  }

  private async resolveAvailableName(preferredName: string): Promise<string> {
    const activeNames = await this.discoverPublishedNames();
    if (!activeNames.has(preferredName)) {
      return preferredName;
    }
    let suffix = 2;
    let candidate = `${this.baseName} (${suffix})`;
    while (activeNames.has(candidate)) {
      suffix += 1;
      candidate = `${this.baseName} (${suffix})`;
    }
    if (candidate !== preferredName) {
      this.republishAttempts = suffix - 1;
      this.serviceName = candidate;
      console.warn(`[surf-ace] bonjour name conflict; retrying as "${candidate}"`);
    }
    return candidate;
  }

  private async discoverPublishedNames(): Promise<Set<string>> {
    const names = new Set<string>();
    const browser = this.bonjour.find(
      {
        protocol: "tcp",
        type: "surf-ace",
      },
      (service) => {
        names.add(service.name);
      },
    );
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 750).unref?.();
    });
    browser.stop();
    return names;
  }

  private async switchToIsolatedPublisher(): Promise<void> {
    if (this.destroyed) {
      return;
    }
    console.warn("[surf-ace] switching bonjour publishing to isolated node helper");
    await new Promise<void>((resolve) => {
      this.bonjour.unpublishAll(() => resolve());
    });
    this.service = null;
    await this.publishWithIsolatedPublisher(this.serviceName);
  }

  private async publishWithIsolatedPublisher(name: string): Promise<void> {
    const publisher = this.ensureIsolatedPublisher();
    this.serviceName = name;
    publisher.send({
      name,
      port: this.port,
      txt: this.txtProvider(),
      type: "publish",
    });
    this.scheduleVisibilityCheck(BonjourAdvertiser.VISIBILITY_CHECK_DELAY_MS);
  }

  private ensureIsolatedPublisher(): ChildProcess {
    if (this.isolatedPublisher && !this.isolatedPublisher.killed) {
      return this.isolatedPublisher;
    }
    const publisherScript = path.join(__dirname, "bonjour-publisher.cjs");
    const child = spawn(
      this.isolatedPublisherExecutable(),
      [publisherScript],
      {
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: "1",
        },
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      },
    );
    child.stderr?.on("data", (chunk) => {
      process.stderr.write(chunk);
    });
    child.on("exit", () => {
      if (this.isolatedPublisher === child) {
        this.isolatedPublisher = null;
      }
    });
    this.isolatedPublisher = child;
    return child;
  }

  private isolatedPublisherExecutable(): string {
    const preferredNodePaths = [
      "/opt/homebrew/bin/node",
      "/usr/local/bin/node",
    ];
    for (const candidate of preferredNodePaths) {
      if (existsSync(candidate)) {
        return candidate;
      }
    }
    return process.execPath;
  }

  private stopIsolatedPublisher(): void {
    const child = this.isolatedPublisher;
    this.isolatedPublisher = null;
    if (!child || child.killed) {
      return;
    }
    child.send({ type: "stop" });
    setTimeout(() => {
      child.kill();
    }, 500).unref?.();
  }
}
