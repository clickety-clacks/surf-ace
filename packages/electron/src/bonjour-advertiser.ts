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
  private readonly baseName: string;
  private readonly bonjour: BonjourClient;
  private readonly port: number;
  private readonly txtProvider: () => Record<string, string>;
  private republishAttempts = 0;
  private publishing = false;
  private restarting = false;
  private service: Service | null = null;
  private serviceName: string;

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
    if (this.service || this.publishing) {
      return;
    }
    void this.publishNextAvailableName(this.serviceName);
  }

  refresh(): void {
    if (!this.service) {
      return;
    }
    void this.restart();
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.bonjour.unpublishAll(() => resolve());
    });
    this.bonjour.destroy();
    this.service = null;
  }

  private async restart(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.bonjour.unpublishAll(() => resolve());
    });
    this.service = null;
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
    const service = this.bonjour.publish({
      name,
      port: this.port,
      probe: false,
      protocol: "tcp",
      txt: this.txtProvider(),
      type: "surf-ace",
    });
    this.serviceName = name;
    this.service = service;
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
}
