import { execFile, spawn, type ChildProcess } from "node:child_process";
import os from "node:os";

import bonjourServiceModule, { type Service } from "bonjour-service";

type BonjourConstructor = typeof import("bonjour-service").Bonjour;
type BonjourServiceModule = { Bonjour?: BonjourConstructor; default?: BonjourConstructor };
const bonjourService = bonjourServiceModule as unknown as BonjourServiceModule;
const Bonjour: BonjourConstructor =
  bonjourService.Bonjour ?? bonjourService.default ?? (bonjourServiceModule as unknown as BonjourConstructor);

type BonjourError = Error & {
  code?: string;
};

type BonjourBrowser = {
  on(event: "up", listener: (service: BonjourDiscoveredService) => void): void;
  stop(): void;
};

type BonjourDiscoveredService = {
  name: string;
  port?: number;
  txt?: Record<string, unknown>;
};

type BonjourClient = {
  destroy(): void;
  find(
    options: { protocol: "tcp"; type: "surf-ace" },
    listener?: (service: BonjourDiscoveredService) => void,
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
type IsolatedPublisherProcessList = () => Promise<string>;
type IsolatedPublisherKill = (pid: number) => void;

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

async function defaultIsolatedPublisherProcessList(): Promise<string> {
  return await new Promise<string>((resolve) => {
    try {
      execFile("ps", ["-axo", "pid=,ppid=,command="], (error, stdout) => {
        resolve(error ? "" : stdout);
      });
    } catch {
      resolve("");
    }
  });
}

function bonjourBindingAddressesForPlatform(
  _platform: NodeJS.Platform,
  _networks: ReturnType<typeof os.networkInterfaces>,
): string[] {
  // multicast-dns already joins every IPv4 interface from one default socket.
  // Per-interface sockets can let one bad/non-LAN binding block the first
  // publish path before any service registration is attempted.
  return [];
}

function bonjourErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return (error as BonjourError).code ?? error.message;
  }
  return String(error);
}

function useIsolatedBonjourPublisherByDefault(platform: NodeJS.Platform): boolean {
  return platform === "darwin";
}

function bonjourInterfaceAddresses(): string[] {
  return bonjourBindingAddressesForPlatform(process.platform, os.networkInterfaces());
}

function isolatedPublisherCommandMatches(command: string, params: {
  name: string;
  port: number;
  publicKeyFingerprint: string;
}): boolean {
  const dnsSdIndex = command.indexOf("dns-sd -R ");
  if (dnsSdIndex < 0) {
    return false;
  }
  const commandAfterRegister = command.slice(dnsSdIndex + "dns-sd -R ".length);
  const serviceMarker = ` _surf-ace._tcp local. ${params.port}`;
  const serviceMarkerIndex = commandAfterRegister.indexOf(serviceMarker);
  if (serviceMarkerIndex < 0) {
    return false;
  }
  const advertisedName = commandAfterRegister.slice(0, serviceMarkerIndex).trim();
  if (advertisedName !== params.name) {
    return false;
  }
  const txtArgs = commandAfterRegister.slice(serviceMarkerIndex + serviceMarker.length).trim().split(/\s+/);
  const expectedPkArg = `pk=${params.publicKeyFingerprint.trim().toLowerCase()}`;
  return txtArgs.some((arg) => arg.trim().toLowerCase() === expectedPkArg);
}

export class BonjourAdvertiser {
  private static readonly VISIBILITY_CHECK_DELAY_MS = 7_500;
  private static readonly VISIBILITY_CHECK_INTERVAL_MS = 15_000;
  private static readonly VISIBILITY_FAILURES_BEFORE_ISOLATION = 3;
  private readonly baseName: string;
  private readonly bonjourBindings: BonjourBinding[];
  private readonly isolatedPublisherKill: IsolatedPublisherKill;
  private readonly isolatedPublisherProcessList: IsolatedPublisherProcessList;
  private readonly isolatedPublisherSpawn: typeof spawn;
  private readonly platform: NodeJS.Platform;
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
    isolatedPublisherKill?: IsolatedPublisherKill;
    isolatedPublisherProcessList?: IsolatedPublisherProcessList;
    isolatedPublisherSpawn?: typeof spawn;
    name: string;
    platform?: NodeJS.Platform;
    port: number;
    txtProvider: () => Record<string, string>;
  }) {
    this.baseName = options.name;
    this.bonjourBindings = options.bonjour
      ? [{ client: options.bonjour, destroyed: false, disabled: false, interfaceAddress: null }]
      : this.createBonjourBindings();
    this.isolatedPublisherKill = options.isolatedPublisherKill ?? ((pid) => process.kill(pid, "TERM"));
    this.isolatedPublisherProcessList = options.isolatedPublisherProcessList ?? defaultIsolatedPublisherProcessList;
    this.isolatedPublisherSpawn = options.isolatedPublisherSpawn ?? spawn;
    this.platform = options.platform ?? process.platform;
    this.port = options.port;
    this.serviceName = options.name;
    this.txtProvider = options.txtProvider;
    this.useIsolatedPublisherByDefault = !options.bonjour && useIsolatedBonjourPublisherByDefault(this.platform);
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
      this.publish(preferredName);
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
          probe: false,
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
    const activeServices = await this.discoverPublishedServices();
    if (this.destroyed || (this.services.length === 0 && !this.isolatedPublisher) || this.restarting || this.serviceName !== publishedName) {
      return;
    }
    const txt = this.txtProvider();
    const matchingOwnServices = activeServices.filter((service) => this.matchesAdvertisedIdentity(service, publishedName, txt));
    const matchingOwnService = matchingOwnServices.length > 0;
    const sameNameServices = activeServices.filter((service) => service.name === publishedName);
    if (!this.isolatedPublisher && matchingOwnService && sameNameServices.length > matchingOwnServices.length) {
      this.visibilityFailures += 1;
      console.warn(
        bonjourDiagnostic("publish_name_conflict", {
          discovered_count: activeServices.length,
          failure_count: this.visibilityFailures,
          name: publishedName,
          own_name_count: matchingOwnServices.length,
          same_name_count: sameNameServices.length,
        }),
      );
      await this.republishWithFallbackName();
      return;
    }
    if (!matchingOwnService) {
      this.visibilityFailures += 1;
      console.warn(
        bonjourDiagnostic("publish_not_visible", {
          discovered_count: activeServices.length,
          failure_count: this.visibilityFailures,
          name: publishedName,
          same_name_count: sameNameServices.length,
        }),
      );
      if (!this.isolatedPublisher && sameNameServices.length > 0) {
        await this.republishWithFallbackName();
        return;
      }
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
        discovered_count: activeServices.length,
        name: publishedName,
      }),
    );
    this.scheduleVisibilityCheck(BonjourAdvertiser.VISIBILITY_CHECK_INTERVAL_MS);
  }

  private matchesAdvertisedIdentity(
    service: BonjourDiscoveredService,
    publishedName: string,
    txt: Record<string, string>,
  ): boolean {
    return service.name === publishedName &&
      service.port === this.port &&
      String(service.txt?.pk ?? "").trim().toLowerCase() === String(txt.pk ?? "").trim().toLowerCase();
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

  private async discoverPublishedServices(): Promise<BonjourDiscoveredService[]> {
    const services: BonjourDiscoveredService[] = [];
    const browsers: BonjourBrowser[] = [];
    console.info(
      bonjourDiagnostic("publish_discover_begin", {
        binding_count: this.activeBonjourBindings().length,
      }),
    );
    for (const binding of this.activeBonjourBindings()) {
      try {
        const browser = binding.client.find(
          {
            protocol: "tcp",
            type: "surf-ace",
          },
          (service) => {
            services.push(service);
          },
        );
        browser.on("txt-update", (service: BonjourDiscoveredService) => {
          services.push(service);
        });
        browsers.push(browser);
      } catch (error) {
        console.warn(
          bonjourDiagnostic("publish_discover_error", {
            error: bonjourErrorMessage(error),
            interface: binding.interfaceAddress ?? "default",
          }),
        );
        this.handleBonjourError(error, binding);
      }
    }
    if (browsers.length === 0) {
      console.info(
        bonjourDiagnostic("publish_discover_end", {
          discovered_count: services.length,
        }),
      );
      return services;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 750);
    });
    for (const browser of browsers) {
      browser.stop();
    }
    console.info(
      bonjourDiagnostic("publish_discover_end", {
        discovered_count: services.length,
      }),
    );
    return services;
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
    const code = bonjourErrorMessage(error);
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
    if (this.platform !== "darwin") {
      return;
    }
    const publicKeyFingerprint = this.txtProvider().pk?.trim().toLowerCase();
    if (!publicKeyFingerprint) {
      return;
    }
    const currentPid = this.isolatedPublisher?.pid ?? null;
    const rows = await this.isolatedPublisherProcessList();
    for (const row of rows.split(/\r?\n/)) {
      const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(row);
      if (!match) {
        continue;
      }
      const pid = Number(match[1]);
      const parentPid = Number(match[2]);
      const command = match[3] ?? "";
      if (
        pid === currentPid ||
        parentPid !== 1 ||
        !isolatedPublisherCommandMatches(command, {
          name,
          port: this.port,
          publicKeyFingerprint,
        })
      ) {
        continue;
      }
      try {
        this.isolatedPublisherKill(pid);
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
  isolatedPublisherCommandMatches,
  useIsolatedBonjourPublisherByDefault,
};
