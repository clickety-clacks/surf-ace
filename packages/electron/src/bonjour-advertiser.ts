import { Bonjour, type Service } from "bonjour-service";

export class BonjourAdvertiser {
  private readonly bonjour = new Bonjour();
  private readonly name: string;
  private readonly port: number;
  private readonly txtProvider: () => Record<string, string>;
  private service: Service | null = null;

  constructor(options: {
    name: string;
    port: number;
    txtProvider: () => Record<string, string>;
  }) {
    this.name = options.name;
    this.port = options.port;
    this.txtProvider = options.txtProvider;
  }

  start(): void {
    if (this.service) {
      return;
    }
    this.service = this.bonjour.publish({
      name: this.name,
      port: this.port,
      protocol: "tcp",
      txt: this.txtProvider(),
      type: "surf-ace",
    });
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
    this.service = this.bonjour.publish({
      name: this.name,
      port: this.port,
      protocol: "tcp",
      txt: this.txtProvider(),
      type: "surf-ace",
    });
  }
}
