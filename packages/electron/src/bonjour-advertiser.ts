import { Bonjour, type Service } from "bonjour-service";

export class BonjourAdvertiser {
  private readonly bonjour = new Bonjour();
  private readonly baseName: string;
  private readonly port: number;
  private readonly txtProvider: () => Record<string, string>;
  private republishAttempts = 0;
  private restarting = false;
  private service: Service | null = null;
  private serviceName: string;

  constructor(options: {
    name: string;
    port: number;
    txtProvider: () => Record<string, string>;
  }) {
    this.baseName = options.name;
    this.port = options.port;
    this.serviceName = options.name;
    this.txtProvider = options.txtProvider;
  }

  start(): void {
    if (this.service) {
      return;
    }
    this.publish(this.serviceName);
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
    this.publish(this.serviceName);
  }

  private publish(name: string): void {
    const service = this.bonjour.publish({
      name,
      port: this.port,
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
      await this.restart();
    } finally {
      this.restarting = false;
    }
  }
}
