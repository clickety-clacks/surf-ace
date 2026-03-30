import { spawn, type ChildProcess } from "node:child_process";
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

function isIpv4Family(family: string | number): boolean {
  return family === 4 || family === "IPv4";
}

function bonjourInterfaceAddresses(): string[] {
  const networks = os.networkInterfaces();
  const names = Object.keys(networks);
  const addresses: string[] = [];
  for (const name of names) {
    const entries = networks[name] ?? [];
    const entry = entries.find((candidate) => isIpv4Family(candidate.family));
    if (entry?.address) {
      addresses.push(entry.address);
    }
  }
  return addresses;
}

export class BonjourAdvertiser {
  private static readonly VISIBILITY_CHECK_DELAY_MS = 7_500;
  private static readonly VISIBILITY_CHECK_INTERVAL_MS = 15_000;
  private static readonly VISIBILITY_FAILURES_BEFORE_ISOLATION = 3;
  private readonly baseName: string;
  private readonly bonjourBindings: BonjourBinding[];
  private readonly port: number;
  private readonly txtProvider: () => Record<string, string>;
  private destroyed = false;
  private isolatedPublisher: ChildProcess | null = null;
  private republishAttempts = 0;
  private publishing = false;
  private restarting = false;
  private services: Service[] = [];
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
    this.bonjourBindings = options.bonjour
      ? [{ client: options.bonjour, destroyed: false, disabled: false, interfaceAddress: null }]
      : this.createBonjourBindings();
    this.port = options.port;
    this.serviceName = options.name;
    this.txtProvider = options.txtProvider;
  }

  start(): void {
    this.started = true;
    if (this.services.length > 0 || this.publishing) {
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
    await Promise.all(this.bonjourBindings.map((binding) => this.shutdownBonjourBinding(binding)));
    this.services = [];
  }

  private async restart(): Promise<void> {
    if (this.destroyed || this.activeBonjourBindings().length === 0) {
      return;
    }
    this.clearVisibilityTimer();
    await Promise.all(this.activeBonjourBindings().map((binding) => this.unpublishBonjourBinding(binding)));
    this.services = [];
    if (this.isolatedPublisher) {
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
    const services: Service[] = [];
    for (const binding of this.activeBonjourBindings()) {
      let service: Service;
      try {
        service = binding.client.publish({
          name,
          port: this.port,
          protocol: "tcp",
          txt: this.txtProvider(),
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
    this.services = services;
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
        console.warn("[surf-ace] bonjour publish failed:", error.message);
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
      `[surf-ace] bonjour multicast unavailable (${code}); disabling mDNS discovery for interface ${interfaceLabel} and falling back to IP discovery`,
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
    console.warn("[surf-ace] switching bonjour publishing to dns-sd");
    await Promise.all(this.activeBonjourBindings().map((binding) => this.unpublishBonjourBinding(binding)));
    this.services = [];
    await this.publishWithIsolatedPublisher(this.serviceName);
  }

  private async publishWithIsolatedPublisher(name: string): Promise<void> {
    this.stopIsolatedPublisher();
    this.serviceName = name;
    const txt = this.txtProvider();
    const txtArgs = Object.entries(txt).map(([k, v]) => `${k}=${v}`);
    const child = spawn(
      "dns-sd",
      ["-R", name, "_surf-ace._tcp", "local.", String(this.port), ...txtArgs],
      { stdio: ["ignore", "ignore", "ignore"] },
    );
    child.on("exit", (code) => {
      if (this.isolatedPublisher === child) {
        console.warn(`[surf-ace] dns-sd publisher exited (code=${code})`);
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
    child.kill();
  }
}
