import { execFile, spawn, type ChildProcess } from "node:child_process";
import os from "node:os";

import { Bonjour, type Service } from "bonjour-service";

type BonjourError = Error & {
  code?: string;
};

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

type BonjourBinding = {
  client: BonjourClient;
  destroyed: boolean;
  disabled: boolean;
  interfaceAddress: string | null;
  service: Service | null;
};

type BonjourDiagnosticFields = Record<string, boolean | number | string | null | undefined>;

function formatBonjourDiagnosticValue(value: string | number | boolean): string {
  const text = String(value);
  return /^[A-Za-z0-9_./:@%-]+$/.test(text) ? text : JSON.stringify(text);
}

function bonjourDiagnostic(event: string, fields: BonjourDiagnosticFields = {}): string {
  const suffix = Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${key}=${formatBonjourDiagnosticValue(value)}`)
    .join(" ");
  return suffix.length > 0
    ? `[surf-ace:bonjour] event=${event} ${suffix}`
    : `[surf-ace:bonjour] event=${event}`;
}

function txtSignature(txt: Record<string, string>): string {
  return JSON.stringify(Object.entries(txt).sort(([left], [right]) => left.localeCompare(right)));
}

function isIpv4Family(family: string | number): boolean {
  return family === 4 || family === "IPv4";
}

function isLoopbackIpv4Address(address: string): boolean {
  return address === "127.0.0.1" || address.startsWith("127.");
}

function bonjourBindingAddressesForPlatform(
  platform: NodeJS.Platform,
  networks: ReturnType<typeof os.networkInterfaces>,
): string[] {
  // On macOS, mDNSResponder already owns 5353 on each interface. Creating
  // per-interface Bonjour clients causes live EADDRINUSE crashes in the main
  // process, so use a single default client and rely on visibility fallback.
  if (platform === "darwin") {
    return [];
  }
  const names = Object.keys(networks);
  const addresses = new Set<string>();
  for (const name of names) {
    const entries = networks[name] ?? [];
    const entry = entries.find(
      (candidate) => isIpv4Family(candidate.family) && !candidate.internal && !isLoopbackIpv4Address(candidate.address),
    );
    if (entry?.address) {
      addresses.add(entry.address);
    }
  }
  return [...addresses];
}

function useIsolatedBonjourPublisherByDefault(platform: NodeJS.Platform): boolean {
  return platform === "darwin";
}

function bonjourInterfaceAddresses(): string[] {
  return bonjourBindingAddressesForPlatform(process.platform, os.networkInterfaces());
}

export class BonjourAdvertiser {
  private static readonly VISIBILITY_CHECK_DELAY_MS = 7_500;
  private static readonly VISIBILITY_CHECK_INTERVAL_MS = 15_000;
  private static readonly VISIBILITY_FAILURES_BEFORE_ISOLATION = 3;
  private readonly baseName: string;
  private readonly bonjourBindings: BonjourBinding[];
  private readonly isolatedPublisherSpawn: typeof spawn;
  private readonly port: number;
  private readonly txtProvider: () => Record<string, string>;
  private readonly useIsolatedPublisherByDefault: boolean;
  private destroyed = false;
  private isolatedPublisher: ChildProcess | null = null;
  private isolatedPublisherGeneration = 0;
  private republishAttempts = 0;
  private publishing = false;
  private publishedTxtSignature: string | null = null;
  private restarting = false;
  private services: Service[] = [];
  private serviceName: string;
  private started = false;
  private visibilityFailures = 0;
  private visibilityTimer: NodeJS.Timeout | null = null;

  constructor(options: {
    bonjour?: BonjourClient;
    isolatedPublisherSpawn?: typeof spawn;
    name: string;
    port: number;
    txtProvider: () => Record<string, string>;
  }) {
    this.baseName = options.name;
    this.bonjourBindings = options.bonjour
      ? [{ client: options.bonjour, destroyed: false, disabled: false, interfaceAddress: null }]
      : this.createBonjourBindings();
    this.isolatedPublisherSpawn = options.isolatedPublisherSpawn ?? spawn;
    this.port = options.port;
    this.serviceName = options.name;
    this.txtProvider = options.txtProvider;
    this.useIsolatedPublisherByDefault = !options.bonjour && useIsolatedBonjourPublisherByDefault(process.platform);
  }

  start(): void {
    this.started = true;
    console.info(
      bonjourDiagnostic("publish_start", {
        base_name: this.baseName,
        binding_count: this.activeBonjourBindings().length,
        port: this.port,
      }),
    );
    if (this.services.length > 0 || this.publishing) {
      return;
    }
    if (this.useIsolatedPublisherByDefault) {
      void this.publishWithIsolatedPublisher(this.serviceName);
      return;
    }
    void this.publishNextAvailableName(this.serviceName);
  }

  refresh(): void {
    if (!this.started) {
      return;
    }
    console.info(
      bonjourDiagnostic("publish_refresh", {
        current_name: this.serviceName,
        isolated: Boolean(this.isolatedPublisher),
      }),
    );
    void this.restart();
  }

  refreshTxt(): void {
    if (!this.started) {
      return;
    }
    const nextTxtSignature = txtSignature(this.txtProvider());
    if (this.publishedTxtSignature === nextTxtSignature) {
      console.info(
        bonjourDiagnostic("publish_refresh_skipped", {
          current_name: this.serviceName,
          reason: "txt_unchanged",
        }),
      );
      return;
    }
    this.refresh();
  }

  async stop(): Promise<void> {
    this.destroyed = true;
    this.started = false;
    console.info(
      bonjourDiagnostic("publish_stop", {
        isolated: Boolean(this.isolatedPublisher),
        published_count: this.services.length,
      }),
    );
    this.clearVisibilityTimer();
    this.isolatedPublisherGeneration += 1;
    this.stopIsolatedPublisher();
    await Promise.all(this.bonjourBindings.map((binding) => this.shutdownBonjourBinding(binding)));
    this.services = [];
  }

  private async restart(): Promise<void> {
    if (
      this.destroyed
      || (this.activeBonjourBindings().length === 0 && !this.isolatedPublisher && !this.useIsolatedPublisherByDefault)
    ) {
      return;
    }
    this.clearVisibilityTimer();
    await Promise.all(this.activeBonjourBindings().map((binding) => this.unpublishBonjourBinding(binding)));
    this.services = [];
    if (this.isolatedPublisher || this.useIsolatedPublisherByDefault) {
      await this.publishWithIsolatedPublisher(this.serviceName);
      return;
    }
    await this.publishNextAvailableName(this.serviceName);
  }

  private async publishNextAvailableName(preferredName: string): Promise<void> {
    if (this.publishing || this.activeBonjourBindings().length === 0) {
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
    console.info(
      bonjourDiagnostic("publish_attempt", {
        binding_count: this.activeBonjourBindings().length,
        name,
        port: this.port,
      }),
    );
    const txt = this.txtProvider();
    const services: Service[] = [];
    for (const binding of this.activeBonjourBindings()) {
      let service: Service;
      try {
        service = binding.client.publish({
          name,
          port: this.port,
          protocol: "tcp",
          txt,
          type: "surf-ace",
        });
      } catch (error) {
        this.handleBonjourError(error, binding);
        continue;
      }
      services.push(service);
      binding.service = service;
      this.attachServiceErrorHandler(service, binding);
    }
    if (services.length === 0) {
      return;
    }
    this.serviceName = name;
    this.publishedTxtSignature = txtSignature(txt);
    this.services = services;
    console.info(
      bonjourDiagnostic("publish_issued", {
        binding_count: services.length,
        name,
      }),
    );
    this.scheduleVisibilityCheck(BonjourAdvertiser.VISIBILITY_CHECK_DELAY_MS);
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
    if (this.destroyed || (this.services.length === 0 && !this.isolatedPublisher) || this.restarting) {
      return;
    }
    const publishedName = this.serviceName;
    const activeNames = await this.discoverPublishedNames();
    if (this.destroyed || (this.services.length === 0 && !this.isolatedPublisher) || this.restarting || this.serviceName !== publishedName) {
      return;
    }
    if (!activeNames.has(publishedName)) {
      this.visibilityFailures += 1;
      console.warn(
        bonjourDiagnostic("publish_not_visible", {
          failure_count: this.visibilityFailures,
          name: publishedName,
        }),
      );
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
    console.info(
      bonjourDiagnostic("publish_visible", {
        discovered_count: activeNames.size,
        name: publishedName,
      }),
    );
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
      console.warn(
        bonjourDiagnostic("publish_republish", {
          name: this.serviceName,
          reason: "name_conflict",
        }),
      );
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
      console.warn(
        bonjourDiagnostic("publish_republish", {
          candidate,
          preferred_name: preferredName,
          reason: "name_conflict",
        }),
      );
    }
    return candidate;
  }

  private async discoverPublishedNames(): Promise<Set<string>> {
    const names = new Set<string>();
    const browsers: BonjourBrowser[] = [];
    for (const binding of this.activeBonjourBindings()) {
      try {
        browsers.push(
          binding.client.find(
            {
              protocol: "tcp",
              type: "surf-ace",
            },
            (service) => {
              names.add(service.name);
            },
          ),
        );
      } catch (error) {
        this.handleBonjourError(error, binding);
      }
    }
    if (browsers.length === 0) {
      return names;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 750).unref?.();
    });
    for (const browser of browsers) {
      browser.stop();
    }
    return names;
  }

  private handleBonjourError(error: unknown, binding?: BonjourBinding): void {
    if (this.isMulticastUnavailableError(error)) {
      this.disableBonjourBinding(binding, error);
      return;
    }
    throw error;
  }

  private isMulticastUnavailableError(error: unknown): error is BonjourError {
    if (!(error instanceof Error)) {
      return false;
    }
    const code = (error as BonjourError).code;
    return code === "EADDRNOTAVAIL" || code === "ENETUNREACH" || /\bEADDRNOTAVAIL\b|\bENETUNREACH\b/.test(error.message);
  }

  private createBonjourBindings(): BonjourBinding[] {
    const addresses = bonjourInterfaceAddresses();
    if (addresses.length === 0) {
      return [this.createBonjourBinding(null)];
    }
    return addresses.map((address) => this.createBonjourBinding(address));
  }

  private createBonjourBinding(interfaceAddress: string | null): BonjourBinding {
    const binding: BonjourBinding = {
      client: null as unknown as BonjourClient,
      destroyed: false,
      disabled: false,
      interfaceAddress,
      service: null,
    };
    const options = interfaceAddress ? ({ interface: interfaceAddress } as Record<string, string>) : {};
    binding.client = new Bonjour(options, (error: Error) => {
      this.handleBonjourError(error, binding);
    });
    return binding;
  }

  private activeBonjourBindings(): BonjourBinding[] {
    return this.bonjourBindings.filter((binding) => !binding.destroyed && !binding.disabled);
  }

  private attachServiceErrorHandler(service: Service, binding: BonjourBinding): void {
    service.on("error", (error: Error) => {
      if (!this.services.includes(service)) {
        return;
      }
      if (this.isMulticastUnavailableError(error)) {
        this.disableBonjourBinding(binding, error);
        return;
      }
      if (!this.isNameConflict(error)) {
        console.warn(
          bonjourDiagnostic("publish_failed", {
            error: error.message,
            interface: binding.interfaceAddress ?? "default",
            name: this.serviceName,
          }),
        );
        return;
      }
      void this.republishWithFallbackName();
    });
  }

  private disableBonjourBinding(binding: BonjourBinding | undefined, error: unknown): void {
    if (!binding || binding.disabled || binding.destroyed) {
      return;
    }
    const code = error instanceof Error ? ((error as BonjourError).code ?? error.message) : String(error);
    const interfaceLabel = binding.interfaceAddress ?? "default";
    console.warn(
      bonjourDiagnostic("binding_disabled", {
        error: code,
        interface: interfaceLabel,
        reason: "multicast_unavailable",
      }),
    );
    binding.disabled = true;
    this.clearVisibilityTimer();
    if (binding.service) {
      this.services = this.services.filter((service) => service !== binding.service);
      binding.service = null;
    }
    binding.client.destroy();
    binding.destroyed = true;
  }

  private async unpublishBonjourBinding(binding: BonjourBinding): Promise<void> {
    console.info(
      bonjourDiagnostic("publish_unpublish", {
        interface: binding.interfaceAddress ?? "default",
        name: binding.service?.name ?? this.serviceName,
      }),
    );
    await new Promise<void>((resolve) => {
      binding.client.unpublishAll(() => resolve());
    });
    binding.service = null;
  }

  private async shutdownBonjourBinding(binding: BonjourBinding): Promise<void> {
    if (binding.destroyed) {
      return;
    }
    await this.unpublishBonjourBinding(binding);
    binding.client.destroy();
    binding.destroyed = true;
  }

  private async switchToIsolatedPublisher(): Promise<void> {
    if (this.destroyed) {
      return;
    }
    console.warn(
      bonjourDiagnostic("publish_isolated_switch", {
        failures: this.visibilityFailures,
        name: this.serviceName,
      }),
    );
    await Promise.all(this.activeBonjourBindings().map((binding) => this.unpublishBonjourBinding(binding)));
    this.services = [];
    await this.publishWithIsolatedPublisher(this.serviceName);
  }

  private async publishWithIsolatedPublisher(name: string): Promise<void> {
    const generation = ++this.isolatedPublisherGeneration;
    this.stopIsolatedPublisher();
    await this.cleanupOrphanedIsolatedPublishers(name);
    if (this.destroyed || generation !== this.isolatedPublisherGeneration) {
      return;
    }
    this.serviceName = name;
    const txt = this.txtProvider();
    const txtArgs = Object.entries(txt).map(([k, v]) => `${k}=${v}`);
    this.publishedTxtSignature = txtSignature(txt);
    console.info(
      bonjourDiagnostic("publish_attempt", {
        isolated: true,
        name,
        port: this.port,
      }),
    );
    const child = this.isolatedPublisherSpawn(
      "dns-sd",
      ["-R", name, "_surf-ace._tcp", "local.", String(this.port), ...txtArgs],
      { stdio: ["ignore", "ignore", "ignore"] },
    );
    child.on("error", (error: Error) => {
      if (this.isolatedPublisher !== child) {
        return;
      }
      console.warn(
        bonjourDiagnostic("publish_isolated_error", {
          error: (error as BonjourError).code ?? error.message,
          name: this.serviceName,
        }),
      );
      this.isolatedPublisher = null;
    });
    child.on("exit", (code) => {
      if (this.isolatedPublisher === child) {
        console.warn(
          bonjourDiagnostic("publish_isolated_exit", {
            code: code ?? "null",
            name: this.serviceName,
          }),
        );
        this.isolatedPublisher = null;
      }
    });
    this.isolatedPublisher = child;
    this.scheduleVisibilityCheck(BonjourAdvertiser.VISIBILITY_CHECK_DELAY_MS);
  }

  private stopIsolatedPublisher(): void {
    const child = this.isolatedPublisher;
    this.isolatedPublisher = null;
    if (!child || child.killed) {
      return;
    }
    console.info(
      bonjourDiagnostic("publish_isolated_stop", {
        name: this.serviceName,
      }),
    );
    child.kill();
  }

  private async cleanupOrphanedIsolatedPublishers(name: string): Promise<void> {
    if (process.platform !== "darwin") {
      return;
    }
    const commandPrefix = `dns-sd -R ${name} _surf-ace._tcp local. ${this.port}`;
    const currentPid = this.isolatedPublisher?.pid ?? null;
    const rows = await new Promise<string>((resolve) => {
      try {
        execFile("ps", ["-axo", "pid=,ppid=,command="], (error, stdout) => {
          resolve(error ? "" : stdout);
        });
      } catch {
        resolve("");
      }
    });
    for (const row of rows.split(/\r?\n/)) {
      const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(row);
      if (!match) {
        continue;
      }
      const pid = Number(match[1]);
      const parentPid = Number(match[2]);
      const command = match[3] ?? "";
      if (pid === currentPid || parentPid !== 1 || !command.includes(commandPrefix)) {
        continue;
      }
      try {
        process.kill(pid, "TERM");
        console.warn(
          bonjourDiagnostic("publish_isolated_orphan_killed", {
            name,
            pid,
          }),
        );
      } catch {
        // The orphan may exit between ps and kill.
      }
    }
  }
}

export const __test = {
  bonjourDiagnostic,
  bonjourBindingAddressesForPlatform,
  useIsolatedBonjourPublisherByDefault,
};
